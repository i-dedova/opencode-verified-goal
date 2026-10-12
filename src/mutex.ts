// The owned SQLite session mutex (R-044 family).
//
// ctx.storage exposes no conditional write, and no user-space lock *file* can
// be race-free (D-052: a grace-windowed unlink takeover cannot establish
// mutual exclusion). SQLite's own primitives make all three operations atomic:
// acquisition is an INSERT, release is `DELETE WHERE session_id = ? AND
// token = ?`, and takeover is a conditional delete of an observed dead
// holder's row. The database is one the plugin owns at
// <data home>/opencode/opencode-verified-goal/lock.db, holding one row per session:
// session_id, owner_pid, hostname, token, acquired_at — never goal content.
//
// One mutex instance exists per process (module singleton), so plugin
// instances across locations share the in-process queue as well as the row.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { GoalError, pidAlive, PLUGIN_CONSTANTS } from "./state.ts";
import { log, logDebug, logWarn } from "./log.ts";

export interface MutexOptions {
  dbPath?: string;
  pid?: number;
  acquireTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close?: () => void;
}

interface SqliteBinding {
  kind: "bun" | "node";
  open(path: string): SqliteDatabase;
}

async function loadSqliteBinding(): Promise<SqliteBinding> {
  try {
    const bun = (await import("bun:sqlite")) as {
      Database: new (path: string) => SqliteDatabase & { run(sql: string): void };
    };
    return {
      kind: "bun",
      open: (path) => new bun.Database(path),
    };
  } catch {
    // Node fallback: node:sqlite (Node >= 22.5, experimental; used by tests).
  }
  const node = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  return {
    kind: "node",
    open: (path) => new node.DatabaseSync(path),
  };
}

/** Data home convention shared with the host's own data root (R-044). */
export function resolveDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME;
  if (typeof xdg === "string" && xdg.trim().length > 0) return xdg;
  return join(homedir(), ".local", "share");
}

export function defaultLockDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDataHome(env), "opencode", "opencode-verified-goal", "lock.db");
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS session_locks (
  session_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  hostname TEXT NOT NULL,
  token TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
)`;

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|constraint failed: session_locks/i.test(message);
}

function normalizeRow(raw: unknown): { owner_pid: number; token: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const owner = Number(row.owner_pid);
  const token = row.token;
  if (!Number.isInteger(owner) || typeof token !== "string") return null;
  return { owner_pid: owner, token };
}

/**
 * The process-wide session mutex. `withLock` serializes in-process callers
 * through a per-session promise chain and cross-process callers through the
 * SQLite row. A held mutex past the acquire budget raises state-locked; an
 * unavailable binding or database degrades to the R-029b detection floor with
 * one log line (R-044d).
 */
export class SessionMutex {
  private readonly dbPath: string;
  private readonly pid: number;
  private readonly acquireTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly token: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private db: SqliteDatabase | null = null;
  private opening: Promise<SqliteDatabase | null> | null = null;
  private degraded = false;

  constructor(options: MutexOptions = {}) {
    this.dbPath = options.dbPath ?? defaultLockDbPath();
    this.pid = options.pid ?? process.pid;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? PLUGIN_CONSTANTS.lock_acquire_timeout_ms;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.token = randomUUID();
  }

  private async open(): Promise<SqliteDatabase | null> {
    if (this.db !== null) return this.db;
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        const binding = await loadSqliteBinding();
        mkdirSync(dirname(this.dbPath), { recursive: true });
        const db = binding.open(this.dbPath);
        if (binding.kind === "bun") {
          (db as unknown as { run(sql: string): void }).run("PRAGMA journal_mode = WAL");
          (db as unknown as { run(sql: string): void }).run("PRAGMA busy_timeout = 5000");
          (db as unknown as { run(sql: string): void }).run(TABLE_SQL);
        } else {
          db.exec("PRAGMA journal_mode = WAL");
          db.exec("PRAGMA busy_timeout = 5000");
          db.exec(TABLE_SQL);
        }
        this.db = db;
        return db;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.degraded) {
          this.degraded = true;
          logWarn(`mutex unavailable (${message}); degrading to single-writer detection`);
        }
        return null;
      }
    })();
    return this.opening;
  }

  /** Acquisition: atomic INSERT with bounded backoff (R-044a). */
  private async acquireRow(sessionID: string): Promise<void> {
    const db = await this.open();
    if (!db) return; // degraded: proceed without exclusion (R-044d)
    const insert = db.prepare(
      "INSERT INTO session_locks (session_id, owner_pid, hostname, token, acquired_at) VALUES (?, ?, ?, ?, ?)",
    );
    const select = db.prepare("SELECT owner_pid, token FROM session_locks WHERE session_id = ?");
    const conditionalDelete = db.prepare("DELETE FROM session_locks WHERE session_id = ? AND token = ?");
    const deadline = this.now() + this.acquireTimeoutMs;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        insert.run(sessionID, this.pid, hostname(), this.token, this.now());
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          logWarn(`mutex insert failed (${error instanceof Error ? error.message : String(error)})`);
          return; // fail open to the detection floor rather than bricking
        }
      }
      const holder = normalizeRow(select.get(sessionID));
      if (holder && (holder.owner_pid === this.pid || !pidAlive(holder.owner_pid))) {
        // Conditional delete of the observed holder; zero rows means another
        // contender won, which is not ownership — retry the acquisition.
        conditionalDelete.run(sessionID, holder.token);
        continue;
      }
      if (this.now() >= deadline) {
        throw new GoalError(
          "state-locked",
          `session ${sessionID} held by pid ${holder?.owner_pid ?? "unknown"} after ${attempt} attempts`,
        );
      }
      await this.sleep(Math.min(50 + attempt * 25, 250));
    }
  }

  /** Release: token-scoped delete; zero rows is normal, never failure. */
  private async releaseRow(sessionID: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      db.prepare("DELETE FROM session_locks WHERE session_id = ? AND token = ?").run(
        sessionID,
        this.token,
      );
    } catch (error) {
      logWarn(`mutex release failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** R-030 sweep support: remove a deleted session's row unconditionally. */
  async deleteRow(sessionID: string): Promise<void> {
    const db = await this.open();
    if (!db) return;
    try {
      db.prepare("DELETE FROM session_locks WHERE session_id = ?").run(sessionID);
    } catch (error) {
      logWarn(`mutex row delete failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * Runs fn under the session lock. The mutex MUST NOT be held across the
   * min_continue_interval_ms delay, a verifier round-trip, or a handoff
   * dispatch's settlement (R-044c); callers scope fn to the read-decide-write.
   */
  async withLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(sessionID) ?? Promise.resolve();
    const run = prior.then(async () => {
      await this.acquireRow(sessionID);
      try {
        return await fn();
      } finally {
        await this.releaseRow(sessionID);
      }
    });
    const tail = run.catch(() => undefined);
    this.queues.set(sessionID, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(sessionID) === tail) this.queues.delete(sessionID);
      logDebug(`mutex released session=${sessionID}`);
    }
  }

  close(): void {
    try {
      this.db?.close?.();
    } catch {
      // ignore
    }
    this.db = null;
  }
}

let processMutex: SessionMutex | null = null;

/** The process-wide instance; all plugin instances share it (R-014: per process). */
export function sessionMutex(options?: MutexOptions): SessionMutex {
  if (!processMutex) processMutex = new SessionMutex(options);
  return processMutex;
}

export function resetSessionMutexForTests(): void {
  processMutex?.close();
  processMutex = null;
  log("mutex singleton reset (test seam)");
}
