// Shared test fixtures for the I23/T1 goal-plugin suites. Every suite runs
// against an in-memory ctx.storage double and a synthetic event source; no
// test opens the live opencode.db (R-033).

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// -------------------------------------------------------------- module loader

export function pluginRoot(): string {
  const env = process.env.ESTATE_GOAL_DIR;
  if (env && env.length > 0) return env;
  return join(homedir(), ".config", "opencode", "plugins", "estate-goal");
}

export async function loadPlugin<T = any>(relative: string): Promise<T> {
  return (await import(pathToFileURL(join(pluginRoot(), "src", relative)).href)) as T;
}

export function pluginServer(): Promise<any> {
  return loadPlugin("server.ts");
}

// ------------------------------------------------------------------- storage

type ScanOptions = { prefix: string; after?: string; limit?: number };

export class MemoryStorage {
  private map = new Map<string, string>();
  failWrites = false;

  raw(key: string): unknown {
    const value = this.map.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  seed(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }

  seedRaw(key: string, raw: string): void {
    this.map.set(key, raw);
  }

  keys(): string[] {
    return [...this.map.keys()].sort();
  }

  async get(key: string): Promise<unknown> {
    const value = this.map.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error("storage write failed (injected)");
    this.map.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async scan(options: ScanOptions): Promise<{ entries: Array<{ key: string; value: unknown }>; next?: string }> {
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000);
    const keys = [...this.map.keys()]
      .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
      .sort();
    const page = keys.slice(0, limit);
    const entries = page.map((key) => ({ key, value: JSON.parse(this.map.get(key) as string) }));
    if (keys.length > limit) return { entries, next: page[page.length - 1] };
    return { entries };
  }
}

// ----------------------------------------------------------------- scheduler

interface ScheduledTask {
  id: number;
  at: number;
  fn: () => void;
}

export class ManualScheduler {
  now = 0;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.tasks.push({ id, at: this.now + Math.max(0, ms), fn });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.tasks = this.tasks.filter((task) => task.id !== handle);
  };

  pending(): number {
    return this.tasks.length;
  }

  /** Runs every task due within `ms` of virtual time, in time order. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = this.tasks.filter((task) => task.at <= target).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0];
      this.tasks = this.tasks.filter((task) => task.id !== next.id);
      this.now = next.at;
      next.fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

/** Drains microtasks so fire-and-forget async work (dispatch) completes. */
export async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ------------------------------------------------------------------- session

export class FakeSession {
  prompts: Array<{ sessionID: string; text: string; delivery?: string; description?: string }> = [];
  sessions = new Map<string, { agent?: string }>();
  failPromptsRemaining = 0;

  constructor() {
    this.sessions.set("ses_test", { agent: "homewide" });
  }

  async prompt(input: { sessionID: string; text: string; delivery?: string }): Promise<unknown> {
    if (this.failPromptsRemaining > 0) {
      this.failPromptsRemaining -= 1;
      throw new Error("prompt admission rejected (injected)");
    }
    this.prompts.push({ sessionID: input.sessionID, text: input.text, delivery: input.delivery });
    return { id: "msg_inbox", sessionID: input.sessionID, type: "user" };
  }

  /** The continuation channel: recorded beside prompts so count/last assertions hold. */
  async synthetic(input: { sessionID: string; text: string; description: string; delivery?: string }): Promise<unknown> {
    if (this.failPromptsRemaining > 0) {
      this.failPromptsRemaining -= 1;
      throw new Error("synthetic admission rejected (injected)");
    }
    this.prompts.push({
      sessionID: input.sessionID,
      text: input.text,
      delivery: input.delivery,
      description: input.description,
    });
    return { id: "msg_synthetic", sessionID: input.sessionID, type: "synthetic" };
  }

  async get(input: { sessionID: string }): Promise<{ id: string; agent?: string }> {
    const session = this.sessions.get(input.sessionID);
    if (!session) throw new Error("SessionNotFoundError: session not found");
    return { id: input.sessionID, agent: session.agent };
  }

  lastPrompt(sessionID: string): { sessionID: string; text: string } | undefined {
    return [...this.prompts].reverse().find((prompt) => prompt.sessionID === sessionID);
  }

