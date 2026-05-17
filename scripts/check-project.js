#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/extension/manifest.json",
  "src/extension/images/icon-16.png",
  "src/extension/images/icon-32.png",
  "src/extension/images/icon-48.png",
  "src/extension/images/icon-128.png",
  "src/extension/background.ts",
  "src/extension/content-scripts/opzero-chrome.ts",
  "src/extension/popup.html",
  "src/extension/popup.ts",
  "src/native-host/host.ts",
  "src/native-host/client.ts",
  "src/scripts/install-native-host.ts",
  "src/scripts/installed-browsers.ts",
  "scripts/extension-id.example.json",
  "scripts/extension-id.store.json",
  "skills/opzero-chrome/SKILL.md",
  ".github/workflows/check.yml",
  ".github/workflows/release.yml",
  "vitest.config.ts",
  "tests/acceptance/distribution.test.ts",
  "dist/extension/manifest.json",
  "dist/extension/images/icon-16.png",
  "dist/extension/images/icon-32.png",
  "dist/extension/images/icon-48.png",
  "dist/extension/images/icon-128.png",
  "dist/extension/background.js",
  "dist/extension/content-scripts/opzero-chrome.js",
  "dist/native-host/host.js",
  "dist/native-host/client.js",
  "dist/scripts/install-native-host.js",
  "dist/scripts/extension-id.json",
  "dist/skill/opzero-chrome/SKILL.md",
  "dist/skill/opzero-chrome/native-host/opzero-chrome-host",
  "dist/skill/opzero-chrome/scripts/install-native-host.js",
  "src/scripts/check-native-host-manifest.ts",
  "README.md",
  "docs/DEVELOPER.md",
  "docs/PRIVACY.md",
  "docs/RELEASE.md"
];

const failures = [];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) failures.push(`Missing ${file}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist/extension/manifest.json"), "utf8"));
for (const permission of ["debugger", "nativeMessaging", "scripting", "downloads", "history", "tabGroups", "tabs"]) {
  if (!manifest.permissions.includes(permission)) failures.push(`Manifest missing ${permission}`);
}
if (manifest.manifest_version !== 3) failures.push("Manifest is not MV3");
if (manifest.background?.service_worker !== "background.js") failures.push("Manifest background service worker mismatch");
for (const [size, file] of Object.entries({ 16: "images/icon-16.png", 32: "images/icon-32.png", 48: "images/icon-48.png", 128: "images/icon-128.png" })) {
  if (manifest.icons?.[size] !== file) failures.push(`Manifest missing ${size}px icon`);
  if (manifest.action?.default_icon?.[size] !== file) failures.push(`Manifest action missing ${size}px icon`);
}

const extensionId = JSON.parse(fs.readFileSync(path.join(root, "dist/scripts/extension-id.json"), "utf8"));
if (extensionId.extensionId !== "dcnjjnecbhipdbngkhjppkckpkellmld") failures.push("Stable Chrome Web Store extension ID is not embedded");
if (extensionId.extensionHostName !== "com.opzero.chrome") failures.push("Stable extension host name mismatch");

for (const file of ["dist/native-host/host.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8").replace(/^#!.*\n/, "");
  new Function(source);
}

for (const file of ["dist/extension/background.js", "dist/extension/content-scripts/opzero-chrome.js", "dist/extension/popup.js"]) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  if (/\bimport\s/.test(source)) failures.push(`Extension bundle must be self-contained, found import in ${file}`);
}

if (failures.length) {
  process.stderr.write(`Project check failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Project check OK\n");
