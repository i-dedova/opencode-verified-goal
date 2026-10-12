// R-004..R-010a, R-013, R-014, R-027, R-029a/b/f, R-035, R-036, R-041, R-043,
// R-046 — server wiring, transitions, commands, visibility.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FakeCtx, FakeSession, ManualScheduler, MemoryStorage, loadPlugin, makeRecord } from "./helpers.ts";

const state = await loadPlugin("state.ts");
const mutexModule = await loadPlugin("mutex.ts");
const continuation = await loadPlugin("continuation.ts");
const server = await loadPlugin("server.ts");
const { GoalStore, currentKey, recordKey, seqKey, reviewerKey } = state;
const { GoalEngine } = continuation;

const SID = "ses_server_test";

class FakeReviewer {
  calls: any[] = [];
  onReview: (input: any) => any = (input) => ({
    status: "verdict",
    approved: true,
    reason: "checklist satisfied",
    raw: "verdict: approved",
    profile: input.profile,
    transition: input.transition,
    reviewerSessionID: "ses_reviewer_fake",
  });
  async review(input: any): Promise<any> {
    this.calls.push(input);
    return await this.onReview(input);
  }
}

interface Fixture {
  ctx: FakeCtx;
  storage: MemoryStorage;
  store: any;
  scheduler: ManualScheduler;
  session: FakeSession;
  engine: any;
  reviewer: FakeReviewer;
  deps: any;
  dir: string;
  cleanup: () => void;
  emitted: () => string[];
  last: () => any;
}

async function fixture(): Promise<Fixture> {
  const ctx = new FakeCtx();
  const dir = mkdtempSync(join(tmpdir(), "opencode-verified-goal-server-"));
  // Anchor asset resolution at the empty temp dir, not the record folder the
  // tests run inside (that would always resolve spec-backed).
  ctx.location.directory = dir;
  const scheduler = new ManualScheduler();
  const store = new GoalStore({ storage: ctx.storage, pid: process.pid, now: () => scheduler.now });
  const mutex = new mutexModule.SessionMutex({
    dbPath: join(dir, "lock.db"),
    pid: process.pid,
    acquireTimeoutMs: 200,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2))),
  });
  const session = new FakeSession();
  session.sessions.set(SID, { agent: "homewide" });
  const engine = new GoalEngine({
    store,
    mutex,
    session: {
      prompt: (i: any) => session.prompt(i),
      synthetic: (i: any) => session.synthetic(i),
      get: (i: any) => session.get(i),
    },
    emit: (sessionID: string, description: string) => server.emitState(ctx, sessionID, description),
    setTitle: (sessionID: string, record: any) => server.setSessionTitle(ctx, sessionID, record),
    isPrimaryAgent: (agent: string | undefined) => agent === "homewide",
    now: () => scheduler.now,
    schedule: scheduler.setTimeout,
    cancel: scheduler.clearTimeout,
  });
  const reviewer = new FakeReviewer();
  const deps = { ctx, store, engine, reviewer };
  await server.registerTools(ctx, deps);
  await server.registerCommands(ctx, deps);
  await server.registerHooks(ctx, deps);
  return {
    ctx,
    storage: ctx.storage,
    store,
    scheduler,
    session,
    engine,
    reviewer,
    deps,
    dir,
    cleanup: () => {
      mutex.close();
      rmSync(dir, { recursive: true, force: true });
    },
    emitted: () => ctx.emitted(SID),
    last: () => ctx.synthetics.filter((item) => item.sessionID === SID).at(-1),
  };
}

async function callTool(fx: Fixture, name: string, input: any): Promise<any> {
  const tool = fx.ctx.tools.get(name);
  assert.ok(tool, `tool ${name} registered`);
  return await tool.execute(input, { sessionID: SID });
}

async function runCommand(fx: Fixture, text: string): Promise<void> {
  const command = fx.ctx.commands.get("goal");
  assert.ok(command, "goal command registered");
  await command.execute({ sessionID: SID, prompt: { text }, delivery: "steer" });
}

async function createViaCommand(fx: Fixture, objective: string): Promise<void> {
  await runCommand(fx, objective);
  assert.match(fx.emitted().at(-1) as string, /^goal set — /);
}

function liveRecord(fx: Fixture): any {
  return fx.storage.raw(currentKey(SID)) === undefined
    ? null
    : fx.storage.raw(recordKey(SID, fx.storage.raw(currentKey(SID)) as string));
}

function evidenceFixture(fx: Fixture, name = "evidence.txt"): string {
  const file = join(fx.dir, name);
  writeFileSync(file, "the tests pass and the objective is met\n", "utf8");
  return file;
}

// ------------------------------------------------------------------ registration

test("exactly three tools, one command, and no prompt hook are registered", async () => {
  const fx = await fixture();
  try {
    assert.deepEqual([...fx.ctx.tools.keys()].sort(), ["get_goal", "set_goal", "update_goal"]);
    assert.deepEqual([...fx.ctx.commands.keys()], ["goal"]);
    assert.deepEqual([...fx.ctx.hooks.keys()].sort(), ["compaction", "context"]);
    const setGoal = fx.ctx.tools.get("set_goal");
    assert.equal(setGoal.input.additionalProperties, false);
    assert.equal(setGoal.options.codemode, false);
    assert.match(setGoal.description, /^Start a session goal only on the operator's explicit instruction/);
    assert.equal(fx.ctx.tools.get("update_goal").input.additionalProperties, false);
    assert.equal(fx.ctx.tools.get("get_goal").input.additionalProperties, false);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------------- creation

test("/goal <objective> creates the goal, emits the state line, and arms a turn", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "prove the fixture objective");
    const record = liveRecord(fx);
    assert.equal(record.status, "active");
    assert.equal(record.active, true);
    assert.equal(record.continuing, true);
    assert.equal(record.turns_used, 0);
    assert.equal(record.writer_pid, process.pid);
    assert.equal(fx.last().description, "goal set — prove the fixture objective");
    assert.equal(fx.last().resume, false);
    assert.equal(liveRecord(fx).goal_id, "g0001");
    assert.equal(fx.ctx.titles.get(SID), "prove the fixture objective — active");
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
  } finally {
    fx.cleanup();
  }
});

test("set_goal tool refuses while an unfinished goal exists, byte-identically", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "first objective");
    const before = JSON.stringify(liveRecord(fx));
    const result = await callTool(fx, "set_goal", { objective: "second objective" });
    assert.match(result.content, /^goal refused — illegal-transition: /);
    assert.equal(JSON.stringify(liveRecord(fx)), before);
    assert.equal(fx.storage.raw(seqKey(SID)), 1);
    // Paused and blocked are equally protected.
    await runCommand(fx, "pause");
    const paused = await callTool(fx, "set_goal", { objective: "second objective" });
    assert.match(paused.content, /illegal-transition/);
    assert.match(fx.last().description, /^goal refused — illegal-transition: /);
  } finally {
    fx.cleanup();
  }
});

