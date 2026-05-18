#!/usr/bin/env node
const require_NodeRuntime = require("../chunks/NodeRuntime-CfddDOOs.js");
let node_net = require("node:net");
node_net = require_NodeRuntime.__toESM(node_net);
let node_os = require("node:os");
node_os = require_NodeRuntime.__toESM(node_os);
let node_path = require("node:path");
node_path = require_NodeRuntime.__toESM(node_path);
let node_process = require("node:process");
node_process = require_NodeRuntime.__toESM(node_process);
//#region src/native-host/client.ts
var ClientIo = class extends require_NodeRuntime.Tag("opzero/NativeHostClientIo")() {};
function toError(error) {
	return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}
function parseArgs(argv) {
	const args = argv.slice(2);
	if (args[0] === "--") args.shift();
	return {
		method: args[0] || "ping",
		params: args[1] ? JSON.parse(args[1]) : {}
	};
}
function requestNativeHost(config) {
	return new Promise((resolve, reject) => {
		const socket = config.useTcp ? node_net.default.connect(config.port, "127.0.0.1") : node_net.default.connect(config.socketPath);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: config.method,
				params: config.params
			})}\n`);
		});
		socket.on("data", (chunk) => {
			resolve(String(chunk));
			socket.end();
		});
		socket.on("error", reject);
	});
}
var ClientIoLive = require_NodeRuntime.succeed(ClientIo, {
	readConfig: () => require_NodeRuntime.try_({
		try: () => {
			const { method, params } = parseArgs(node_process.default.argv);
			return {
				method,
				params,
				useTcp: node_process.default.platform === "win32" || node_process.default.env.OPZERO_CHROME_HOST_TRANSPORT === "tcp",
				port: Number(node_process.default.env.OPZERO_CHROME_HOST_PORT || 17365),
				socketPath: node_process.default.env.OPZERO_CHROME_HOST_SOCKET || node_path.default.join(node_os.default.tmpdir(), "opzero-chrome-native-host.sock")
			};
		},
		catch: toError
	}),
	request: (config) => require_NodeRuntime.tryPromise({
		try: () => requestNativeHost(config),
		catch: toError
	}),
	writeStdout: (text) => require_NodeRuntime.sync(() => {
		node_process.default.stdout.write(text);
	}),
	writeStderr: (text) => require_NodeRuntime.sync(() => {
		node_process.default.stderr.write(text);
	})
});
var program = require_NodeRuntime.gen(function* () {
	const io = yield* ClientIo;
	const config = yield* io.readConfig();
	const response = yield* io.request(config);
	yield* io.writeStdout(response);
});
require_NodeRuntime.runMain(require_NodeRuntime.provide(program, ClientIoLive));
//#endregion
