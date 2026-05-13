#!/usr/bin/env node
import { Effect } from "effect";
import { runScript, ScriptIo } from "./effect-services";

type BrowserStatus = { id: string; name: string; installed: boolean };

const json = process.argv.includes("--json");

function commandExists(command: string) {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    const result = yield* Effect.either(
      process.platform === "win32"
        ? io.execFile("where", [command], { encoding: "utf8", stdio: "ignore" })
        : io.execFile("sh", ["-c", `command -v ${command}`], { encoding: "utf8", stdio: "ignore" })
    );
    return result._tag === "Right";
  });
}

function detect() {
  return Effect.gen(function* () {
    const io = yield* ScriptIo;
    if (process.platform === "darwin") {
      const chrome = yield* io.exists("/Applications/Google Chrome.app");
      const chromium = yield* io.exists("/Applications/Chromium.app");
      return [
        { id: "google-chrome", name: "Google Chrome", installed: chrome },
        { id: "chromium", name: "Chromium", installed: chromium }
      ];
    }
    if (process.platform === "linux") {
      const chrome = (yield* commandExists("google-chrome")) || (yield* commandExists("google-chrome-stable"));
      const chromium = (yield* commandExists("chromium")) || (yield* commandExists("chromium-browser"));
      return [
        { id: "google-chrome", name: "Google Chrome", installed: chrome },
        { id: "chromium", name: "Chromium", installed: chromium }
      ];
    }
    if (process.platform === "win32") {
      return [{ id: "google-chrome", name: "Google Chrome", installed: yield* commandExists("chrome") }];
    }
    return [];
  });
}

runScript(Effect.gen(function* () {
  const io = yield* ScriptIo;
  const browsers: BrowserStatus[] = yield* detect();
  const result = {
    ok: browsers.some((browser) => browser.installed),
    browsers
  };

  if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const browser of browsers) {
      yield* io.stdout(`${browser.name}: ${browser.installed ? "installed" : "not installed"}\n`);
    }
  }
  process.exitCode = result.ok ? 0 : 1;
}));