test("set_goal refuses invalid objectives and budgets with named codes", async () => {
  const fx = await fixture();
  try {
    const empty = await callTool(fx, "set_goal", { objective: "   " });
    assert.match(empty.content, /^goal refused — objective-invalid/);
    const tooLong = await callTool(fx, "set_goal", { objective: "x".repeat(4001) });
    assert.match(tooLong.content, /^goal refused — objective-invalid/);
    const badTurns = await callTool(fx, "set_goal", { objective: "ship the release build", max_turns: 0 });
    assert.match(badTurns.content, /^goal refused — budget-invalid/);
    const badTokens = await callTool(fx, "set_goal", { objective: "ship the release build", max_tokens: -2 });
    assert.match(badTokens.content, /^goal refused — budget-invalid/);
    assert.equal(liveRecord(fx), null);
  } finally {
    fx.cleanup();
  }
});

test("superceding a complete goal writes a fresh record and retains the closed one", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "first objective");
    const evidence = evidenceFixture(fx);
    const completion = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "the tests pass",
      evidence_path: evidence,
    });
    assert.match(completion.content, /"status":"complete"/);
    assert.equal(liveRecord(fx), null);
    assert.equal(fx.last().description, "goal complete — first objective");
    const closed = fx.storage.raw(recordKey(SID, "g0001")) as any;
    assert.equal(closed.status, "complete");
    assert.equal(closed.active, false);
    // A new goal over the completed one occupies the slot with fresh counters.
    await createViaCommand(fx, "second objective");
    const fresh = liveRecord(fx);
    assert.equal(fresh.goal_id, "g0002");
    assert.equal(fresh.status, "active");
    assert.equal(fresh.turns_used, 0);
    assert.equal(fresh.tokens_used, 0);
    assert.equal((fx.storage.raw(recordKey(SID, "g0001")) as any).status, "complete");
    // get_goal reports prior_goals counting the earlier record.
    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.equal(view.prior_goals, 1);
    assert.equal(view.goal_id, "g0002");
    assert.equal("writer_pid" in view, false);
  } finally {
    fx.cleanup();
  }
});

test("auto-clear frees the slot; /goal clear removes only the live record and pointer", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "first objective");
    await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "done",
      evidence_path: evidenceFixture(fx),
    });
    await createViaCommand(fx, "second objective");
    const titleBefore = fx.ctx.titles.get(SID);
    // /goal clear: pointer and the live record only; the closed record survives.
    await runCommand(fx, "clear");
    assert.equal(fx.last().description, "goal cleared");
    assert.equal(liveRecord(fx), null);
    assert.equal(fx.storage.raw(recordKey(SID, "g0001"))?.status, "complete");
    assert.equal(fx.storage.raw(recordKey(SID, "g0002")), undefined);
    assert.equal(fx.storage.raw(seqKey(SID)), 2);
    assert.equal(fx.ctx.titles.get(SID), titleBefore); // title deliberately unchanged
    // Clearing again is a silent no-op.
    const emissions = fx.emitted().length;
    await runCommand(fx, "clear");
    assert.equal(fx.emitted().length, emissions);
  } finally {
    fx.cleanup();
  }
});

test("two completed goals and one active: prior_goals 2 and the full history listing", async () => {
  const fx = await fixture();
  try {
    for (const name of ["first objective", "second objective"]) {
      await createViaCommand(fx, name);
      await callTool(fx, "update_goal", { status: "complete", evidence: "done", evidence_path: evidenceFixture(fx, `e-${name}.txt`) });
    }
    await createViaCommand(fx, "third objective");
    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.equal(view.prior_goals, 2);
    await runCommand(fx, "");
    const history = fx.emitted().slice(-3);
    assert.deepEqual(history, [
      "goal g0001 — complete — 0 turns — first objective",
      "goal g0002 — complete — 0 turns — second objective",
      "goal g0003 — active — 0 turns — third objective — live",
    ]);
    // Prefix scan returns all three records plus the pointer and seq.
    const scan = await fx.store.scanAll(`goal:${SID}:`);
    assert.deepEqual(
      scan.map((entry: any) => entry.key).sort(),
      [currentKey(SID), recordKey(SID, "g0001"), recordKey(SID, "g0002"), recordKey(SID, "g0003"), seqKey(SID)].sort(),
    );
  } finally {
    fx.cleanup();
  }
});

test("/goal with no records emits the single no-goals line", async () => {
  const fx = await fixture();
  try {
    await runCommand(fx, "");
    assert.deepEqual(fx.emitted(), ["no goals"]);
  } finally {
    fx.cleanup();
  }
});

// ---------------------------------------------------------- pause/resume/clear

test("pause and resume emit their state lines and resume re-arms", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective alpha");
    await runCommand(fx, "pause");
    assert.equal(fx.last().description, "goal paused — objective alpha");
    assert.equal(liveRecord(fx).status, "paused");
    assert.equal(liveRecord(fx).continuing, false);
    assert.equal(liveRecord(fx).stop_reason, null);
    await fx.scheduler.advance(9000);
    assert.equal(fx.session.promptCount(SID), 0); // no continuation while paused
    await runCommand(fx, "resume");
    assert.equal(fx.last().description, "goal resumed — objective alpha");
    assert.equal(liveRecord(fx).status, "active");
    assert.equal(liveRecord(fx).continuing, true);
    await fx.scheduler.advance(1);
    assert.equal(fx.session.promptCount(SID), 1);
  } finally {
    fx.cleanup();
  }
});

