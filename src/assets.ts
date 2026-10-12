// Asset resolution for the reviewer payload: the evidence file (R-010,
// R-025), the owning spec and implementation-decisions log when a record folder
// qualifies (R-021), and the reviewer profile selection (Target State). There is
// no byte cap or truncation marker any more: over-budget payloads go through the
// host's own compaction pipeline (see verifier.ts and D-065's spec delta).

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { GoalError } from "./state.ts";
import type { VerifyProfile } from "./state.ts";
import { log, logDebug } from "./log.ts";

/** Allowed evidence roots (Target State): the spec-records plane and the operator's home. */
export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.USERPROFILE && env.USERPROFILE.length > 0 ? env.USERPROFILE : homedir();
  return [join(home, ".agents", "spec-records"), home];
}

function normalize(path: string): string {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

export function insideAllowedRoots(path: string, roots: string[] = allowedRoots()): boolean {
  const target = normalize(path);
  return roots.some((root) => {
    const rootNorm = normalize(root);
    return target === rootNorm || target.startsWith(`${rootNorm}\\`) || target.startsWith(`${rootNorm}/`);
  });
}

export interface ResolvedEvidence {
  path: string;
  text: string;
  bytes: number;
}

/** R-010 pre-check and R-025 re-check share this resolution. */
export async function resolveEvidenceFile(rawPath: string | null): Promise<ResolvedEvidence> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new GoalError("evidence-unreadable", "evidence_path is required for completion");
  }
  const candidate = isAbsolute(rawPath) ? rawPath : resolve(rawPath);
  if (!insideAllowedRoots(candidate)) {
    throw new GoalError("evidence-outside-allowed-roots", "the path is outside the allowed roots");
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("not a file");
    const bytes = await readFile(candidate);
    return { path: candidate, text: bytes.toString("utf8"), bytes: bytes.byteLength };
  } catch (error) {
    throw new GoalError(
      "evidence-unreadable",
      error instanceof Error && error.message === "not a file" ? "the path is not a file" : "the path is not readable",
    );
  }
}

export interface NamedAsset {
  label: string;
  path: string;
  text: string;
}

export interface ReviewAssets {
  profile: VerifyProfile;
  spec: NamedAsset | null;
  log: NamedAsset | null;
  /** The capped payload blocks, in reviewer order (R-022). */
  blocks: string[];
}

/**
 * Record-folder convention: `<folder>/<folder>.md` is the spec and
 * `<folder>/<folder>.implementation-decisions.md` the log, and the folder must
 * live inside an estate `spec-records` tree. The walk starts at the evidence
 * file's directory (or the session directory) and climbs at most four levels,
 * staying inside the allowed roots.
 *
 * Both files and the `spec-records` segment are required (operator report: a
 * stray `<folder>.md` pair anywhere above the evidence made every goal in the
 * session "spec-backed" against an unrelated spec, so no completion could pass).
 * A folder without both files, or outside a `spec-records` tree, is not a record
 * folder and the review runs `ad-hoc`.
 */
export async function findRecordAssets(anchor: string | null): Promise<{ spec: NamedAsset | null; log: NamedAsset | null }> {
  let dir = anchor;
  for (let depth = 0; depth < 4 && dir; depth += 1) {
    if (!insideAllowedRoots(dir)) break;
    const name = basename(dir);
    const specPath = join(dir, `${name}.md`);
    const logPath = join(dir, `${name}.implementation-decisions.md`);
    let spec: NamedAsset | null = null;
    let recordLog: NamedAsset | null = null;
    try {
      const entries = new Set(await readdir(dir));
      const hasSpec = entries.has(`${name}.md`);
      const hasLog = entries.has(`${name}.implementation-decisions.md`);
      if (hasSpec && hasLog && insideRecordTree(dir)) {
        spec = { label: "owning spec", path: specPath, text: await readFile(specPath, "utf8") };
        recordLog = { label: "implementation-decisions log", path: logPath, text: await readFile(logPath, "utf8") };
      } else if (hasSpec || hasLog) {
        logDebug(
          `record folder rejected dir=${dir} spec=${hasSpec} log=${hasLog} record-tree=${insideRecordTree(dir)}`,
        );
      }
    } catch {
      // unreadable directory: try the parent
    }
    if (spec || recordLog) return { spec, log: recordLog };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { spec: null, log: null };
}

/** True when a path segment is the estate record root (`spec-records`). */
export function insideRecordTree(path: string): boolean {
  return path
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === "spec-records");
}

/** Profile selection (Target State, "Reviewer profiles"). */
export function selectProfile(spec: NamedAsset | null, log: NamedAsset | null): VerifyProfile {
  return spec !== null && log !== null ? "spec-backed" : "ad-hoc";
}

/**
 * FNV-1a over the inlined assets. The reviewer reuse is only valid while this
 * fingerprint matches: a changed spec or log forces a fresh review context.
 */
export function fingerprintAssets(parts: ReadonlyArray<string | null>): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = part ?? "\u0000";
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface AssetRequest {
  evidencePath: string | null;
  sessionDirectory: string | null;
}

/** Full reviewer asset assembly: discovery and profile selection. */
export async function resolveReviewAssets(request: AssetRequest): Promise<ReviewAssets> {
  const anchor = request.evidencePath ? dirname(request.evidencePath) : request.sessionDirectory;
  const { spec, log: recordLog } = await findRecordAssets(anchor);
  const profile = selectProfile(spec, recordLog);
  logDebug(
    `assets session=${request.sessionDirectory ?? "none"} profile=${profile} spec=${spec ? "present" : "absent"} ` +
      `log=${recordLog ? "present" : "absent"}`,
  );
  return { profile, spec, log: recordLog, blocks: [] };
}

// ------------------------------------------------------------------ fallback

// Over-budget review payloads are delivered through the host's own compaction
// pipeline (verifier.ts). No plugin-side summarizer or truncation exists.
