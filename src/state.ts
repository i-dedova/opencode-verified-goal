// Goal state: the record model and the ctx.storage-backed store (R-029 family).
// Persistence is ctx.storage under three key shapes:
//   goal:<sessionID>:current  — pointer to the live goal id, or absent
//   goal:<sessionID>:g<NNNN>  — one record per goal, zero-padded per-session
//   goal:<sessionID>:seq      — id allocation high-water, never removed by
//                               /goal clear (R-029), only by the R-030 sweep
// The host namespaces these as plugin:<hex(i-dedova.verified-goal)>: and the plugin never
// writes that prefix itself (R-029).
//
// ponytail: ceiling: ctx.storage keys embed the plugin id, so renaming the plugin orphans every goal record; upgrade when: a storage API supporting key migration or a separate store exists
// ponytail: ceiling: goal records accumulate without bound because ctx.storage has no quota, no TTL, no row cap, and no eviction anywhere in the host; upgrade when: storage exposes a size limit, retention setting, or per-plugin namespace. Adding retention later would retroactively delete records this spec promises are permanent, so it is a breaking change and not a tuning knob.

import { log, logWarn } from "./log.ts";

/**
 * The fixed plugin constants (Target State, "Plugin constants"). The list grew
 * past the spec's original six: `verifier_refusal_limit` and
 * `objective_min_chars` are pending spec deltas.
 */
export const PLUGIN_CONSTANTS = Object.freeze({
  min_continue_interval_ms: 3000,
  verifier_timeout_ms: 120000,
  max_asset_bytes: 600000,
  lock_acquire_timeout_ms: 2000,
  no_progress_limit: 3,
  submit_failure_limit: 3,
  /** Consecutive verifier refusals that stop the loop (operator direction). */
  verifier_refusal_limit: 2,
  /**
   * Absolute floor for an objective after trimming (operator direction). A goal
   * must be a task statement, so `objectiveValid` additionally requires either 8
   * characters or a space - `fix bug` passes, a bare word like `cleanup` does not.
   */
  objective_min_chars: 4,
});

export const RECORD_VERSION = 1;
export const PLUGIN_ID = "i-dedova.verified-goal";

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export type StopReason =
  | "max_turns"
  | "max_tokens"
  | "no-progress"
  | "execution-failed"
  | "user"
  | "submit-failed"
  | "state-write-failed"
  | "verifier-refused";

export type VerifyProfile = "spec-backed" | "ad-hoc";

/** The reason codes of Target State, "Reason codes". */
export type ReasonCode =
  | "illegal-transition"
  | "evidence-required"
  | "evidence-unreadable"
  | "evidence-outside-allowed-roots"
  | "objective-invalid"
  | "budget-invalid"
  | "blocked-reason-required"
  | "transition-in-flight"
  | "foreign-writer"
  | "state-locked"
  | "verifier-timeout"
  | "verifier-unparseable"
  | "verifier-rejected"
  | "evidence-vanished"
  | "verifier-error";

export class GoalError extends Error {
  readonly code: ReasonCode;
  readonly detail: string;
  constructor(code: ReasonCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "GoalError";
    this.code = code;
    this.detail = detail;
  }
}