test("resume from a stopped active goal carries the real objective; active-continuing says no available", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective beta");
    const record = liveRecord(fx);
    record.continuing = false;
    record.stop_reason = "execution-failed";
    fx.storage.seed(recordKey(SID, "g0001"), record);
    await runCommand(fx, "resume");
    assert.equal(fx.last().description, "goal resumed — objective beta");
    assert.equal(liveRecord(fx).continuing, true);
    assert.equal(liveRecord(fx).stop_reason, null);
    await runCommand(fx, "resume");
    assert.equal(fx.last().description, "no available goal to resume");
  } finally {
    fx.cleanup();
  }
});

test("resume with no goal and with a complete goal emits no-available", async () => {
  const fx = await fixture();
  try {
    await runCommand(fx, "resume");
    assert.equal(fx.last().description, "no available goal to resume");
    await createViaCommand(fx, "objective gamma");
    await callTool(fx, "update_goal", { status: "complete", evidence: "done", evidence_path: evidenceFixture(fx) });
    await runCommand(fx, "resume");
    assert.equal(fx.last().description, "no available goal to resume");
  } finally {
    fx.cleanup();
  }
});

test("resume on a foreign-owned goal refuses with foreign-writer and dispatches nothing", async () => {
  const fx = await fixture();
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const foreign = makeRecord({ goal_id: "g0001", writer_pid: child.pid, status: "paused", continuing: false, stop_reason: null, active: true });
      fx.storage.seed(recordKey(SID, "g0001"), foreign);
      fx.storage.seed(currentKey(SID), "g0001");
      await runCommand(fx, "resume");
      assert.match(fx.last().description as string, /^goal refused — foreign-writer: /);
      await fx.scheduler.advance(9000);
      assert.equal(fx.session.promptCount(SID), 0);
    } finally {
      child.kill();
    }
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------------ update_goal

test("update_goal cannot set paused and rejects off-table requests", async () => {
  const fx = await fixture();
  try {
    const noGoal = await callTool(fx, "update_goal", { status: "active" });
    assert.match(noGoal.content, /^goal refused — illegal-transition/);
    await createViaCommand(fx, "objective delta");
    const paused = await callTool(fx, "update_goal", { status: "paused" });
    assert.match(paused.content, /^goal refused — illegal-transition/);
    assert.equal(liveRecord(fx).status, "active");
    const nonsense = await callTool(fx, "update_goal", { status: "confused" });
    assert.match(nonsense.content, /^goal refused — illegal-transition/);
  } finally {
    fx.cleanup();
  }
});

test("agent re-arm (active → active) zeroes no_progress and preserves cumulative counters", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective epsilon");
    const record = liveRecord(fx);
    record.turns_used = 4;
    record.no_progress_turns = 2;
    record.continuing = false;
    record.stop_reason = "execution-failed";
    fx.storage.seed(recordKey(SID, "g0001"), record);
    const before = fx.emitted().length;
    const result = await callTool(fx, "update_goal", { status: "active" });
    assert.match(result.content, /"continuing":true/);
    const after = liveRecord(fx);
    assert.equal(after.turns_used, 4);
    assert.equal(after.no_progress_turns, 0);
    assert.equal(after.stop_reason, null);
    assert.equal(fx.emitted().length, before); // re-arm emits no state line
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
  } finally {
    fx.cleanup();
  }
});

test("blocked requires a reason and applies immediately without a reviewer", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective zeta");
    const missing = await callTool(fx, "update_goal", { status: "blocked" });
    assert.match(missing.content, /^goal refused — blocked-reason-required/);
    assert.equal(fx.reviewer.calls.length, 0);

    await callTool(fx, "update_goal", { status: "blocked", reason: "please decide X" });
    const record = liveRecord(fx);
    assert.equal(record.status, "blocked");
    assert.equal(record.continuing, false);
    assert.equal(record.stop_reason, null);
    assert.equal(record.blocked_count, 1);
    assert.equal(record.blocked_reason, "please decide X");
    assert.equal(fx.last().description, "goal blocked — please decide X");
    assert.equal(fx.reviewer.calls.length, 0, "blocking never reaches the reviewer");
    // Blocking ends autonomous driving, not the agent's turn: the tool result
    // must reach the agent, so nothing is interrupted here.
    assert.equal(fx.ctx.interrupted.length, 0, "blocking must not interrupt the turn that reported it");
  } finally {
    fx.cleanup();
  }
});

test("block-resume-block-resume leaves blocked_count at 2 without any review", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective eta");
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await callTool(fx, "update_goal", { status: "blocked", reason: "please decide Y" });
      await runCommand(fx, "resume"); // operator authority: no reviewer
      assert.equal(fx.last().description, "goal resumed — objective eta");
    }
    assert.equal(fx.reviewer.calls.length, 0); // blocking is agent-authoritative
    const record = liveRecord(fx);
    assert.equal(record.blocked_count, 2);
    assert.equal(record.status, "active");
  } finally {
    fx.cleanup();
  }
});

test("reviewed unblock goes through the verifier and zeroes no_progress", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective theta");
    await callTool(fx, "update_goal", { status: "blocked", reason: "needs the operator to choose a port" });
    const blocked = liveRecord(fx);
    blocked.no_progress_turns = 1;
    fx.storage.seed(recordKey(SID, "g0001"), blocked);
    const callsBefore = fx.reviewer.calls.length;
    const result = await callTool(fx, "update_goal", {
      status: "active",
      reason: "The operator has chosen the port: 8080.",
    });
    assert.match(result.content, /"status":"active"/);
    const record = liveRecord(fx);
    assert.equal(record.status, "active");
    assert.equal(record.continuing, true);
    assert.equal(record.no_progress_turns, 0);
    assert.equal(record.blocked_count, 1);
    assert.equal(fx.reviewer.calls.length, callsBefore + 1);
    assert.match(fx.reviewer.calls.at(-1).tail, /blocked-active/);
    assert.match(fx.reviewer.calls.at(-1).payload, /The operator has chosen the port: 8080/);
    // R-039/R-021: the reviewer receives the previously accepted condition.
    assert.match(fx.reviewer.calls.at(-1).tail, /needs the operator to choose a port/);
  } finally {
    fx.cleanup();
  }
});

