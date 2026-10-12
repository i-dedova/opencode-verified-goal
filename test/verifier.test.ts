// R-014, R-015, R-020, R-023, R-024, R-026 — verdict parsing and reviewer
// session lifecycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeCtx, loadPlugin } from "./helpers.ts";

const verifier = await loadPlugin("verifier.ts");
const { parseVerdict, createReviewer, noteTextEnded, chunkForCompaction, VERIFIER_AGENT } = verifier;

const WELL_FORMED: Array<[string, string]> = [
  ["blocked-active", "ad-hoc"],
  ["active-complete", "ad-hoc"],
  ["paused-complete", "spec-backed"],
  ["blocked-complete", "spec-backed"],
];

test("the five well-formed verdict shapes parse", () => {
  for (const [transition, profile] of WELL_FORMED) {
    const raw = `verdict: approved\ntransition: ${transition}\nprofile: ${profile}\nreason: checklist satisfied\nunmet: none`;
    const parsed = parseVerdict(raw, transition, profile);
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.verdict.approved, true);
      assert.equal(parsed.verdict.reason, "checklist satisfied");
      assert.equal(parsed.verdict.unmet, "none");
    }
    const rejected = raw.replace("verdict: approved", "verdict: rejected").replace("unmet: none", "unmet: evidence missing; tests unrun");
    const rejectedParsed = parseVerdict(rejected, transition, profile);
    assert.equal(rejectedParsed.ok, true);
    if (rejectedParsed.ok) assert.equal(rejectedParsed.verdict.approved, false);
  }
});

test("two malformed variants and an empty response refuse as unparseable", () => {
  const transition = "active-complete";
  const profile = "ad-hoc";
  const cases: Array<[string, boolean]> = [
    // Missing the unmet line.
    ["verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: ok", false],
    // Wrong order.
    ["transition: active-complete\nverdict: approved\nprofile: ad-hoc\nreason: ok\nunmet: none", false],
    // Extra line.
    ["verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: ok\nunmet: none\nthanks", false],
    // Code-fenced.
    ["```\nverdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: ok\nunmet: none\n```", false],
    // Empty.
    ["   \n  ", true],
    ["", true],
  ];
  for (const [raw, empty] of cases) {
    const parsed = parseVerdict(raw, transition, profile);
    assert.equal(parsed.ok, false, `should refuse: ${JSON.stringify(raw)}`);
    if (!parsed.ok) assert.equal(parsed.empty, empty);
  }
});

test("a transition or profile value that does not match the request is unparseable", () => {
  const raw = "verdict: approved\ntransition: blocked-active\nprofile: ad-hoc\nreason: ok\nunmet: none";
  assert.equal(parseVerdict(raw, "active-complete", "ad-hoc").ok, false);
  const profileMismatch = "verdict: approved\ntransition: active-complete\nprofile: spec-backed\nreason: ok\nunmet: none";
  assert.equal(parseVerdict(profileMismatch, "active-complete", "ad-hoc").ok, false);
});

test("the reviewer is created once per goal and resumed on the next review", async () => {
  const ctx = new FakeCtx();
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  ctx.session.prompt = async (input: any) => {
    ctx.reviewerPrompts.push({ sessionID: input.sessionID, text: input.text, resume: input.resume });
    noteTextEnded("ses_reviewer_1", "partial thinking text");
    noteTextEnded(
      "ses_reviewer_1",
      "verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: checklist satisfied\nunmet: none",
    );
    return {};
  };
  const first = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(first.status, "verdict");
  assert.equal(first.approved, true);
  assert.equal(first.reason, "checklist satisfied");
  assert.deepEqual(ctx.switched, [{ sessionID: "ses_reviewer_1", agent: VERIFIER_AGENT }]);
  assert.deepEqual(ctx.switchedModels, [
    { sessionID: "ses_reviewer_1", model: { providerID: "opencode-go", id: "grok-4.7", variant: "xhigh" } },
  ]);
  // Kept for the goal's later reviews instead of removed.
  assert.equal(ctx.removed.length, 0);
  assert.equal(first.reviewerSessionID, "ses_reviewer_1");

  // A second review of the same goal resumes that session (the caller resolves
  // the durable reference and passes it in).
  const second = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    reuseSessionID: first.reviewerSessionID,
    payload: "delta only",
    tail: "tail",
  });
  assert.equal(second.status, "verdict");
  assert.equal(ctx.created.length, 1, "the second review must not create a session");
  assert.equal(ctx.switched.length, 2, "the reused session is re-pinned to the lane");
  assert.equal(ctx.reviewerPrompts.at(-1)?.sessionID, "ses_reviewer_1");
});