/** A ctx.storage write that failed; drives R-031's state-write-failed stop. */
export class StorageWriteError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`storage ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StorageWriteError";
  }
}

/**
 * The goal record. `goal_id` identifies the goal across time (R-029e);
 * `writer_pid` is the owning server process and gates acting as well as
 * writing (R-029b, R-043). `active` marks this record as the session's live
 * goal (R-041's first sense of the word).
 */
export interface GoalRecord {
  record_version: number;
  goal_id: string;
  writer_pid: number;
  objective: string;
  status: GoalStatus;
  active: boolean;
  continuing: boolean;
  stop_reason: StopReason | null;
  verify_profile: VerifyProfile | null;
  blocked_reason: string | null;
  max_turns: number | null;
  max_tokens: number | null;
  tokens_baseline: number;
  tokens_used: number;
  time_used_seconds: number;
  turns_used: number;
  no_progress_turns: number;
  blocked_count: number;
  /** Consecutive verifier refusals; reset by an approved transition or a re-arm. */
  refusal_count: number;
  /** The last refusal, verbatim (`<code>: <detail>`), so the operator can act. */
  refusal_reason: string | null;
  created_at: number;
  updated_at: number;
}

/** The storage surface the plugin consumes; ctx.storage matches it exactly. */
export interface StoragePort {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(options: {
    prefix: string;
    after?: string;
    limit?: number;
  }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }>; next?: string }>;
}

export interface StateDeps {
  storage: StoragePort;
  /** Current server process id; injectable for tests. */
  pid: number;
  now?: () => number;
}

export function currentKey(sessionID: string): string {
  return `goal:${sessionID}:current`;
}

export function recordKey(sessionID: string, goalID: string): string {
  return `goal:${sessionID}:${goalID}`;
}

export function seqKey(sessionID: string): string {
  return `goal:${sessionID}:seq`;
}

/** A goal's reusable reviewer session. */
export interface ReviewerRef {
  goal_id: string;
  session_id: string;
  /** Fingerprint of the assets the reviewer's context reflects. */
  fingerprint: string;
}

export function reviewerKey(sessionID: string): string {
  return `goal:${sessionID}:reviewer`;
}

function isRecordShape(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return -1;
  }
}

const STATUSES: GoalStatus[] = ["active", "paused", "blocked", "complete"];
const STOP_REASONS: StopReason[] = [
  "max_turns",
  "max_tokens",
  "no-progress",
  "execution-failed",
  "user",
  "submit-failed",
  "state-write-failed",
  "verifier-refused",
];

function decodeRecord(value: unknown, key: string, expectedGoalId?: string): GoalRecord | null {
  if (!isRecordShape(value)) {
    logWarn(`malformed value key=${key} error=not-an-object bytes=${byteLength(value)}`);
    return null;
  }
  if (value.record_version !== RECORD_VERSION) {
    logWarn(
      `version mismatch key=${key} version=${String(value.record_version)} bytes=${byteLength(value)}`,
    );
    return null;
  }
  const status = value.status as GoalStatus;
  if (!STATUSES.includes(status)) {
    logWarn(`malformed value key=${key} error=bad-status bytes=${byteLength(value)}`);
    return null;
  }
  if (typeof value.goal_id !== "string" || typeof value.objective !== "string") {
    logWarn(`malformed value key=${key} error=missing-fields bytes=${byteLength(value)}`);
    return null;
  }
  if (expectedGoalId !== undefined && value.goal_id !== expectedGoalId) {
    logWarn(`malformed value key=${key} error=goal-id-mismatch bytes=${byteLength(value)}`);
    return null;
  }
  if (value.stop_reason !== null && value.stop_reason !== undefined && !STOP_REASONS.includes(value.stop_reason as StopReason)) {
    // A corrupt stop_reason must not read as a merely non-continuing record
    // that could be re-driven (Scope B review finding 13).
    logWarn(`malformed value key=${key} error=bad-stop-reason bytes=${byteLength(value)}`);
    return null;
  }
  const stopReason =
    value.stop_reason === null || value.stop_reason === undefined
      ? null
      : (value.stop_reason as StopReason);
  const record: GoalRecord = {
    record_version: RECORD_VERSION,
    goal_id: value.goal_id,
    writer_pid: typeof value.writer_pid === "number" ? value.writer_pid : 0,
    objective: value.objective,
    status,
    active: value.active === true,
    continuing: value.continuing === true,
    stop_reason: stopReason,
    verify_profile:
      value.verify_profile === "spec-backed" || value.verify_profile === "ad-hoc"
        ? value.verify_profile
        : null,
    blocked_reason: typeof value.blocked_reason === "string" ? value.blocked_reason : null,
    max_turns: typeof value.max_turns === "number" ? value.max_turns : null,
    max_tokens: typeof value.max_tokens === "number" ? value.max_tokens : null,
    tokens_baseline: typeof value.tokens_baseline === "number" ? value.tokens_baseline : 0,
    tokens_used: typeof value.tokens_used === "number" ? value.tokens_used : 0,
    time_used_seconds: typeof value.time_used_seconds === "number" ? value.time_used_seconds : 0,
    turns_used: typeof value.turns_used === "number" ? value.turns_used : 0,
    no_progress_turns: typeof value.no_progress_turns === "number" ? value.no_progress_turns : 0,
    blocked_count: typeof value.blocked_count === "number" ? value.blocked_count : 0,
    refusal_count: typeof value.refusal_count === "number" ? value.refusal_count : 0,
    refusal_reason: typeof value.refusal_reason === "string" ? value.refusal_reason : null,
    created_at: typeof value.created_at === "number" ? value.created_at : 0,
    updated_at: typeof value.updated_at === "number" ? value.updated_at : 0,
  };
  return record;
}

/** pid liveness (R-044d): dead only on a "no such process" outcome. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code !== "ESRCH";
  }
}

export interface CurrentRead {
  record: GoalRecord | null;
  goalId: string | null;
}

export class GoalStore {
  private readonly storage: StoragePort;
  private readonly pid: number;
  private readonly now: () => number;

  constructor(deps: StateDeps) {
    this.storage = deps.storage;
    this.pid = deps.pid;
    this.now = deps.now ?? (() => Date.now());
  }

  get writerPid(): number {
    return this.pid;
  }

  /** Pure read (no mutex): the live goal, R-030 recovery included. */
  async current(sessionID: string): Promise<CurrentRead> {
    const pointer = await this.read(currentKey(sessionID));
    if (typeof pointer !== "string" || pointer.length === 0) {
      if (pointer !== undefined && pointer !== null) {
        logWarn(`malformed pointer key=${currentKey(sessionID)} bytes=${byteLength(pointer)}`);
      }
      return { record: null, goalId: null };
    }
    const value = await this.read(recordKey(sessionID, pointer));
    if (value === undefined || value === null) {
      logWarn(`dangling pointer key=${currentKey(sessionID)} -> ${pointer}`);
      return { record: null, goalId: null };
    }
    const record = decodeRecord(value, recordKey(sessionID, pointer), pointer);
    if (!record) return { record: null, goalId: null };
    if (record.status === "complete" || record.active !== true) {
      // A pointer to a closed record is stale bookkeeping, not a live goal.
      return { record: null, goalId: null };
    }
    return { record, goalId: record.goal_id };
  }

  /** A read that treats a storage decode failure as a malformed value. */
  private async read(key: string): Promise<unknown> {
    try {
      return await this.storage.get(key);
    } catch (error) {
      logWarn(`unreadable value key=${key} error=${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Pure read of one record by id, decoded with R-030 recovery. */
  async readGoal(sessionID: string, goalID: string): Promise<GoalRecord | null> {
    const value = await this.read(recordKey(sessionID, goalID));
    if (value === undefined || value === null) return null;
    return decodeRecord(value, recordKey(sessionID, goalID), goalID);
  }

  /** Pure read: every retained record for the session, creation order. */
  async listGoals(sessionID: string): Promise<GoalRecord[]> {
    const entries = await this.scanAll(`goal:${sessionID}:`);
    const goals: GoalRecord[] = [];
    for (const entry of entries) {
      const suffix = entry.key.slice(`goal:${sessionID}:`.length);
      if (!suffix.startsWith("g")) continue;
      const record = decodeRecord(entry.value, entry.key, suffix);
      if (record) goals.push(record);
    }
    // Key order equals creation order only up to g9999 (R-029), so sort.
    goals.sort((a, b) => a.created_at - b.created_at || a.goal_id.localeCompare(b.goal_id));
    return goals;
  }

  /** All `:current` pointers, for R-040 reconciliation. */
  async listCurrentPointers(): Promise<string[]> {
    const entries = await this.scanAll("goal:");
    const sessionIDs: string[] = [];
    for (const entry of entries) {
      const parts = entry.key.split(":");
      if (parts.length === 3 && parts[0] === "goal" && parts[2] === "current") {
        if (typeof entry.value === "string" && entry.value.length > 0) sessionIDs.push(parts[1]);
      }
    }
    return sessionIDs;
  }

  /** All session ids with any stored goal key, for the setup sweep (R-030). */
  async listStoredSessions(): Promise<string[]> {
    const entries = await this.scanAll("goal:");
    const seen = new Set<string>();
    for (const entry of entries) {
      const parts = entry.key.split(":");
      if (parts.length === 3 && parts[0] === "goal") seen.add(parts[1]);
    }
    return [...seen];
  }

  async allocateGoalId(sessionID: string): Promise<string> {
    const raw = await this.storage.get(seqKey(sessionID));
    const previous = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
    const next = previous + 1;
    // Written before the record it authorises; the high-water mark deliberately
    // outlives /goal clear so ids are never reused (R-029).
    await this.write(seqKey(sessionID), next);
    return `g${String(next).padStart(4, "0")}`;
  }

  /** Writes are wrapped so R-031 can distinguish a storage failure. */
  private async write(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.set(key, value);
    } catch (error) {
      throw new StorageWriteError(`set ${key}`, error);
    }
  }

  private async drop(key: string): Promise<void> {
    try {
      await this.storage.remove(key);
    } catch (error) {
      throw new StorageWriteError(`remove ${key}`, error);
    }
  }

  /** Persists a record. updated_at is always refreshed here. */
  async writeRecord(sessionID: string, record: GoalRecord): Promise<void> {
    const value: GoalRecord = { ...record, updated_at: this.now() };
    await this.write(recordKey(sessionID, record.goal_id), value);
    Object.assign(record, value);
  }

  async writeCurrent(sessionID: string, goalID: string): Promise<void> {
    await this.write(currentKey(sessionID), goalID);
  }

  async clearCurrent(sessionID: string): Promise<void> {
    await this.drop(currentKey(sessionID));
  }

  async removeRecord(sessionID: string, goalID: string): Promise<void> {
    await this.drop(recordKey(sessionID, goalID));
  }

  /**
   * The goal's reviewer session reference. Durable so a restarted plugin
   * resumes the same reviewer instead of leaking a fresh one; the goal id and
   * asset fingerprint in the value decide whether the reference is still valid.
   * Removed with the goal's other keys (R-030 prefix sweep).
   */
  async readReviewer(sessionID: string): Promise<ReviewerRef | null> {
    const value = await this.storage.get(reviewerKey(sessionID));
    if (!isRecordShape(value)) return null;
    if (
      typeof value.goal_id !== "string" ||
      typeof value.session_id !== "string" ||
      typeof value.fingerprint !== "string"
    ) {
      logWarn(`malformed reviewer reference key=${reviewerKey(sessionID)}`);
      return null;
    }
    return { goal_id: value.goal_id, session_id: value.session_id, fingerprint: value.fingerprint };
  }

  async writeReviewer(sessionID: string, reference: ReviewerRef): Promise<void> {
    await this.write(reviewerKey(sessionID), reference);
  }

  async removeReviewer(sessionID: string): Promise<void> {
    await this.drop(reviewerKey(sessionID));
  }

  /** True when a different *live* process owns the record (R-029b). */
  isForeign(record: GoalRecord): boolean {
    return (
      record.writer_pid > 0 && record.writer_pid !== this.pid && pidAlive(record.writer_pid)
    );
  }

  /**
   * Refuses with foreign-writer when a different live process owns the record.
   * Called under the session mutex, before any write or drive.
   */
  assertWritable(record: GoalRecord): void {
    if (this.isForeign(record)) {
      throw new GoalError("foreign-writer", `writer_pid ${record.writer_pid}`);
    }
  }

  /**
   * Dead-owner takeover (R-043): recorded before the plugin writes or drives.
   * The caller holds the session mutex where one is available.
   */
  claim(record: GoalRecord): void {
    if (record.writer_pid !== this.pid) {
      record.writer_pid = this.pid;
    }
  }

  /**
   * R-030 sweep for one session: every key, paginated, via prefix scan.
   */
  // ponytail: ceiling: session garbage collection is a plugin sweep, not a schema-level ON DELETE CASCADE; upgrade when: storage supports per-session namespaces or expiry
  async sweepSession(sessionID: string): Promise<number> {
    const prefix = `goal:${sessionID}:`;
    let removed = 0;
    let after: string | undefined;
    for (let round = 0; round < 1000; round += 1) {
      const page = await this.storage.scan({ prefix, after, limit: 200 });
      if (page.entries.length === 0) break;
      for (const entry of page.entries) {
        await this.drop(entry.key);
        removed += 1;
      }
      if (!page.next) break;
      after = page.next;
    }
    return removed;
  }

  async scanAll(prefix: string): Promise<ReadonlyArray<{ key: string; value: unknown }>> {
    const all: Array<{ key: string; value: unknown }> = [];
    let after: string | undefined;
    for (;;) {
      const page: { entries: ReadonlyArray<{ key: string; value: unknown }>; next?: string } =
        await this.storage.scan({ prefix, after, limit: 500 });
      all.push(...page.entries);
      if (!page.next || page.entries.length === 0) break;
      after = page.next;
    }
    return all;
  }
}