test("complete requires evidence, a readable file, and allowed roots", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective iota");
    const missing = await callTool(fx, "update_goal", { status: "complete", evidence: "  " });
    assert.match(missing.content, /^goal refused — evidence-required/);
    const noPath = await callTool(fx, "update_goal", { status: "complete", evidence: "did it" });
    assert.match(noPath.content, /^goal refused — evidence-unreadable/);
    const notAFile = await callTool(fx, "update_goal", { status: "complete", evidence: "did it", evidence_path: fx.dir });
    assert.match(notAFile.content, /^goal refused — evidence-unreadable/);
    const outside = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: "C:\\Windows\\win.ini",
    });
    assert.match(outside.content, /^goal refused — evidence-outside-allowed-roots/);
    // The refusal marker never carries the objective or evidence text.
    const marker = fx.last().description as string;
    assert.equal(marker.includes("objective iota"), false);
    assert.equal(marker.includes("did it"), false);
  } finally {
    fx.cleanup();
  }
});

test("a stale approval is refused when the goal changes during the review (R-046)", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective kappa");
    fx.reviewer.onReview = async (input: any) => {
      // The operator clears the goal while the reviewer is thinking.
      await server.clearGoal(fx.deps, SID);
      return {
        status: "verdict",
        approved: true,
        reason: "looks done",
        raw: "verdict: approved",
        profile: input.profile,
        transition: input.transition,
      };
    };
    const result = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "done",
      evidence_path: evidenceFixture(fx),
    });
    assert.match(result.content, /^goal refused — illegal-transition: stale review/);
    assert.equal(liveRecord(fx), null);
    assert.equal(fx.reviewer.calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("evidence vanished between verdict and apply refuses with evidence-vanished", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective lambda");
    const evidence = evidenceFixture(fx);
    const { rmSync } = await import("node:fs");
    fx.reviewer.onReview = async (input: any) => {
      rmSync(evidence, { force: true });
      return {
        status: "verdict",
        approved: true,
        reason: "ok",
        raw: "",
        profile: input.profile,
        transition: input.transition,
      };
    };
    const result = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "done",
      evidence_path: evidence,
    });
    assert.match(result.content, /^goal refused — evidence-vanished/);
    assert.equal(liveRecord(fx).status, "active");
  } finally {
    fx.cleanup();
  }
});

test("a second update_goal while a review is in flight returns transition-in-flight", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective mu");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fx.reviewer.onReview = async (input: any) => {
      await gate;
      return {
        status: "verdict",
        approved: true,
        reason: "ok",
        raw: "",
        profile: input.profile,
        transition: input.transition,
      };
    };
    const first = callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await callTool(fx, "update_goal", { status: "blocked", reason: "please decide Z" });
    assert.match(second.content, /^goal refused — transition-in-flight/);
    release();
    const applied = await first;
    assert.match(applied.content, /"status":"complete"/);
    assert.equal(fx.reviewer.calls.length, 1);
  } finally {
    fx.cleanup();
  }
});

test("reviewer timeout and unparseable verdicts refuse with their codes", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective nu");
    fx.reviewer.onReview = (input: any) => ({
      status: "timeout",
      approved: false,
      reason: "no answer",
      raw: "",
      profile: input.profile,
      transition: input.transition,
    });
    const timeout = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    assert.match(timeout.content, /^goal refused — verifier-timeout/);
    fx.reviewer.onReview = (input: any) => ({
      status: "unparseable",
      approved: false,
      reason: "bad grammar",
      raw: "verdict: maybe\nthis is not the grammar",
      profile: input.profile,
      transition: input.transition,
    });
    const unparsable = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    assert.equal(unparsable.content.startsWith("goal refused — verifier-unparseable: verdict: maybe"), true);
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------------------ hooks

test("context and compaction hooks inject nothing without a goal and the fenced snapshot with one", async () => {
  const fx = await fixture();
  try {
    const contextHook = fx.ctx.hooks.get("context")!;
    const cleanSystem = [{ type: "text", text: "base system" }];
    await contextHook({ sessionID: SID, system: cleanSystem });
    assert.deepEqual(cleanSystem, [{ type: "text", text: "base system" }]);
    await createViaCommand(fx, "objective xi");
    const system: any[] = [{ type: "text", text: "base system" }];
    await contextHook({ sessionID: SID, system });
    assert.equal(system.length, 2);
    assert.match(system[1].text, /<objective>\nobjective xi\n<\/objective>/);
    assert.match(system[1].text, /user-provided data/);
    const compactionHook = fx.ctx.hooks.get("compaction")!;
    const compactionSystem: any[] = [];
    await compactionHook({ sessionID: SID, system: compactionSystem });
    assert.equal(compactionSystem.length, 1);
    assert.match(compactionSystem[0].text, /objective xi/);
    // A paused goal still injects (a live goal), a cleared one does not.
    await runCommand(fx, "pause");
    const pausedSystem: any[] = [];
    await contextHook({ sessionID: SID, system: pausedSystem });
    assert.equal(pausedSystem.length, 1);
    await runCommand(fx, "clear");
    const clearedSystem: any[] = [];
    await contextHook({ sessionID: SID, system: clearedSystem });
    assert.equal(clearedSystem.length, 0);
  } finally {
    fx.cleanup();
  }
});

// -------------------------------------------------------------------- visibility

test("synthetic emissions carry the exact strings, resume:false, and no metadata", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective omicron");
    for (const emission of fx.ctx.synthetics) {
      assert.equal(emission.resume, false);
      assert.equal(emission.raw.metadata, undefined);
      assert.equal(typeof emission.description, "string");
      assert.notEqual((emission.description as string).length, 0);
      // D-064: `text` carries no model-visible content; the client renders
      // `description`, and the provider lowerings drop the whitespace turn.
      assert.equal(emission.text.trim(), "");
    }
    assert.equal(fx.ctx.synthetics.filter((item) => item.sessionID === SID).length, 1);
    await callTool(fx, "get_goal", {});
    assert.equal(fx.ctx.synthetics.filter((item) => item.sessionID === SID).length, 1); // no marker for get_goal
  } finally {
    fx.cleanup();
  }
});

