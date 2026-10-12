// R-002, R-003, R-009a, R-011, R-012, R-031, R-037, R-037a, R-038a, R-038b,
// R-038c, R-040, R-042, R-043, R-044b, R-045 — engine behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FakeSession, ManualScheduler, MemoryStorage, loadPlugin, makeRecord, settle } from "./helpers.ts";

const state = await loadPlugin("state.ts");
const mutexModule = await loadPlugin("mutex.ts");
const continuation = await loadPlugin("continuation.ts");
const { GoalStore, GoalError, recordKey, currentKey } = state;
const { GoalEngine } = continuation;

const SID = "ses_engine_test";

interface Fixture {
  storage: MemoryStorage;
  store: any;
  mutex: any;
  engine: any;
  scheduler: ManualScheduler;
  session: FakeSession;
  emitted: Array<{ sessionID: string; description: string }>;
  titles: Array<{ sessionID: string; record: any }>;
  dir: string;
  cleanup: () => void;
}

function fixture(options: { dbPath?: string; failPrompts?: number; primary?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "opencode-verified-goal-test-"));
  const storage = new MemoryStorage();
  const scheduler = new ManualScheduler();
  const store = new GoalStore({ storage, pid: process.pid, now: () => scheduler.now });
  const mutex = new mutexModule.SessionMutex({
    dbPath: options.dbPath ?? join(dir, "lock.db"),
    pid: process.pid,
    acquireTimeoutMs: 200,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2))),
  });
  const session = new FakeSession();
  session.failPromptsRemaining = options.failPrompts ?? 0;
  session.sessions.set(SID, { agent: "homewide" });
  const emitted: Array<{ sessionID: string; description: string }> = [];
  const titles: Array<{ sessionID: string; record: any }> = [];
  const engine = new GoalEngine({
    store,
    mutex,
    session: {
      prompt: (input: any) => session.prompt(input),
      synthetic: (input: any) => session.synthetic(input),
      get: (input: any) => session.get(input),
    },
    emit: async (sessionID: string, description: string) => {
      emitted.push({ sessionID, description });
    },
    setTitle: async (sessionID: string, record: any) => {
      titles.push({ sessionID, record });
    },
    isPrimaryAgent: (agent: string | undefined) => (options.primary === false ? false : agent === "homewide"),
    now: () => scheduler.now,
    schedule: scheduler.setTimeout,
    cancel: scheduler.clearTimeout,
  });
  return {
    storage,
    store,
    mutex,
    engine,
    scheduler,
    session,
    emitted,
    titles,
    dir,
    cleanup: () => {
      mutex.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function seedLiveGoal(fx: Fixture, overrides: Record<string, unknown> = {}): Promise<any> {
  const record = makeRecord({ writer_pid: process.pid, ...overrides });
  fx.storage.seed(recordKey(SID, record.goal_id as string), record);
  fx.storage.seed(currentKey(SID), record.goal_id);
  return record;
}

async function arm(fx: Fixture, options: Record<string, unknown> = {}): Promise<any> {
  return fx.engine.withSessionLock(SID, async () => {
    const { record } = await fx.store.current(SID);
    const stateObject = fx.engine.noteGoalStarted(SID);
    fx.engine.armLocked(SID, record, stateObject, options);
    return record;
  });
}

function storedRecord(fx: Fixture, goalId = "g0001"): any {
  return fx.storage.raw(recordKey(SID, goalId));
}

test("three consecutive unattended continuations, fenced objective in every prompt", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    for (let turn = 1; turn <= 3; turn += 1) {
      await fx.scheduler.advance(3000);
      assert.equal(fx.session.promptCount(SID), turn);
      const prompt = fx.session.lastPrompt(SID);
      assert.match(prompt.text, /<objective>[\s\S]*prove the fixture objective[\s\S]*<\/objective>/);
      assert.match(prompt.text, /user-provided data/);
      // Queued, not steered: an operator interrupt with resume=true wakes only
      // steer-scoped work, so a steered continuation would restart a stopped loop.
      assert.equal(prompt.delivery, "queue");
      // Delivered as a synthetic: the model gets the instruction, the operator
      // gets one status line instead of the automatic prompt text.
      assert.equal(prompt.description, "goal continuation");
      // Each turn shows observable progress so the no-progress failsafe stays clear.
      fx.engine.onDrainProgress(SID, "tool");
      await fx.engine.onTerminal("succeeded", SID, { seq: turn });
    }
    assert.equal(fx.session.prompts.filter((p) => p.sessionID === SID).length, 3);
    const record = storedRecord(fx);
    assert.equal(record.turns_used, 3);
    assert.equal(record.continuing, true);
  } finally {
    fx.cleanup();
  }
});

