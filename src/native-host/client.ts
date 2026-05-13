#!/usr/bin/env node
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Context, Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";

type ClientConfig = {
  method: string;
  params: Record<string, unknown>;
  useTcp: boolean;
  port: number;
  socketPath: string;
};

type ClientIoService = {
  readConfig: () => Effect.Effect<ClientConfig, Error>;
  request: (config: ClientConfig) => Effect.Effect<string, Error>;
  writeStdout: (text: string) => Effect.Effect<void, never>;
  writeStderr: (text: string) => Effect.Effect<void, never>;
};

class ClientIo extends Context.Tag("opzero/NativeHostClientIo")<ClientIo, ClientIoService>() {}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args[0] === "--") args.shift();
  const method = args[0] || "ping";
  const params = args[1] ? JSON.parse(args[1]) : {};
  return { method, params };
}

function requestNativeHost(config: ClientConfig) {
  return new Promise<string>((resolve, reject) => {
    const socket = config.useTcp ? net.connect(config.port, "127.0.0.1") : net.connect(config.socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: config.method, params: config.params })}\n`);
    });
    socket.on("data", (chunk) => {
      resolve(String(chunk));
      socket.end();
    });
    socket.on("error", reject);
  });
}

const ClientIoLive = Layer.succeed(ClientIo, {
  readConfig: () => Effect.try({
    try: () => {
      const { method, params } = parseArgs(process.argv);
      return {
        method,
        params,
        useTcp: process.platform === "win32" || process.env.OPZERO_CHROME_HOST_TRANSPORT === "tcp",
        port: Number(process.env.OPZERO_CHROME_HOST_PORT || 17365),
        socketPath: process.env.OPZERO_CHROME_HOST_SOCKET || path.join(os.tmpdir(), "opzero-chrome-native-host.sock")
      };
    },
    catch: toError
  }),
  request: (config: ClientConfig) => Effect.tryPromise({ try: () => requestNativeHost(config), catch: toError }),
  writeStdout: (text: string) => Effect.sync(() => { process.stdout.write(text); }),
  writeStderr: (text: string) => Effect.sync(() => { process.stderr.write(text); })
});

const program = Effect.gen(function* () {
  const io = yield* ClientIo;
  const config = yield* io.readConfig();
  const response = yield* io.request(config);
  yield* io.writeStdout(response);
});

NodeRuntime.runMain(Effect.provide(program, ClientIoLive));