test("a lane without an opencode-go model fails closed before any session is created", async () => {
  const ctx = new FakeCtx();
  ctx.laneModel = { providerID: "opencode", id: "grok-4.7", variant: "xhigh" };
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.reason, /allowed lane model pin is required/);
  assert.equal(ctx.created.length, 0);
  assert.equal(ctx.removed.length, 0);
});

test("the temporary commandcode testing pin is allowed and switchModel carries it", async () => {
  const ctx = new FakeCtx();
  ctx.laneModel = { providerID: "commandcode", id: "inclusionai/ling-3.1-flash:free" };
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  ctx.session.prompt = async () => {
    noteTextEnded(
      "ses_reviewer_1",
      "verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: ok\nunmet: none",
    );
    return {};
  };
  await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.deepEqual(ctx.switchedModels, [
    { sessionID: "ses_reviewer_1", model: { providerID: "commandcode", id: "inclusionai/ling-3.1-flash:free" } },
  ]);
});

test("chunkForCompaction keeps messages inside the chunk budget and preserves order", () => {
  const encoder = new TextEncoder();
  const single = "y".repeat(250_000);
  const singleChunks = chunkForCompaction(single, 100_000);
  assert.equal(singleChunks.length, 3);
  for (const chunk of singleChunks) assert.equal(encoder.encode(chunk).byteLength <= 100_000, true);
  assert.equal(singleChunks.join("").replace(/\n/g, ""), single.replace(/\n/g, ""));

  const multiline = Array.from({ length: 4000 }, (_, index) => `line ${index} ${"z".repeat(80)}`).join("\n");
  const lineChunks = chunkForCompaction(multiline, 100_000);
  assert.equal(lineChunks.length > 1, true);
  for (const chunk of lineChunks) assert.equal(encoder.encode(chunk).byteLength <= 100_000, true);
  assert.equal(
    lineChunks.join("").replace(/\s+/g, ""),
    `${multiline}\n`.replace(/\s+/g, ""),
  );

  assert.deepEqual(chunkForCompaction("small payload", 100_000), ["small payload\n"]);
});

test("an over-budget payload is delivered as droppable messages through host compaction, never cut", async () => {
  const ctx = new FakeCtx();
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  const payload = Array.from({ length: 10_000 }, (_, index) => `evidence ${index} ${"x".repeat(60)}`).join("\n");
  const encoder = new TextEncoder();
  assert.equal(encoder.encode(payload).byteLength > 600_000, true);
  const verdict = "verdict: approved\ntransition: active-complete\nprofile: ad-hoc\nreason: compacted record ok\nunmet: none";
  ctx.session.prompt = async (input: any) => {
    ctx.reviewerPrompts.push({ sessionID: input.sessionID, text: input.text, resume: input.resume });
    if (input.text === "Reply with the single word: ready") noteTextEnded("ses_reviewer_1", "ready");
    if (input.text === "TAIL-WITH-GRAMMAR") noteTextEnded("ses_reviewer_1", verdict);
    return {};
  };
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload,
    tail: "TAIL-WITH-GRAMMAR",
  });
  assert.equal(outcome.status, "verdict");
  assert.equal(outcome.approved, true);
  const assetPrompts = ctx.reviewerPrompts.filter((item) => item.resume === false);
  assert.equal(assetPrompts.length > 1, true);
  for (const item of assetPrompts) assert.equal(encoder.encode(item.text).byteLength <= 100_000, true);
  assert.equal(
    assetPrompts.map((item) => item.text).join("").replace(/\s+/g, ""),
    payload.replace(/\s+/g, ""),
  );
  assert.equal(ctx.reviewerPrompts.at(-2)?.text, "Reply with the single word: ready");
  assert.equal(ctx.reviewerPrompts.at(-1)?.text, "TAIL-WITH-GRAMMAR");
  assert.deepEqual(ctx.compactions, [{ sessionID: "ses_reviewer_1" }]);
  assert.equal(ctx.reviewerPrompts.some((item) => item.text.includes("[truncated:")), false);
  // Answered: kept for this goal's later reviews.
  assert.equal(ctx.removed.length, 0);
});