test("started and shutdown/superseded interruptions never schedule a continuation", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    // The dispatched execution starts, then is interrupted by shutdown.
    fx.engine.onExecutionStarted(SID);
    await fx.engine.onTerminal("interrupted", SID, { seq: 1, reason: "shutdown" });
    assert.equal(storedRecord(fx).continuing, true);
    assert.equal(storedRecord(fx).stop_reason, null);
    // The resumed turn's terminal releases nothing extra; a fresh arm dispatches once.
    await fx.engine.onTerminal("succeeded", SID, { seq: 2 });
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2);
    // superseded leaves the goal untouched too
    await fx.engine.onTerminal("interrupted", SID, { seq: 3, reason: "superseded" });
    assert.equal(storedRecord(fx).continuing, true);
  } finally {
    fx.cleanup();
  }
});

test("a completed turn is classified before the next continuation is dispatched", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    // Classification happened; dispatch still waits for min_continue_interval_ms.
    assert.equal(storedRecord(fx).turns_used, 1);
    assert.equal(fx.session.promptCount(SID), 1);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2);
  } finally {
    fx.cleanup();
  }
});

test("one pending submission: a second terminal arms nothing extra", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    await fx.engine.onTerminal("succeeded", SID, { seq: 2 });
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2); // one dispatch, not two
  } finally {
    fx.cleanup();
  }
});

test("identical durable.seq counts once", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    await fx.engine.onTerminal("succeeded", SID, { seq: 7 });
    await fx.engine.onTerminal("succeeded", SID, { seq: 7 });
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2);
    assert.equal(storedRecord(fx).turns_used, 1);
  } finally {
    fx.cleanup();
  }
});

test("a terminal bound to a superseded generation applies to nothing and arms the successor", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000); // continuation for g0001 -> binding g0001
    // The goal is completed and replaced inside the running turn.
    fx.storage.seed(recordKey(SID, "g0002"), makeRecord({ goal_id: "g0002", writer_pid: process.pid, created_at: 2_000 }));
    fx.storage.seed(currentKey(SID), "g0002");
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    // The old terminal's accounting must not land on g0002.
    assert.equal(storedRecord(fx, "g0002").turns_used, 0);
    assert.equal(fx.emitted.filter((item) => item.description.startsWith("goal stopped")).length, 0);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2); // the successor is armed
    assert.match(fx.session.lastPrompt(SID).text, /prove the fixture objective/);
  } finally {
    fx.cleanup();
  }
});

test("a superseded pending is invalidated before the successor is armed", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx); // pending for g0001, timer scheduled, not yet fired
    fx.storage.seed(recordKey(SID, "g0002"), makeRecord({ goal_id: "g0002", writer_pid: process.pid, created_at: 2_000 }));
    fx.storage.seed(currentKey(SID), "g0002");
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 }); // unbound: applies to :current (g0002)
    await fx.scheduler.advance(3000);
    // Exactly one dispatch, and it is the successor's (no stale g0001 prompt).
    assert.equal(fx.session.promptCount(SID), 1);
    assert.equal(storedRecord(fx, "g0002").turns_used, 1);
  } finally {
    fx.cleanup();
  }
});

