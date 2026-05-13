#!/usr/bin/env node
import { Effect } from "effect";
import { runScript, ScriptIo } from "./effect-services";

const json = process.argv.includes("--json");

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const [cmd, args] = process.platform === "win32"
    ? ["tasklist", [] as string[]] as const
    : ["pgrep", ["-fl", "Google Chrome|Chromium"] as string[]] as const;
  const output = yield* Effect.either(io.execFile(cmd, args, { encoding: "utf8" }));
  const processList = output._tag === "Right" ? output.right : "";
  const running = /chrome|chromium/i.test(processList);
  const result = {
    ok: running,
    status: running ? "running" : "not-running",
    browser: "Google Chrome",
    message: running ? "Chrome is running" : "Chrome is not running"
  };
  yield* io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
  process.exitCode = running ? 0 : 1;
}));
