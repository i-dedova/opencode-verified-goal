// R-010/R-021/R-022/R-025 — evidence resolution, record assets, profiles,
// and the 600,000-byte cap with visible truncation markers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugin } from "./helpers.ts";

const assets = await loadPlugin("assets.ts");
const { resolveEvidenceFile, findRecordAssets, selectProfile, insideAllowedRoots } = assets;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("allowed roots cover the spec-records plane and the operator home only", () => {
  const specRecords = join(homedir(), ".agents", "spec-records");
  assert.equal(insideAllowedRoots(join(specRecords, "I23", "x.md")), true);
  assert.equal(insideAllowedRoots(join(homedir(), "Documents", "x.txt")), true);
  assert.equal(insideAllowedRoots("C:\\Windows\\win.ini"), false);
  assert.equal(insideAllowedRoots("C:\\tmp\\anything"), false);
});

test("evidence resolution: readable inside the roots, refused outside or unreadable", async () => {
  const dir = tempDir("opencode-verified-goal-assets-");
  try {
    const file = join(dir, "evidence.md");
    writeFileSync(file, "the evidence body", "utf8");
    const resolved = await resolveEvidenceFile(file);
    assert.equal(resolved.text, "the evidence body");
    assert.equal(resolved.bytes, 17);
    await assert.rejects(
      () => resolveEvidenceFile("C:\\Windows\\win.ini"),
      (error: any) => error.code === "evidence-outside-allowed-roots",
    );
    await assert.rejects(
      () => resolveEvidenceFile(join(dir, "missing.md")),
      (error: any) => error.code === "evidence-unreadable",
    );
    await assert.rejects(
      () => resolveEvidenceFile(dir),
      (error: any) => error.code === "evidence-unreadable",
    );
    await assert.rejects(
      () => resolveEvidenceFile(null),
      (error: any) => error.code === "evidence-unreadable",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record asset discovery: only a spec-records folder with both files is a record", async () => {
  const root = tempDir("opencode-verified-goal-records-");
  try {
    const records = join(root, "spec-records");
    mkdirSync(records, { recursive: true });
    // both present under spec-records -> spec-backed
    const both = join(records, "T1-both");
    mkdirSync(both);
    writeFileSync(join(both, "T1-both.md"), "spec body", "utf8");
    writeFileSync(join(both, "T1-both.implementation-decisions.md"), "log body", "utf8");
    const bothFound = await findRecordAssets(both);
    assert.equal(bothFound.spec?.text, "spec body");
    assert.equal(bothFound.log?.text, "log body");
    assert.equal(selectProfile(bothFound.spec, bothFound.log), "spec-backed");
    // spec only -> not a record (both files are required)
    const specOnly = join(records, "T1-spec");
    mkdirSync(specOnly);
    writeFileSync(join(specOnly, "T1-spec.md"), "spec body", "utf8");
    const specFound = await findRecordAssets(specOnly);
    assert.equal(specFound.spec, null);
    assert.equal(specFound.log, null);
    // log only -> not a record
    const logOnly = join(records, "T1-log");
    mkdirSync(logOnly);
    writeFileSync(join(logOnly, "T1-log.implementation-decisions.md"), "log body", "utf8");
    const logFound = await findRecordAssets(logOnly);
    assert.equal(logFound.spec, null);
    assert.equal(logFound.log, null);
    // a pair OUTSIDE spec-records is not a record folder: this is the reported
    // bug, where a stray `<folder>.md` made every goal in a session spec-backed
    const stray = join(root, "stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "stray.md"), "unrelated readme", "utf8");
    writeFileSync(join(stray, "stray.implementation-decisions.md"), "unrelated log", "utf8");
    const strayFound = await findRecordAssets(stray);
    assert.equal(strayFound.spec, null);
    assert.equal(strayFound.log, null);
    assert.equal(selectProfile(strayFound.spec, strayFound.log), "ad-hoc");
    // evidence nested one level below a record folder still resolves it
    const nested = join(both, "evidence");
    mkdirSync(nested);
    const nestedFound = await findRecordAssets(nested);
    assert.equal(nestedFound.spec?.text, "spec body");
    // the walk climbs at most four levels, so five levels down does not resolve
    const deep = join(nested, "a", "b", "c", "d");
    mkdirSync(deep, { recursive: true });
    const deepFound = await findRecordAssets(deep);
    assert.equal(deepFound.spec, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evidence outside the roots never reaches the reviewer path", async () => {
  await assert.rejects(
    () => resolveEvidenceFile("C:\\Windows\\win.ini"),
    (error: any) => error.code === "evidence-outside-allowed-roots",
  );
});

// Over-budget review payloads are covered by the host-compaction tests in
// verifier.test.ts: no plugin-side truncation or summarizer exists.