test("three no-progress drains stop the goal and dispatch one handoff turn", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    for (let turn = 1; turn <= 3; turn += 1) {
      await fx.engine.onTerminal("succeeded", SID, { seq: turn });
      await fx.scheduler.advance(3000);
    }
    const record = storedRecord(fx);
    assert.equal(record.continuing, false);
    assert.equal(record.stop_reason, "no-progress");
    assert.equal(record.status, "active");
    assert.equal(record.no_progress_turns, 3);
    const stops = fx.emitted.filter((item) => item.description === "goal stopped — no-progress");
    assert.equal(stops.length, 1);
    // prompts: 3 continuations + exactly 1 handoff
    const handoffs = fx.session.prompts.filter((p) => /final turn|concise handoff/.test(p.text));
    assert.equal(handoffs.length, 1);
    // Queued like continuations: an operator interrupt must not wake a handoff.
    assert.equal(handoffs[0].delivery, "queue");
    assert.match(handoffs[0].text, /do not call any tool in this turn/);
    assert.match(handoffs[0].text, /do not create, complete, or re-arm any goal/);
    // The handoff's own terminal leaves the stopped record untouched.
    const before = JSON.stringify(storedRecord(fx));
    await fx.engine.onTerminal("succeeded", SID, { seq: 99 });
    assert.equal(JSON.stringify(storedRecord(fx)), before);
  } finally {
    fx.cleanup();
  }
});

test("drain signals: polling counts as progress, length and compaction count, provider-hosted does not", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    // Two no-progress turns...
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    await fx.scheduler.advance(3000);
    await fx.engine.onTerminal("succeeded", SID, { seq: 2 });
    assert.equal(storedRecord(fx).no_progress_turns, 2);
    // ...then a polling-only tool call (a locally executed tool) resets it.
    fx.engine.onDrainProgress(SID, "tool");
    await fx.engine.onTerminal("succeeded", SID, { seq: 3 });
    assert.equal(storedRecord(fx).no_progress_turns, 0);
    // finish: "length" counts as progress.
    fx.engine.onDrainProgress(SID, "length");
    await fx.engine.onTerminal("succeeded", SID, { seq: 4 });
    assert.equal(storedRecord(fx).no_progress_turns, 0);
    // A context-overflow compaction counts as progress.
    fx.engine.onDrainProgress(SID, "compaction");
    await fx.engine.onTerminal("succeeded", SID, { seq: 5 });
    assert.equal(storedRecord(fx).no_progress_turns, 0);
    assert.equal(storedRecord(fx).continuing, true);
  } finally {
    fx.cleanup();
  }
});

test("max_turns trips on its boundary with the durable-first stop", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { max_turns: 2 });
    await arm(fx);
    await fx.scheduler.advance(3000);
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    await fx.scheduler.advance(3000);
    await fx.engine.onTerminal("succeeded", SID, { seq: 2 });
    const record = storedRecord(fx);
    assert.equal(record.stop_reason, "max_turns");
    assert.equal(record.continuing, false);
    assert.equal(record.status, "active");
    assert.equal(fx.emitted.filter((item) => item.description === "goal stopped — max_turns").length, 1);
    const handoffs = fx.session.prompts.filter((p) => /final turn/.test(p.text));
    assert.equal(handoffs.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("max_tokens trips against the baseline-subtracted interval", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { max_tokens: 50, tokens_baseline: 100 });
    await arm(fx);
    await fx.scheduler.advance(3000);
    fx.engine.onUsage(SID, { input: 130, output: 25 }); // interval = 55
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    const record = storedRecord(fx);
    assert.equal(record.tokens_used, 55);
    assert.equal(record.stop_reason, "max_tokens");
    assert.equal(fx.session.prompts.filter((p) => /final turn/.test(p.text)).length, 1);
  } finally {
    fx.cleanup();
  }
});

test("both ceilings set: whichever is crossed first wins", async () => {
  // tokens first
  {
    const fx = fixture();
    try {
      await seedLiveGoal(fx, { max_turns: 5, max_tokens: 10 });
      await arm(fx);
      await fx.scheduler.advance(3000);
      fx.engine.onUsage(SID, { input: 20, output: 0 });
      await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
      assert.equal(storedRecord(fx).stop_reason, "max_tokens");
    } finally {
      fx.cleanup();
    }
  }
  // turns first
  {
    const fx = fixture();
    try {
      await seedLiveGoal(fx, { max_turns: 1, max_tokens: 10 });
      await arm(fx);
      await fx.scheduler.advance(3000);
      fx.engine.onUsage(SID, { input: 5, output: 0 });
      await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
      assert.equal(storedRecord(fx).stop_reason, "max_turns");
    } finally {
      fx.cleanup();
    }
  }
});

