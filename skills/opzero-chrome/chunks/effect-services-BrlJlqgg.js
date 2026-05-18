const require_NodeRuntime = require("./NodeRuntime-CfddDOOs.js");
let node_fs = require("node:fs");
node_fs = require_NodeRuntime.__toESM(node_fs);
let node_child_process = require("node:child_process");
node_child_process = require_NodeRuntime.__toESM(node_child_process);
//#region src/scripts/effect-services.ts
var ScriptIo = class extends require_NodeRuntime.Tag("opzero/ScriptIo")() {};
function toError(error) {
	return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}
var ScriptIoLive = require_NodeRuntime.succeed(ScriptIo, {
	exists: (file) => require_NodeRuntime.sync(() => node_fs.default.existsSync(file)),
	readText: (file) => require_NodeRuntime.try_({
		try: () => node_fs.default.readFileSync(file, "utf8"),
		catch: toError
	}),
	writeText: (file, text) => require_NodeRuntime.try_({
		try: () => {
			node_fs.default.writeFileSync(file, text);
		},
		catch: toError
	}),
	mkdir: (dir) => require_NodeRuntime.try_({
		try: () => {
			node_fs.default.mkdirSync(dir, { recursive: true });
		},
		catch: toError
	}),
	chmod: (file, mode) => require_NodeRuntime.try_({
		try: () => {
			node_fs.default.chmodSync(file, mode);
		},
		catch: toError
	}),
	readdir: (dir) => require_NodeRuntime.try_({
		try: () => node_fs.default.readdirSync(dir),
		catch: toError
	}),
	execFile: (command, args, options) => require_NodeRuntime.try_({
		try: () => String(node_child_process.default.execFileSync(command, args, options)),
		catch: toError
	}),
	execFileInherit: (command, args) => require_NodeRuntime.try_({
		try: () => {
			node_child_process.default.execFileSync(command, args, { stdio: "inherit" });
		},
		catch: toError
	}),
	stdout: (text) => require_NodeRuntime.sync(() => {
		process.stdout.write(text);
	}),
	stderr: (text) => require_NodeRuntime.sync(() => {
		process.stderr.write(text);
	})
});
function runScript(program) {
	require_NodeRuntime.runMain(require_NodeRuntime.provide(program, ScriptIoLive));
}
function argValue(name, fallback) {
	const prefix = `--${name}=`;
	const direct = process.argv.find((arg) => arg.startsWith(prefix));
	if (direct) return direct.slice(prefix.length);
	const index = process.argv.indexOf(`--${name}`);
	if (index !== -1) return process.argv[index + 1];
	return fallback || null;
}
//#endregion
Object.defineProperty(exports, "ScriptIo", {
	enumerable: true,
	get: function() {
		return ScriptIo;
	}
});
Object.defineProperty(exports, "argValue", {
	enumerable: true,
	get: function() {
		return argValue;
	}
});
Object.defineProperty(exports, "runScript", {
	enumerable: true,
	get: function() {
		return runScript;
	}
});