test("a ceiling trip emits exactly one goal stopped line and the title carries the reason", async () => {
  const fx = await fixture();
  try {
    await callTool(fx, "set_goal", { objective: "objective rho", max_turns: 1 });
    await fx.scheduler.advance(3000);
    fx.engine.onDrainProgress(SID, "tool"); // progress so no-progress does not fire first
    await fx.engine.onTerminal("succeeded", SID, { seq: 1 });
    const stopped = fx.ctx.synthetics.filter((item) => item.description === "goal stopped — max_turns");
    assert.equal(stopped.length, 1);
    assert.equal(fx.ctx.titles.get(SID), "objective rho — active (max_turns)");
  } finally {
    fx.cleanup();
  }
});

test("titles truncate long objectives to 80 characters with the suffix preserved", async () => {
  const fx = await fixture();
  try {
    const objective = "o".repeat(100);
    await createViaCommand(fx, objective);
    const title = fx.ctx.titles.get(SID) as string;
    assert.equal(title, `${"o".repeat(80)} — active`);
    assert.equal(fx.last().description, `goal set — ${"o".repeat(100)}`);
  } finally {
    fx.cleanup();
  }
});

test("the objective is truncated to 200 characters with a trailing ellipsis in state lines", async () => {
  const fx = await fixture();
  try {
    const objective = "z".repeat(250);
    await createViaCommand(fx, objective);
    const description = fx.last().description as string;
    assert.equal(description, `goal set — ${"z".repeat(200)}…`);
  } finally {
    fx.cleanup();
  }
});

test("get_goal returns an explicit empty result with prior goals and emits nothing", async () => {
  const fx = await fixture();
  try {
    const before = fx.ctx.synthetics.length;
    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.deepEqual(view, {
      goal: null,
      prior_goals: 0,
      review_journal: join(tmpdir(), "opencode-verified-goal", "reviews", `${SID}.jsonl`),
    });
    assert.equal(fx.ctx.synthetics.length, before);
  } finally {
    fx.cleanup();
  }
});

test("a paused or blocked live goal reports active:true with continuing:false", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective pi");
    await runCommand(fx, "pause");
    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.equal(view.active, true);
    assert.equal(view.continuing, false);
    assert.equal(view.status, "paused");
  } finally {
    fx.cleanup();
  }
});

test("verify_profile is reported after a review", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective rho");
    await callTool(fx, "update_goal", { status: "blocked", reason: "needs deciding" });
    // The reviewed unblock is an approved transition that keeps the record, so
    // the profile it was judged under is visible.
    fx.reviewer.onReview = approveReview();
    await callTool(fx, "update_goal", { status: "active", reason: "The operator decided." });
    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.equal(view.verify_profile, "ad-hoc");
  } finally {
    fx.cleanup();
  }
});

test("a record-folder anchor resolves spec-backed and inlines the spec and log", async () => {
  const fx = await fixture();
  try {
    const folder = join(fx.dir, "spec-records", "T1-fixture");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "T1-fixture.md"), "SPEC-MARKER-9911 acceptance criteria text", "utf8");
    writeFileSync(join(folder, "T1-fixture.implementation-decisions.md"), "LOG-MARKER-8822 decisions", "utf8");
    const evidence = join(folder, "evidence.txt");
    writeFileSync(evidence, "EVIDENCE-MARKER-7733 done\n", "utf8");
    await createViaCommand(fx, "objective spec-backed");
    await callTool(fx, "update_goal", { status: "complete", evidence: "EVIDENCE-MARKER-7733", evidence_path: evidence });
    const review = fx.reviewer.calls.at(-1);
    assert.equal(review.profile, "spec-backed");
    assert.match(review.payload, /SPEC-MARKER-9911/);
    assert.match(review.payload, /LOG-MARKER-8822/);
    assert.match(review.payload, /EVIDENCE-MARKER-7733/);
    assert.match(review.tail, /Checklist \(closure\)/);
    assert.equal(liveRecord(fx), null);
    assert.equal((fx.storage.raw(recordKey(SID, "g0001")) as any).verify_profile, "spec-backed");
  } finally {
    fx.cleanup();
  }
});

// ------------------------------------------------------------------ event wiring

test("handleEvent drives continuations only from durable terminals", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective sigma");
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    // A terminal without a durable block is ignored.
    await server.handleEvent(fx.ctx, fx.deps, { type: "session.execution.succeeded", data: { sessionID: SID } });
    assert.equal(liveRecord(fx).turns_used, 0);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 1);
    // With a durable block it is processed.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 5 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).turns_used, 1);
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), 2);
    // A session with no goal record is ignored.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.failed",
      durable: { seq: 6 },
      data: { sessionID: "ses_unrelated" },
    });
  } finally {
    fx.cleanup();
  }
});

test("handleEvent classifies drains exactly as the engine contract states", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective tau");
    await fx.scheduler.advance(3000);
    // A provider-hosted tool call (executed: true) is not local progress.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.tool.called",
      durable: { seq: 1 },
      data: { sessionID: SID, executed: true },
    });
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 2 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).no_progress_turns, 1);
    // A locally executed tool call is progress.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.tool.called",
      durable: { seq: 3 },
      data: { sessionID: SID, executed: false },
    });
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 4 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).no_progress_turns, 0);
    // Whitespace-only text is not progress.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.text.ended",
      durable: { seq: 5 },
      data: { sessionID: SID, text: "   \n" },
    });
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 6 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).no_progress_turns, 1);
    // finish: "length" is progress.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.step.ended",
      durable: { seq: 7 },
      data: { sessionID: SID, finish: "length" },
    });
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 8 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).no_progress_turns, 0);
  } finally {
    fx.cleanup();
  }
});