test("token accounting never goes negative and excludes nothing else", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { tokens_baseline: 4_000 });
    await arm(fx);
    await fx.scheduler.advance(3000);
    fx.engine.onUsage(SID, { input: 4, output: 8 }); // below baseline
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    assert.equal(storedRecord(fx).tokens_used, 0);
  } finally {
    fx.cleanup();
  }
});

test("time_used_seconds accumulates only while continuing", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    fx.scheduler.now += 5_000;
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    assert.equal(storedRecord(fx).time_used_seconds, 5);
  } finally {
    fx.cleanup();
  }
});

test("execution.failed stops immediately with no handoff and no retry counter", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    fx.engine.onDrainProgress(SID, "tool");
    await fx.engine.onTerminal("failed", SID, { seq: 1 });
    const record = storedRecord(fx);
    assert.equal(record.stop_reason, "execution-failed");
    assert.equal(record.continuing, false);
    assert.equal(fx.emitted.filter((item) => item.description === "goal stopped — execution-failed").length, 1);
    assert.equal(fx.session.prompts.filter((p) => /final turn/.test(p.text)).length, 0);
    await fx.scheduler.advance(9000);
    assert.equal(fx.session.promptCount(SID), 1); // nothing further
  } finally {
    fx.cleanup();
  }
});

test("a failed turn does not reset no_progress_turns", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { no_progress_turns: 2 });
    await arm(fx);
    await fx.scheduler.advance(3000);
    fx.engine.onDrainProgress(SID, "tool");
    await fx.engine.onTerminal("failed", SID, { seq: 1 });
    assert.equal(storedRecord(fx).no_progress_turns, 2);
  } finally {
    fx.cleanup();
  }
});

test("interrupted reasons: user and inactivity stop; shutdown and superseded do not", async () => {
  for (const [reason, expected] of [
    ["user", "user"],
    ["inactivity", "execution-failed"],
  ] as const) {
    const fx = fixture();
    try {
      await seedLiveGoal(fx);
      await arm(fx);
      await fx.scheduler.advance(3000);
      await fx.engine.onTerminal("interrupted", SID, { seq: 1, reason });
      const record = storedRecord(fx);
      assert.equal(record.stop_reason, expected);
      assert.equal(record.continuing, false);
      assert.equal(fx.emitted.filter((item) => item.description === `goal stopped — ${expected}`).length, 1);
    } finally {
      fx.cleanup();
    }
  }
});

test("an unknown interrupted reason stops as execution-failed", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    await fx.engine.onTerminal("interrupted", SID, { seq: 1, reason: "future-reason" });
    assert.equal(storedRecord(fx).stop_reason, "execution-failed");
  } finally {
    fx.cleanup();
  }
});

test("stopped records are write-protected from every terminal", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { continuing: false, stop_reason: "max_turns" });
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    await fx.engine.onTerminal("failed", SID, { seq: 2 });
    const record = storedRecord(fx);
    assert.equal(record.stop_reason, "max_turns");
    assert.equal(record.turns_used, 0);
    assert.equal(fx.session.promptCount(SID), 0);
  } finally {
    fx.cleanup();
  }
});

test("a failed submission is retried on the same spacing and succeeds on attempt two", async () => {
  const fx = fixture({ failPrompts: 1 });
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000); // failure one
    assert.equal(fx.session.promptCount(SID), 0);
    await fx.scheduler.advance(3000); // attempt two succeeds
    assert.equal(fx.session.promptCount(SID), 1);
    assert.equal(storedRecord(fx).continuing, true);
  } finally {
    fx.cleanup();
  }
});

