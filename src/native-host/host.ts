#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Context, Effect, Layer } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { isJsonRpcRequest, parseJsonRpcMessage } from "../shared/rpc";

const DEFAULT_PORT = Number(process.env.OPZERO_CHROME_HOST_PORT || 17365);
const SOCKET_PATH = process.env.OPZERO_CHROME_HOST_SOCKET || path.join(os.tmpdir(), "opzero-chrome-native-host.sock");
const USE_TCP = process.platform === "win32" || process.env.OPZERO_CHROME_HOST_TRANSPORT === "tcp";

let nextExtensionId = 1;
const pendingExtensionRequests = new Map<number | string, { client: net.Socket; clientId: number | string | null; timer: NodeJS.Timeout }>();
const clients = new Set<net.Socket>();
type ParsedJsonRpcMessage = ReturnType<typeof parseJsonRpcMessage>;
type HostIoService = {
  log: (message: string) => Effect.Effect<void, never>;
  writeNativeMessage: (message: unknown) => Effect.Effect<void, never>;
  writeClientLine: (client: net.Socket, message: unknown) => Effect.Effect<void, never>;
};

class HostIo extends Context.Tag("opzero/NativeHostIo")<HostIo, HostIoService>() {}

const HostIoLive = Layer.succeed(HostIo, {
  log: (message: string) => Effect.sync(() => {
    if (process.env.OPZERO_CHROME_HOST_DEBUG) process.stderr.write(`[opzero-chrome-host] ${message}\n`);
  }),
  writeNativeMessage: (message: unknown) => Effect.sync(() => {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
  }),
  writeClientLine: (client: net.Socket, message: unknown) => Effect.sync(() => {
    client.write(`${JSON.stringify(message)}\n`);
  })
});

function runHostEffect<A>(program: Effect.Effect<A, never, HostIo>) {
  return Effect.runPromise(Effect.provide(program, HostIoLive));
}

function readNativeMessages(onMessage: (message: ParsedJsonRpcMessage) => void) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(parseJsonRpcMessage(JSON.parse(body.toString("utf8"))));
      } catch (error) {
        runHostEffect(Effect.flatMap(HostIo, (io) => io.log(`invalid native message: ${error instanceof Error ? error.message : String(error)}`)));
      }
    }
  });
}

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error");
  const code = typeof error === "object" && error != null && "code" in error && Number.isInteger(error.code) ? error.code : -32000;
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function handleExtensionRequest(message: ParsedJsonRpcMessage) {
  return Effect.gen(function* () {
    const io = yield* HostIo;
    if (!isJsonRpcRequest(message)) return;
    if (message.method === "ping") return yield* io.writeNativeMessage(rpcResult(message.id, "pong"));
    if (message.method === "getHostInfo") {
      return yield* io.writeNativeMessage(rpcResult(message.id, {
        name: "opzero-chrome-native-host",
        version: "0.1.2",
        pid: process.pid,
        transport: USE_TCP ? "tcp" : "unix",
        endpoint: USE_TCP ? `127.0.0.1:${DEFAULT_PORT}` : SOCKET_PATH
      }));
    }
    return yield* io.writeNativeMessage(rpcError(message.id, new Error(`Unsupported native host method: ${message.method}`)));
  });
}

function broadcast(message: unknown) {
  return Effect.gen(function* () {
    const io = yield* HostIo;
    for (const client of clients) yield* io.writeClientLine(client, message);
  });
}

function handleNativeMessage(message: ParsedJsonRpcMessage) {
  return Effect.gen(function* () {
    const io = yield* HostIo;
    if ("id" in message && ("result" in message || "error" in message)) {
    if (message.id == null) return;
    const pending = pendingExtensionRequests.get(message.id);
      if (!pending) return;
      pendingExtensionRequests.delete(message.id);
      clearTimeout(pending.timer);
      const response = message.error ? rpcError(pending.clientId, new Error(message.error.message)) : rpcResult(pending.clientId, message.result);
      yield* io.writeClientLine(pending.client, response);
      return;
    }
    if (isJsonRpcRequest(message) && "id" in message) {
      yield* handleExtensionRequest(message);
      return;
    }
    if (isJsonRpcRequest(message)) yield* broadcast(message);
  });
}

function parseClientLines(socket: net.Socket, onMessage: (message: ParsedJsonRpcMessage) => void) {
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    text += chunk;
    let index;
    while ((index = text.indexOf("\n")) !== -1) {
      const line = text.slice(0, index).trim();
      text = text.slice(index + 1);
      if (!line) continue;
      try {
        onMessage(parseJsonRpcMessage(JSON.parse(line)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runHostEffect(Effect.flatMap(HostIo, (io) => io.writeClientLine(socket, rpcError(null, new Error(`Invalid JSON: ${message}`)))));
      }
    }
  });
}

function attachClient(socket: net.Socket) {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  parseClientLines(socket, (message) => {
    runHostEffect(handleClientMessage(socket, message));
  });
}

function handleClientMessage(socket: net.Socket, message: ParsedJsonRpcMessage) {
  return Effect.gen(function* () {
    const io = yield* HostIo;
    if (!isJsonRpcRequest(message) || !("id" in message)) {
      yield* io.writeClientLine(socket, rpcError("id" in message ? message.id : null, new Error("Expected JSON-RPC request with id")));
      return;
    }
    if (message.method === "host.ping") {
      yield* io.writeClientLine(socket, rpcResult(message.id, "pong"));
      return;
    }
    const extensionId = nextExtensionId++;
    const timer = setTimeout(() => {
      pendingExtensionRequests.delete(extensionId);
      runHostEffect(Effect.flatMap(HostIo, (io) => io.writeClientLine(socket, rpcError(message.id, new Error(`Extension request ${message.method} timed out`)))));
    }, Number(process.env.OPZERO_CHROME_REQUEST_TIMEOUT_MS || 30000));
    pendingExtensionRequests.set(extensionId, { client: socket, clientId: message.id ?? null, timer });
    yield* io.writeNativeMessage({
      jsonrpc: "2.0",
      id: extensionId,
      method: message.method,
      params: message.params || {}
    });
  });
}

function startServer() {
  const server = net.createServer(attachClient);
  server.on("error", (error) => {
    runHostEffect(Effect.flatMap(HostIo, (io) => io.log(`server error: ${error.message}`)));
    process.exitCode = 1;
  });
  if (USE_TCP) {
    server.listen(DEFAULT_PORT, "127.0.0.1", () => runHostEffect(Effect.flatMap(HostIo, (io) => io.log(`listening on 127.0.0.1:${DEFAULT_PORT}`))));
    return;
  }
  try {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    server.listen(SOCKET_PATH, () => runHostEffect(Effect.flatMap(HostIo, (io) => io.log(`listening on ${SOCKET_PATH}`))));
  } catch (error) {
    runHostEffect(Effect.flatMap(HostIo, (io) => io.log(`socket setup failed: ${error instanceof Error ? error.message : String(error)}`)));
  }
}

NodeRuntime.runMain(Effect.gen(function* () {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(1));
  readNativeMessages((message) => runHostEffect(handleNativeMessage(message)));
  startServer();
  yield* Effect.never;
}).pipe(Effect.provide(HostIoLive)));
