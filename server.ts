// Entry shim. The plugin host probes `<dir>/server` before `<dir>/index`
// (packages/plugin/src/host.ts:17-43), so the directory's resolved entrypoint
// is this file; the implementation lives in src/server.ts.
export { default } from "./src/server.ts";