test("handleEvent tracks cumulative usage and sweeps deleted sessions", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective upsilon");
    const record = liveRecord(fx);
    record.tokens_baseline = 100;
    fx.storage.seed(recordKey(SID, "g0001"), record);
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.usage.updated",
      data: { sessionID: SID, tokens: { input: 80, output: 40 } },
    });
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 1 },
      data: { sessionID: SID },
    });
    assert.equal(liveRecord(fx).tokens_used, 20);
    await server.handleEvent(fx.ctx, fx.deps, { type: "session.deleted", durable: { seq: 2 }, data: { sessionID: SID } });
    assert.deepEqual(
      fx.storage.keys().filter((key) => key.includes(SID)),
      [],
    );
  } finally {
    fx.cleanup();
  }
});

test("interrupted events carry the reason through to the stop", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective phi");
    await fx.scheduler.advance(3000);
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.interrupted",
      durable: { seq: 1 },
      data: { sessionID: SID, reason: "user" },
    });
    assert.equal(liveRecord(fx).stop_reason, "user");
    assert.equal(fx.ctx.synthetics.filter((item) => item.description === "goal stopped — user").length, 1);
  } finally {
    fx.cleanup();
  }
});

// --------------------------------------- state-slice: refusal policy and reuse

function rejectReview(reason: string) {
  return (input: any) => ({
    status: "verdict",
    approved: false,
    reason,
    raw: `verdict: rejected\ntransition: ${input.transition}\nprofile: ${input.profile}\nreason: ${reason}\nunmet: x`,
    profile: input.profile,
    transition: input.transition,
    reviewerSessionID: "ses_reviewer_fake",
  });
}

function approveReview() {
  return (input: any) => ({
    status: "verdict",
    approved: true,
    reason: "checklist satisfied",
    raw: "verdict: approved",
    profile: input.profile,
    transition: input.transition,
    reviewerSessionID: "ses_reviewer_fake",
  });
}

test("two verifier refusals stop the goal as verifier-refused with the reason visible", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective refusal");
    fx.reviewer.onReview = rejectReview("the evidence does not cover R-002");

    const first = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    assert.match(first.content, /verifier-rejected/);
    let record = liveRecord(fx);
    assert.equal(record.refusal_count, 1);
    assert.equal(record.continuing, true);
    assert.equal(record.stop_reason, null);
    assert.equal(record.refusal_reason, "verifier-rejected: the evidence does not cover R-002");

    const second = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    assert.match(second.content, /verifier-rejected/);
    record = liveRecord(fx);
    assert.equal(record.refusal_count, 2);
    assert.equal(record.continuing, false);
    assert.equal(record.stop_reason, "verifier-refused");
    assert.equal(record.active, true);

    const stopLine = fx.emitted().find((line) => line.includes("verifier-refused after 2 refusals"));
    assert.ok(stopLine, "the stop line names the policy");
    assert.match(stopLine as string, /the evidence does not cover R-002/);
    assert.match(stopLine as string, /\/goal resume/);
    assert.match(stopLine as string, /\/goal clear/);
    // The stop is written from inside the agent's own turn; the turn is left to
    // finish so the tool result reaches the agent (no interrupt).
    assert.equal(fx.ctx.interrupted.length, 0, "a verifier-refused stop must not interrupt the reporting turn");

    // A stop only ends autonomous driving: on a later user turn the agent may
    // still act. Re-arming is allowed and restarts the refusal streak.
    const rearm = await callTool(fx, "update_goal", { status: "active" });
    assert.match(rearm.content, /"continuing":true/);
    const rearmed = liveRecord(fx);
    assert.equal(rearmed.stop_reason, null);
    assert.equal(rearmed.refusal_count, 0);
    assert.equal(rearmed.refusal_reason, null);
  } finally {
    fx.cleanup();
  }
});

test("an approved transition and /goal resume both clear the refusal streak", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective streak");
    // One refusal on a reviewed transition, then an approval on the same goal.
    fx.reviewer.onReview = rejectReview("not proven");
    await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    assert.equal(liveRecord(fx).refusal_count, 1);
    assert.equal(liveRecord(fx).status, "active");

    // Blocking is agent-authoritative: it applies and does not touch the streak.
    await callTool(fx, "update_goal", { status: "blocked", reason: "Operator decision required: pick a port" });
    assert.equal(liveRecord(fx).status, "blocked");

    // The reviewed unblock clears the streak.
    fx.reviewer.onReview = approveReview();
    await callTool(fx, "update_goal", { status: "active", reason: "The operator chose port 8080." });
    let record = liveRecord(fx);
    assert.equal(record.status, "active");
    assert.equal(record.refusal_count, 0, "an approved transition resets the streak");
    assert.equal(record.refusal_reason, null);

    // Refuse twice: the loop stops, and resume clears the streak again.
    fx.reviewer.onReview = rejectReview("still not proven");
    await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    record = liveRecord(fx);
    assert.equal(record.stop_reason, "verifier-refused");

    await runCommand(fx, "resume");
    record = liveRecord(fx);
    assert.equal(record.continuing, true);
    assert.equal(record.stop_reason, null);
    assert.equal(record.refusal_count, 0);
    assert.equal(record.refusal_reason, null);
  } finally {
    fx.cleanup();
  }
});

test("the reviewer reference is durable, resumes the same session, and is released only when the goal ends", async () => {
  const fx = await fixture();
  try {
    const { mkdirSync } = await import("node:fs");
    const folder = join(fx.dir, "spec-records", "T1-reuse");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "T1-reuse.md"), "SPEC-MARKER-1111", "utf8");
    writeFileSync(join(folder, "T1-reuse.implementation-decisions.md"), "LOG-MARKER-2222", "utf8");
    const evidence = join(folder, "evidence.txt");
    writeFileSync(evidence, "the tests pass\n", "utf8");
    await createViaCommand(fx, "objective reuse");
    fx.reviewer.onReview = rejectReview("not yet");

    await callTool(fx, "update_goal", { status: "complete", evidence: "did it", evidence_path: evidence });
    const reference = fx.storage.raw(reviewerKey(SID)) as any;
    assert.equal(reference.goal_id, "g0001");
    assert.equal(reference.session_id, "ses_reviewer_fake");
    assert.equal(typeof reference.fingerprint, "string");
    assert.match(fx.reviewer.calls.at(-1).payload, /SPEC-MARKER-1111/);

    // Pausing keeps the reviewer: resume re-arms the same goal id.
    await runCommand(fx, "pause");
    assert.notEqual(fx.storage.raw(reviewerKey(SID)), undefined);
    assert.equal(fx.ctx.removed.includes("ses_reviewer_fake"), false);
    await runCommand(fx, "resume");

    // Second review of the same goal: the reference is passed back and the
    // unchanged assets are not re-inlined.
    await callTool(fx, "update_goal", { status: "complete", evidence: "did it", evidence_path: evidence });
    const second = fx.reviewer.calls.at(-1);
    assert.equal(second.reuseSessionID, "ses_reviewer_fake");
    assert.equal(second.payload.includes("SPEC-MARKER-1111"), false);
    assert.equal(second.payload.includes("LOG-MARKER-2222"), false);
    assert.match(second.payload, /unchanged since your previous review/);

    // Clearing the goal ends it, so the reviewer goes with it.
    await runCommand(fx, "clear");
    assert.equal(fx.storage.raw(reviewerKey(SID)), undefined);
    assert.equal(fx.ctx.removed.includes("ses_reviewer_fake"), true);
  } finally {
    fx.cleanup();
  }
});

