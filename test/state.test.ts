// R-029 family, R-030, R-043(o) ownership — store-level behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MemoryStorage, loadPlugin, makeRecord } from "./helpers.ts";

const state = await loadPlugin("state.ts");
const { GoalStore, PLUGIN_CONSTANTS, currentKey, recordKey, seqKey } = state;

const SESSION = "ses_state_test";

function makeStore(storage: MemoryStorage, pid: number = process.pid) {
  return new GoalStore({ storage, pid, now: () => 5_000 });
}

async function withLiveChild<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  // A real live pid for foreign-writer tests; killed on the way out.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    return await fn(child.pid as number);
  } finally {
    child.kill();
  }
}

test("write and read a goal through the three key shapes", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const goalId = await store.allocateGoalId(SESSION);
  assert.equal(goalId, "g0001");
  const record = (await store.readGoal(SESSION, goalId)) as any;
  assert.equal(record, null);
  storage.seed(recordKey(SESSION, goalId), makeRecord({ goal_id: goalId }));
  await store.writeCurrent(SESSION, goalId);
  const { record: live, goalId: currentId } = await store.current(SESSION);
  assert.equal(currentId, "g0001");
  assert.equal(live?.objective, "prove the fixture objective");
  // The plugin writes unprefixed keys only; the host applies the namespace.
  assert.deepEqual(storage.keys(), [currentKey(SESSION), recordKey(SESSION, goalId), seqKey(SESSION)].sort());
});

test("the id high-water survives /goal clear and ids never repeat", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const first = await store.allocateGoalId(SESSION);
  storage.seed(recordKey(SESSION, first), makeRecord({ goal_id: first }));
  await store.writeCurrent(SESSION, first);
  // /goal clear removes the pointer and the live record, never :seq.
  await store.removeRecord(SESSION, first);
  await store.clearCurrent(SESSION);
  const second = await store.allocateGoalId(SESSION);
  assert.equal(first, "g0001");
  assert.equal(second, "g0002");
  assert.equal(storage.raw(seqKey(SESSION)), 2);
});

test("ids widen past g9999 without stopping", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  storage.seed(seqKey(SESSION), 9999);
  assert.equal(await store.allocateGoalId(SESSION), "g10000");
  assert.equal(await store.allocateGoalId(SESSION), "g10001");
});

test("malformed values are treated as no goal and logged without the raw value", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const lines: string[] = [];
  const log = await loadPlugin("log.ts");
  log.setLogSink((line: string) => lines.push(line));
  try {
    // A non-object value.
    storage.seed(recordKey(SESSION, "g0001"), "garbage-raw-string-xyz");
    await store.writeCurrent(SESSION, "g0001");
    const { record } = await store.current(SESSION);
    assert.equal(record, null);
    // An unknown record_version logs a version mismatch, not a parse error.
    storage.seed(recordKey(SESSION, "g0002"), makeRecord({ goal_id: "g0002", record_version: 7 }));
    await store.writeCurrent(SESSION, "g0002");
    const second = await store.current(SESSION);
    assert.equal(second.record, null);
    // A dangling pointer logs as dangling.
    await store.writeCurrent(SESSION, "g9999");
    const third = await store.current(SESSION);
    assert.equal(third.record, null);
    const joined = lines.join("\n");
    assert.match(joined, /malformed value/);
    assert.match(joined, /version mismatch/);
    assert.match(joined, /dangling pointer/);
    // No raw value or objective text in diagnostics (R-030).
    assert.equal(joined.includes("garbage-raw-string-xyz"), false);
    assert.equal(joined.includes("prove the fixture objective"), false);
    // Every diagnostic carries the key and a byte length.
    assert.match(joined, /key=goal:ses_state_test:g0001 .*bytes=\d+/);
  } finally {
    log.setLogSink(undefined);
  }
});

test("a pointer to a complete or inactive record is not a live goal", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  storage.seed(recordKey(SESSION, "g0001"), makeRecord({ goal_id: "g0001", status: "complete", active: false }));
  await store.writeCurrent(SESSION, "g0001");
  const { record } = await store.current(SESSION);
  assert.equal(record, null);
});

test("ownership: unowned and self are writable; a live foreign pid is refused", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  assert.equal(store.isForeign(makeRecord({ writer_pid: 0 }) as any), false);
  assert.equal(store.isForeign(makeRecord({ writer_pid: process.pid }) as any), false);
  await withLiveChild(async (foreignPid) => {
    const foreign = makeRecord({ writer_pid: foreignPid }) as any;
    assert.equal(store.isForeign(foreign), true);
    assert.throws(
      () => store.assertWritable(foreign),
      (error: any) => error.code === "foreign-writer",
    );
  });
});

test("a dead owner pid is taken over, and the taker's pid is set", () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const deadOwned = makeRecord({ writer_pid: 999_999_999 }) as any;
  assert.equal(store.isForeign(deadOwned), false);
  store.claim(deadOwned);
  assert.equal(deadOwned.writer_pid, process.pid);
});

test("listGoals sorts by created_at and skips non-record keys", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  storage.seed(recordKey(SESSION, "g0002"), makeRecord({ goal_id: "g0002", created_at: 100 }));
  storage.seed(recordKey(SESSION, "g0001"), makeRecord({ goal_id: "g0001", created_at: 200 }));
  storage.seed(seqKey(SESSION), 2);
  const goals = await store.listGoals(SESSION);
  assert.deepEqual(goals.map((goal: any) => goal.goal_id), ["g0002", "g0001"]);
});

test("sweepSession removes every key for the session, paginated", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  for (let index = 1; index <= 250; index += 1) {
    storage.seed(recordKey(SESSION, `g${String(index).padStart(4, "0")}`), makeRecord({ goal_id: `g${index}` }));
  }
  storage.seed(seqKey(SESSION), 250);
  await store.writeCurrent(SESSION, "g0250");
  storage.seed(recordKey("ses_other", "g0001"), makeRecord({ goal_id: "g0001" }));
  const removed = await store.sweepSession(SESSION);
  assert.equal(removed, 252); // 250 records + seq + current
  assert.deepEqual(storage.keys(), [recordKey("ses_other", "g0001")]);
});

test("listStoredSessions and listCurrentPointers enumerate every session", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  storage.seed(recordKey("ses_a", "g0001"), makeRecord({ goal_id: "g0001" }));
  await store.writeCurrent("ses_a", "g0001");
  storage.seed(seqKey("ses_b"), 4);
  await store.writeCurrent("ses_b", "g0004");
  const sessions = await store.listStoredSessions();
  assert.deepEqual([...sessions].sort(), ["ses_a", "ses_b"]);
  const pointers = await store.listCurrentPointers();
  assert.deepEqual([...pointers].sort(), ["ses_a", "ses_b"]);
});

test("writeRecord refreshes updated_at and preserves the object identity", async () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const record = makeRecord({ updated_at: 1 }) as any;
  await store.writeRecord(SESSION, record);
  assert.equal(record.updated_at, 5_000);
  assert.equal((storage.raw(recordKey(SESSION, "g0001")) as any).updated_at, 5_000);
});

test("the plugin constants are the fixed values", () => {
  assert.deepEqual(PLUGIN_CONSTANTS, {
    min_continue_interval_ms: 3000,
    verifier_timeout_ms: 120000,
    max_asset_bytes: 600000,
    lock_acquire_timeout_ms: 2000,
    no_progress_limit: 3,
    submit_failure_limit: 3,
    verifier_refusal_limit: 2,
    objective_min_chars: 4,
  });
});
