// Runs the plugin's test suite against this checkout, portable across shells.
// The tests import the plugin through ESTATE_GOAL_DIR, so point it at this package.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  ["--test", "test/state.test.ts", "test/continuation.test.ts", "test/server.test.ts", "test/verifier.test.ts", "test/assets.test.ts"],
  { cwd: packageRoot, stdio: "inherit", env: { ...process.env, ESTATE_GOAL_DIR: packageRoot } },
);
process.exit(result.status ?? 1);
