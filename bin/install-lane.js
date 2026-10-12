// Copies the reviewer lane to its native OpenCode location, idempotently.
// Running it twice leaves exactly one lane: the file is rewritten only when its
// contents differ. Usage: node bin/install-lane.js [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LANE = "subagent_goal-verifier.md";
const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "agents", LANE);

// OpenCode reads agents from <config dir>/agents. The config dir is ~/.config/opencode
// unless OPENCODE_CONFIG_DIR says otherwise (also the seam the tests use).
const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
const target = join(configDir, "agents", LANE);
const dryRun = process.argv.includes("--dry-run");

if (!existsSync(source)) {
  console.error(`install-lane: lane asset missing at ${source}`);
  process.exit(1);
}

const incoming = readFileSync(source, "utf8");
const present = existsSync(target) ? readFileSync(target, "utf8") : null;

if (present === incoming) {
  console.log(`install-lane: ${target} is already current (nothing to do)`);
  process.exit(0);
}

if (dryRun) {
  console.log(`install-lane: would write ${target}`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`install-lane: ${present === null ? "installed" : "updated"} ${target}`);
console.log("install-lane: the reviewer lane carries its own deny-all permissions; leave it as generated.");