test("a review appends a journal line, get_goal names the journal, and pruning respects the window", async () => {
  const fx = await fixture();
  try {
    const journal = await loadPlugin("journal.ts");
    const path = journal.reviewJournalPath(SID);
    rmSync(path, { force: true });
    await createViaCommand(fx, "objective journal");
    fx.reviewer.onReview = (input: any) => ({
      status: "verdict",
      approved: false,
      reason: "not proven",
      raw: `verdict: rejected\ntransition: ${input.transition}\nprofile: ${input.profile}\nreason: not proven\nunmet: evidence`,
      profile: input.profile,
      transition: input.transition,
      reviewerSessionID: "ses_reviewer_fake",
    });
    await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });

    const lines = readFileSync(path, "utf8").trim().split("\n").map((line: string) => JSON.parse(line));
    const last = lines.at(-1);
    assert.equal(last.session_id, SID);
    assert.equal(last.goal_id, "g0001");
    assert.equal(last.transition, "active-complete");
    assert.equal(last.verdict, "rejected");
    assert.equal(last.unmet, "evidence");
    assert.equal(last.reviewer_session_id, "ses_reviewer_fake");
    assert.equal(last.reviewer_model, "opencode-go/grok-4.7#xhigh");
    assert.equal(typeof last.duration_ms, "number");
    assert.match(last.raw, /verdict: rejected/);

    const view = JSON.parse((await callTool(fx, "get_goal", {})).content);
    assert.equal(view.review_journal, path);

    // Pruning deletes only files older than the retention window.
    const old = journal.reviewJournalPath("ses_old_journal");
    writeFileSync(old, "{}\n", "utf8");
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    assert.equal((await journal.pruneReviews(14)) >= 1, true);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(path), true);
  } finally {
    fx.cleanup();
  }
});

test("pause and clear interrupt the running turn and a stale terminal does not re-arm", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective pause interrupt");
    await fx.scheduler.advance(3000);
    const promptsBefore = fx.session.promptCount(SID);
    assert.equal(promptsBefore, 1);

    await runCommand(fx, "pause");
    assert.equal(
      fx.ctx.interrupted.some((item: any) => item.sessionID === SID && item.resume === false),
      true,
      "pause interrupts the active turn",
    );

    // A turn that lands after the pause must not arm another continuation.
    await server.handleEvent(fx.ctx, fx.deps, {
      type: "session.execution.succeeded",
      durable: { seq: 11 },
      data: { sessionID: SID },
    });
    await fx.scheduler.advance(3000);
    assert.equal(fx.session.promptCount(SID), promptsBefore, "no continuation after pause");
    assert.equal(liveRecord(fx).status, "paused");
    // Pause is its own state: the interrupt's terminal must not stamp a stop
    // reason over it.
    assert.equal(liveRecord(fx).stop_reason, null);

    // Clear is the escape hatch: it interrupts too, and stops dispatch.
    await runCommand(fx, "resume");
    await runCommand(fx, "clear");
    assert.equal(fx.ctx.interrupted.filter((item: any) => item.sessionID === SID).length >= 2, true);
    assert.equal(liveRecord(fx), null);
  } finally {
    fx.cleanup();
  }
});

test("blocking stops auto-driving and prints the reason, leaving the turn to finish", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective blocked interrupt");
    fx.reviewer.onReview = approveReview();
    await callTool(fx, "update_goal", {
      status: "blocked",
      reason: "Operator decision required: choose the production port.",
    });
    const record = liveRecord(fx);
    assert.equal(record.status, "blocked");
    assert.equal(record.continuing, false);
    assert.equal(record.blocked_reason, "Operator decision required: choose the production port.");

    const blockedLine = fx.emitted().find((line) => line.startsWith("goal blocked — "));
    assert.ok(blockedLine, "the operator sees the block");
    assert.match(blockedLine as string, /choose the production port/);

    // The turn that reported the block is left to finish, so its tool result
    // reaches the agent; the record state alone stops the loop.
    assert.equal(fx.ctx.interrupted.length, 0, "blocking must not interrupt the reporting turn");

    // The agent may still resolve it later through the reviewed unblock.
    fx.reviewer.onReview = approveReview();
    await callTool(fx, "update_goal", { status: "active", reason: "The operator chose port 8080." });
    assert.equal(liveRecord(fx).status, "active");
    assert.equal(liveRecord(fx).continuing, true);
    assert.match(fx.last().description, /^goal unblocked — /);
  } finally {
    fx.cleanup();
  }
});

test("a deleted session releases its reviewer before the keys are swept", async () => {
  const fx = await fixture();
  try {
    const folder = join(fx.dir, "spec-records", "T1-delete");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "T1-delete.md"), "SPEC-DEL-1", "utf8");
    writeFileSync(join(folder, "T1-delete.implementation-decisions.md"), "LOG-DEL-1", "utf8");
    const evidence = join(folder, "evidence.txt");
    writeFileSync(evidence, "done\n", "utf8");
    await createViaCommand(fx, "objective delete");
    fx.reviewer.onReview = rejectReview("not proven");
    await callTool(fx, "update_goal", { status: "complete", evidence: "did it", evidence_path: evidence });
    assert.notEqual(fx.storage.raw(reviewerKey(SID)), undefined);

    await server.handleEvent(fx.ctx, fx.deps, { type: "session.deleted", data: { sessionID: SID } });
    assert.equal(fx.storage.raw(reviewerKey(SID)), undefined, "the reference is swept");
    assert.equal(fx.ctx.removed.includes("ses_reviewer_fake"), true, "the reviewer session is removed, not orphaned");
  } finally {
    fx.cleanup();
  }
});

