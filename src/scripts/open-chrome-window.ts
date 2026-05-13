#!/usr/bin/env node
import { Effect } from "effect";
import { runScript, ScriptIo } from "./effect-services";

const json = process.argv.includes("--json");
const dryRun = process.argv.includes("--dry-run");
const url = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) || "about:blank";

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const [command, args] = yield* Effect.try({
    try: () => {
      if (process.platform === "darwin") return ["open", ["-na", "Google Chrome", "--args", url] as string[]] as const;
      if (process.platform === "linux") return ["google-chrome", [url] as string[]] as const;
      if (process.platform === "win32") return ["cmd", ["/c", "start", "chrome", url] as string[]] as const;
      throw new Error(`Unsupported platform: ${process.platform}`);
    },
    catch: (error) => error instanceof Error ? error : new Error(String(error))
  });
  if (json) {
    yield* io.stdout(`${JSON.stringify({ ok: true, dryRun, command, args, url }, null, 2)}\n`);
  }
  if (!dryRun) yield* io.execFileInherit(command, args);
}));