test("three consecutive failed submissions stop the goal with submit-failed", async () => {
  const fx = fixture({ failPrompts: 3 });
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(3000);
    await fx.scheduler.advance(3000);
    await fx.scheduler.advance(3000);
    const record = storedRecord(fx);
    assert.equal(record.stop_reason, "submit-failed");
    assert.equal(record.continuing, false);
    assert.equal(fx.emitted.filter((item) => item.description === "goal stopped — submit-failed").length, 1);
    assert.equal(fx.session.prompts.filter((p) => /final turn/.test(p.text)).length, 0);
  } finally {
    fx.cleanup();
  }
});

test("a pending submission abandoned when the goal stops before dispatch", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    // The goal is paused during the min_continue_interval_ms window.
    const record = storedRecord(fx);
    record.continuing = false;
    record.status = "paused";
    fx.storage.seed(recordKey(SID, "g0001"), record);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 0);
  } finally {
    fx.cleanup();
  }
});

test("a dispatch never steers into an execution already in flight", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    fx.engine.onExecutionStarted(SID); // a turn is already running
    await arm(fx); // pending must wait for the terminal
    await fx.scheduler.advance(9000);
    assert.equal(fx.session.promptCount(SID), 0);
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    await fx.scheduler.advance(1);
    assert.equal(fx.session.promptCount(SID), 1);
  } finally {
    fx.cleanup();
  }
});

test("a foreign-owned goal is never driven", async () => {
  const fx = fixture();
  try {
    // A live pid that is not this process: use the parent via spawn.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      await seedLiveGoal(fx, { writer_pid: child.pid });
      await arm(fx);
      await fx.scheduler.advance(9000);
      assert.equal(fx.session.promptCount(SID), 0);
      await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
      await fx.scheduler.advance(9000);
      assert.equal(fx.session.promptCount(SID), 0);
      assert.equal(storedRecord(fx).turns_used, 0);
    } finally {
      child.kill();
    }
  } finally {
    fx.cleanup();
  }
});

test("a dead owner is taken over under the lock before the first dispatch", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { writer_pid: 999_999_999 });
    await arm(fx);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    assert.equal(storedRecord(fx).writer_pid, process.pid);
  } finally {
    fx.cleanup();
  }
});

test("reconciliation re-arms only driving, owned, existing goals", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    fx.session.sessions.set(SID, { agent: "homewide" });
    const armed = await fx.engine.reconcile();
    assert.equal(armed, 1);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    // A goal left active with continuing: false is never re-armed.
    const record = storedRecord(fx);
    record.continuing = false;
    record.stop_reason = "max_turns";
    fx.storage.seed(recordKey(SID, "g0001"), record);
    await fx.engine.reconcile();
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    // A pointer whose session no longer exists is skipped.
    fx.session.sessions.delete(SID);
    const result = await fx.engine.reconcile();
    assert.equal(result, 0);
  } finally {
    fx.cleanup();
  }
});

test("the setup sweep removes stranded sessions only on a positive miss", async () => {
  const fx = fixture();
  try {
    fx.storage.seed(recordKey("ses_gone", "g0001"), makeRecord({ goal_id: "g0001" }));
    fx.storage.seed(currentKey("ses_gone"), "g0001");
    await seedLiveGoal(fx);
    fx.session.sessions.set(SID, { agent: "homewide" });
    const swept = await fx.engine.sweepMissingSessions();
    assert.equal(swept, 1);
    assert.deepEqual(
      fx.storage.keys().filter((key) => key.includes("ses_gone")),
      [],
    );
    assert.equal(fx.storage.keys().some((key) => key.includes(SID)), true);
  } finally {
    fx.cleanup();
  }
});

test("session deletion sweeps the keys and the pending", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.engine.sweepSession(SID);
    assert.deepEqual(
      fx.storage.keys().filter((key) => key.includes(SID)),
      [],
    );
    await fx.scheduler.advance(9000);
    assert.equal(fx.session.promptCount(SID), 0);
  } finally {
    fx.cleanup();
  }
});

