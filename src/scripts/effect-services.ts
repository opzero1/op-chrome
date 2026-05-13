import childProcess from "node:child_process";
import fs from "node:fs";
import { Context, Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

export type ScriptIoService = {
  exists: (file: string) => Effect.Effect<boolean, never>;
  readText: (file: string) => Effect.Effect<string, Error>;
  writeText: (file: string, text: string) => Effect.Effect<void, Error>;
  mkdir: (dir: string) => Effect.Effect<void, Error>;
  chmod: (file: string, mode: number) => Effect.Effect<void, Error>;
  readdir: (dir: string) => Effect.Effect<string[], Error>;
  execFile: (command: string, args: string[], options?: childProcess.ExecFileSyncOptionsWithStringEncoding) => Effect.Effect<string, Error>;
  execFileInherit: (command: string, args: string[]) => Effect.Effect<void, Error>;
  stdout: (text: string) => Effect.Effect<void, never>;
  stderr: (text: string) => Effect.Effect<void, never>;
};

export class ScriptIo extends Context.Tag("opzero/ScriptIo")<ScriptIo, ScriptIoService>() {}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}

export const ScriptIoLive = Layer.succeed(ScriptIo, {
  exists: (file: string) => Effect.sync(() => fs.existsSync(file)),
  readText: (file: string) => Effect.try({ try: () => fs.readFileSync(file, "utf8"), catch: toError }),
  writeText: (file: string, text: string) => Effect.try({ try: () => { fs.writeFileSync(file, text); }, catch: toError }),
  mkdir: (dir: string) => Effect.try({ try: () => { fs.mkdirSync(dir, { recursive: true }); }, catch: toError }),
  chmod: (file: string, mode: number) => Effect.try({ try: () => { fs.chmodSync(file, mode); }, catch: toError }),
  readdir: (dir: string) => Effect.try({ try: () => fs.readdirSync(dir), catch: toError }),
  execFile: (command: string, args: string[], options?: childProcess.ExecFileSyncOptionsWithStringEncoding) =>
    Effect.try({ try: () => String(childProcess.execFileSync(command, args, options)), catch: toError }),
  execFileInherit: (command: string, args: string[]) =>
    Effect.try({ try: () => { childProcess.execFileSync(command, args, { stdio: "inherit" }); }, catch: toError }),
  stdout: (text: string) => Effect.sync(() => { process.stdout.write(text); }),
  stderr: (text: string) => Effect.sync(() => { process.stderr.write(text); })
});

export function runScript<A>(program: Effect.Effect<A, Error, ScriptIo>) {
  NodeRuntime.runMain(Effect.provide(program, ScriptIoLive));
}

export function argValue(name: string, fallback?: string | null) {
  const prefix = `--${name}=`;
  const direct = process.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1];
  return fallback || null;
}