test("clear on a foreign record refuses out loud", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective foreign clear");
    const record = liveRecord(fx);
    record.writer_pid = 999_999_999; // a different, definitely-alive-looking pid
    fx.storage.seed(recordKey(SID, "g0001"), record);
    (fx.store as any).isForeign = () => true;
    await runCommand(fx, "clear");
    assert.match(fx.last().description, /^goal refused — foreign-writer/);
    assert.notEqual(liveRecord(fx), null, "a foreign record is never cleared");
  } finally {
    fx.cleanup();
  }
});

test("an ignored pause and a refused foreign clear do not interrupt a session", async () => {
  const fx = await fixture();
  try {
    // No live goal: the pause is ignored, so nothing may be stopped.
    await runCommand(fx, "pause");
    assert.equal(fx.ctx.interrupted.length, 0, "an ignored pause must not stop a turn");

    // A foreign record: the clear is refused and must not touch the session.
    await createViaCommand(fx, "objective foreign stop");
    (fx.store as any).isForeign = () => true;
    await runCommand(fx, "clear");
    assert.match(fx.last().description, /^goal refused — foreign-writer/);
    assert.equal(fx.ctx.interrupted.length, 0, "a refused clear must not stop a turn");
    assert.notEqual(liveRecord(fx), null);
  } finally {
    fx.cleanup();
  }
});

test("pre-flight evidence refusals do not count toward the streak, reviewer refusals do", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective preflight streak");
    const missing = join(fx.dir, "does-not-exist.txt");
    for (const attempt of [1, 2]) {
      const refused = await callTool(fx, "update_goal", {
        status: "complete",
        evidence: "did it",
        evidence_path: missing,
      });
      assert.match(refused.content, /^goal refused — evidence-unreadable/);
      // Cheap, immediately fixable: not a failed review, so no streak.
      assert.equal(liveRecord(fx).refusal_count, 0, `attempt ${attempt} must not count`);
    }
    let record = liveRecord(fx);
    assert.equal(record.stop_reason, null);
    assert.equal(record.continuing, true);
    assert.equal(record.refusal_reason, null);
    assert.equal(fx.reviewer.calls.length, 0, "a pre-flight refusal never reaches the reviewer");

    // The reviewer's own refusals still count toward the stop.
    fx.reviewer.onReview = rejectReview("not proven");
    await callTool(fx, "update_goal", { status: "complete", evidence: "did it", evidence_path: evidenceFixture(fx) });
    record = liveRecord(fx);
    assert.equal(record.refusal_count, 1);
    assert.equal(record.stop_reason, null);
  } finally {
    fx.cleanup();
  }
});

test("a verdict that arrives after the goal was cleared does not print a refusal", async () => {
  const fx = await fixture();
  try {
    await createViaCommand(fx, "objective stale review");
    const linesBefore = fx.emitted().length;
    fx.reviewer.onReview = async (input: any) => {
      // The operator clears the goal while the reviewer is still thinking.
      await runCommand(fx, "clear");
      return {
        status: "unparseable",
        approved: false,
        reason: "the verdict did not match the grammar",
        raw: "verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: ok\nunmet: none\nplus a stray line",
        profile: input.profile,
        transition: input.transition,
        reviewerSessionID: "ses_reviewer_fake",
      };
    };
    const result = await callTool(fx, "update_goal", {
      status: "complete",
      evidence: "did it",
      evidence_path: evidenceFixture(fx),
    });
    // The model is told why nothing applied...
    assert.match(result.content, /^goal refused — illegal-transition: stale review/);
    // ...but the operator is not shown a refusal right after their own clear.
    const after = fx.emitted().slice(linesBefore);
    assert.equal(
      after.some((line) => line.startsWith("goal refused")),
      false,
      "no refusal line after the operator cleared the goal",
    );
    assert.equal(after.some((line) => line === "goal cleared"), true);
    assert.equal(liveRecord(fx), null);
  } finally {
    fx.cleanup();
  }
});

test("an unsupported /goal subcommand is named, never treated as an objective", async () => {
  const fx = await fixture();
  try {
    // No goal yet: `/goal stop` must not create a goal called "stop".
    await runCommand(fx, "stop");
    assert.match(fx.last().description, /^goal: unknown subcommand 'stop'/);
    assert.equal(liveRecord(fx), null, "no goal is created from a subcommand word");

    // With a live goal: the same message instead of a goal-exists refusal.
    await createViaCommand(fx, "objective subcommand");
    await runCommand(fx, "stop");
    assert.match(fx.last().description, /^goal: unknown subcommand 'stop'/);
    assert.equal(liveRecord(fx).objective, "objective subcommand");

    // Aliases and help stay informative.
    await runCommand(fx, "list");
    assert.match(fx.last().description, /objective subcommand/);
    await runCommand(fx, "status");
    assert.match(fx.last().description, /objective subcommand/);
    await runCommand(fx, "help");
    assert.match(fx.last().description, /^goal: unknown subcommand 'help'/);

    // A short non-command word is not a subcommand, but it cannot be a goal either.
    await runCommand(fx, "cleanup");
    assert.match(fx.last().description, /^goal refused — objective-invalid/);
    // A short task statement is accepted: the rule is "not a bare word".
    await runCommand(fx, "clear");
    await runCommand(fx, "fix bug");
    assert.match(fx.last().description, /^goal set — fix bug/);
    // A full sentence sets a goal once the slot is free.
    await runCommand(fx, "clear");
    await runCommand(fx, "clean up the build directory");
    assert.match(fx.last().description, /^goal set — clean up the build directory/);
  } finally {
    fx.cleanup();
  }
});