test("mutex exhaustion stops driving with state-write-failed, then lands on a later acquisition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opencode-verified-goal-test-"));
  const storage = new MemoryStorage();
  const scheduler = new ManualScheduler();
  const store = new GoalStore({ storage, pid: process.pid, now: () => scheduler.now });
  let failures = 0;
  let real: any = null;
  const flaky = {
    async withLock(sessionID: string, fn: () => Promise<unknown>) {
      if (failures > 0) {
        failures -= 1;
        throw new GoalError("state-locked", "held by a live owner");
      }
      return real.withLock(sessionID, fn);
    },
    async deleteRow() {},
  };
  const session = new FakeSession();
  const emitted: string[] = [];
  const engine = new GoalEngine({
    store,
    mutex: flaky as any,
    session: {
      prompt: (input: any) => session.prompt(input),
      synthetic: (input: any) => session.synthetic(input),
      get: (input: any) => session.get(input),
    },
    emit: async (_sid: string, description: string) => {
      emitted.push(description);
    },
    setTitle: async () => {},
    now: () => scheduler.now,
    schedule: scheduler.setTimeout,
    cancel: scheduler.clearTimeout,
  });
  try {
    real = new mutexModule.SessionMutex({
      dbPath: join(dir, "lock.db"),
      pid: process.pid,
      sleep: () => Promise.resolve(),
    });
    storage.seed(recordKey(SID, "g0001"), makeRecord({ goal_id: "g0001", writer_pid: process.pid }));
    storage.seed(currentKey(SID), "g0001");
    await engine.withSessionLock(SID, async () => {
      const { record } = await store.current(SID);
      const stateObject = engine.noteGoalStarted(SID);
      engine.armLocked(SID, record, stateObject);
    });
    failures = 3;
    for (let attempt = 0; attempt < 3; attempt += 1) await scheduler.advance(3000);
    assert.equal(emitted.includes("goal stopped — state-write-failed"), true);
    // Nothing was written to the unlocked record.
    assert.equal((storage.raw(recordKey(SID, "g0001")) as any).continuing, true);
    // The next successful acquisition applies the durable stop.
    await engine.withSessionLock(SID, async () => {});
    const record = storage.raw(recordKey(SID, "g0001")) as any;
    assert.equal(record.continuing, false);
    assert.equal(record.stop_reason, "state-write-failed");
    assert.equal(emitted.filter((line) => line === "goal stopped — state-write-failed").length, 1);
  } finally {
    real?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("degraded mutex (unavailable database) proceeds without exclusion", async () => {
  const fx = fixture({ dbPath: join(tmpdir(), "opencode-verified-goal-nodir", "x", "lock.db") });
  // Replace the path with one whose parent cannot be created.
  fx.mutex.close();
  const broken = new mutexModule.SessionMutex({
    // A file where a directory is required makes mkdir/open fail deterministically.
    dbPath: join(tmpdir(), "opencode-verified-goal-nested", "nested", "lock.db"),
    pid: process.pid,
  });
  try {
    await seedLiveGoal(fx);
    await broken.withLock(SID, async () => {});
    const run = broken.withLock(SID, async () => 42);
    assert.equal(await run, 42);
  } finally {
    broken.close();
    fx.cleanup();
  }
});

test("R-013: a non-primary session agent never receives a continuation", async () => {
  const fx = fixture({ primary: false });
  try {
    await seedLiveGoal(fx);
    await arm(fx);
    await fx.scheduler.advance(9000);
    assert.equal(fx.session.promptCount(SID), 0);
  } finally {
    fx.cleanup();
  }
});

test("a re-armed goal whose ceiling is already spent trips again immediately", async () => {
  const fx = fixture();
  try {
    await seedLiveGoal(fx, { max_turns: 1, turns_used: 1, continuing: false, stop_reason: "max_turns" });
    // /goal resume re-arms (server path, mimicked here).
    await fx.engine.withSessionLock(SID, async () => {
      const { record } = await fx.store.current(SID);
      record.continuing = true;
      record.stop_reason = null;
      record.no_progress_turns = 0;
      const stateObject = fx.engine.noteGoalStarted(SID);
      await fx.store.writeRecord(SID, record);
      fx.engine.armLocked(SID, record, stateObject, { immediate: true });
    });
    await fx.scheduler.advance(1);
    assert.equal(fx.session.promptCount(SID), 1);
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    assert.equal(storedRecord(fx).stop_reason, "max_turns");
  } finally {
    fx.cleanup();
  }
});