test("when the explicit compaction request fails, the trigger still proceeds", async () => {
  const ctx = new FakeCtx();
  ctx.session.compact = async () => {
    throw new Error("compaction request unavailable (injected)");
  };
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  const payload = "x".repeat(700_000);
  const verdict = "verdict: rejected\ntransition: active-complete\nprofile: ad-hoc\nreason: evidence does not cover R-002\nunmet: R-002";
  ctx.session.prompt = async (input: any) => {
    ctx.reviewerPrompts.push({ sessionID: input.sessionID, text: input.text, resume: input.resume });
    if (input.text === "Reply with the single word: ready") noteTextEnded("ses_reviewer_1", "ready");
    if (input.text === "TAIL") noteTextEnded("ses_reviewer_1", verdict);
    return {};
  };
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload,
    tail: "TAIL",
  });
  assert.equal(outcome.status, "verdict");
  assert.equal(outcome.approved, false);
  assert.equal(ctx.reviewerPrompts.filter((item) => item.resume === false).length > 1, true);
  assert.equal(ctx.reviewerPrompts.at(-2)?.text, "Reply with the single word: ready");
  assert.equal(ctx.reviewerPrompts.at(-1)?.text, "TAIL");
  // No plugin-side cut exists; the runner's own overflow recovery handles a
  // context the provider rejects as too long.
  assert.equal(ctx.reviewerPrompts.some((item) => item.text.includes("[truncated:")), false);
  assert.equal(ctx.removed.length, 0);
});

test("a refusal verdict is returned with the reviewer's reason and the reviewer kept", async () => {
  const ctx = new FakeCtx();
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  ctx.session.prompt = async () => {
    noteTextEnded(
      "ses_reviewer_1",
      "verdict: rejected\ntransition: blocked-active\nprofile: ad-hoc\nreason: the impasse claim is only uncertainty\nunmet: genuine impasse",
    );
    return {};
  };
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "blocked-active",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(outcome.status, "verdict");
  assert.equal(outcome.approved, false);
  assert.equal(outcome.reason, "the impasse claim is only uncertainty");
  // A rejection is a normal answer: the reviewer stays for the next review.
  assert.equal(ctx.removed.length, 0);
});

test("a timeout removes the session and refuses with verifier-timeout", async () => {
  const ctx = new FakeCtx();
  ctx.session.wait = () => new Promise(() => {}); // never idle
  const reviewer = createReviewer(ctx as any, { timeoutMs: 40 });
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-blocked",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(outcome.status, "timeout");
  assert.equal(outcome.reviewerSessionID, "ses_reviewer_1", "the timeout names the session it abandoned");
  assert.deepEqual(ctx.removed, ["ses_reviewer_1"]);
});

test("an empty answer is unparseable with the literal-empty marker available", async () => {
  const ctx = new FakeCtx();
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  // The reviewer turn ends with no text at all.
  ctx.session.prompt = async () => {
    noteTextEnded("ses_reviewer_1", "");
    return {};
  };
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(outcome.status, "unparseable");
  assert.equal(outcome.raw, "");
  // The session answered, so it is kept even though the grammar failed.
  assert.equal(ctx.removed.length, 0);
});

test("a prompt failure refuses with verifier-error and still removes the session", async () => {
  const ctx = new FakeCtx();
  ctx.session.prompt = async () => {
    throw new Error("admission rejected");
  };
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  const outcome = await reviewer.review({
    sessionID: "ses_main",
    transition: "active-complete",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(outcome.status, "error");
  assert.match(outcome.reason, /admission rejected/);
  assert.deepEqual(ctx.removed, ["ses_reviewer_1"]);
});

test("reviewer capabilities come from the lane, never a runtime permission call", async () => {
  // The source contains no ctx.permission.rules call (R-016): the reviewer
  // object only ever touches session.create/switchAgent/prompt/wait/remove.
  const ctx = new FakeCtx();
  let permissionTouched = false;
  (ctx as any).permission = {
    get rules() {
      permissionTouched = true;
      throw new Error("permission.rules must not be called");
    },
  };
  const reviewer = createReviewer(ctx as any, { timeoutMs: 500 });
  ctx.session.prompt = async () => {
    noteTextEnded(
      "ses_reviewer_1",
      "verdict: approved\ntransition: active-blocked\nprofile: ad-hoc\nreason: ok\nunmet: none",
    );
    return {};
  };
  await reviewer.review({
    sessionID: "ses_main",
    transition: "active-blocked",
    profile: "ad-hoc",
    goalId: "g0001",
    assetFingerprint: "fp1",
    payload: "payload",
    tail: "tail",
  });
  assert.equal(permissionTouched, false);
});