  promptCount(sessionID: string): number {
    return this.prompts.filter((prompt) => prompt.sessionID === sessionID).length;
  }
}

// ------------------------------------------------------------------- context

export class FakeCtx {
  synthetics: Array<{ sessionID: string; description: string | undefined; text: string; resume: unknown; raw: any }> = [];
  titles = new Map<string, string>();
  tools = new Map<string, any>();
  commands = new Map<string, any>();
  hooks = new Map<string, (input: any) => unknown>();
  created: string[] = [];
  switched: Array<{ sessionID: string; agent: string }> = [];
  switchedModels: Array<{ sessionID: string; model: any }> = [];
  compactions: Array<{ sessionID: string }> = [];
  interrupted: Array<{ sessionID: string; resume?: boolean }> = [];
  reviewerPrompts: Array<{ sessionID: string; text: string; resume?: unknown }> = [];
  removed: string[] = [];
  /** The lane model `agent.get` reports; null models a lane without a pin. */
  laneModel: any = { providerID: "opencode-go", id: "grok-4.7", variant: "xhigh" };
  session;
  agent;
  tool;
  command;
  event;
  storage = new MemoryStorage();
  location = { directory: process.env.TEST_SESSION_DIR ?? process.cwd() };

  constructor() {
    this.session = {
      synthetic: async (input: { sessionID: string; text: string; description?: string; resume?: unknown }) => {
        this.synthetics.push({
          sessionID: input.sessionID,
          description: input.description,
          text: input.text,
          resume: input.resume,
          raw: input,
        });
        return {
          id: "msg_synthetic",
          sessionID: input.sessionID,
          type: "synthetic",
          payload: { text: input.text, description: input.description },
          delivery: "steer",
        };
      },
      update: async (input: { sessionID: string; title: string }) => {
        this.titles.set(input.sessionID, input.title);
      },
      create: async (input: { title?: string }) => {
        const id = `ses_reviewer_${this.created.length + 1}`;
        this.created.push(id);
        return { id, title: input.title };
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        this.switched.push({ sessionID: input.sessionID, agent: input.agent });
      },
      switchModel: async (input: { sessionID: string; model: any }) => {
        this.switchedModels.push({ sessionID: input.sessionID, model: input.model });
      },
      compact: async (input: { sessionID: string }) => {
        this.compactions.push({ sessionID: input.sessionID });
      },
      interrupt: async (input: { sessionID: string; resume?: boolean }) => {
        this.interrupted.push({ sessionID: input.sessionID, resume: input.resume });
        return { interrupted: true };
      },
      prompt: async (input: { sessionID: string; text: string; resume?: unknown }) => {
        this.reviewerPrompts.push({ sessionID: input.sessionID, text: input.text, resume: input.resume });
        return {};
      },
      wait: async () => undefined,
      remove: async (input: { sessionID: string }) => {
        this.removed.push(input.sessionID);
      },
      get: async (input: { sessionID: string }) => ({ id: input.sessionID, agent: "homewide" }),
      hook: async (name: string, callback: (input: any) => unknown) => {
        this.hooks.set(name, callback);
        return { dispose: async () => {} };
      },
    };
    this.agent = {
      // agent.get returns the {location, data} envelope on 2.0.26.
      get: async (input: { agentID: string }) => ({
        location: { directory: this.location.directory },
        data: { id: input.agentID, model: this.laneModel },
      }),
    };
    this.tool = {
      transform: async (callback: (editor: { add: (tool: any) => void }) => void) => {
        callback({ add: (tool: any) => this.tools.set(tool.name, tool) });
        return { dispose: async () => {} };
      },
    };
    this.command = {
      transform: async (callback: (editor: { add: (command: any) => void }) => void) => {
        callback({ add: (command: any) => this.commands.set(command.name, command) });
        return { dispose: async () => {} };
      },
    };
    this.event = {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          // idle stream; tests drive handleEvent directly
        },
      }),
    };
  }

  emitted(sessionID: string): string[] {
    return this.synthetics.filter((item) => item.sessionID === sessionID).map((item) => item.description ?? item.text);
  }
}

// -------------------------------------------------------------------- record

export function makeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    record_version: 1,
    goal_id: "g0001",
    writer_pid: process.pid,
    objective: "prove the fixture objective",
    status: "active",
    active: true,
    continuing: true,
    stop_reason: null,
    verify_profile: null,
    blocked_reason: null,
    max_turns: null,
    max_tokens: null,
    tokens_baseline: 0,
    tokens_used: 0,
    time_used_seconds: 0,
    turns_used: 0,
    no_progress_turns: 0,
    blocked_count: 0,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}
