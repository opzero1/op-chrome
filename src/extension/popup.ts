import { NativeHostStatusSchema, parseWithSchema, type NativeHostStatus } from "../shared/extension-schemas";

const statusPill = document.getElementById("status-pill") as HTMLSpanElement;
const summary = document.getElementById("summary") as HTMLParagraphElement;
const details = document.getElementById("details") as HTMLElement;
const hostName = document.getElementById("host-name") as HTMLElement;
const lastChecked = document.getElementById("last-checked") as HTMLElement;
const errorText = document.getElementById("error-text") as HTMLElement;
const version = document.getElementById("version") as HTMLElement;

version.textContent = `Version v${chrome.runtime.getManifest().version}`;

function formatTime(ms?: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function renderStatus(status: Partial<NativeHostStatus> = {}) {
  const connected = status.state === "connected";
  statusPill.className = `pill ${connected ? "connected" : "disconnected"}`;
  statusPill.textContent = connected ? "Connected" : "Disconnected";
  summary.textContent = connected ? "Control Chrome with Opzero Chrome." : "Install the native host to connect.";
  hostName.textContent = status.hostName || "-";
  lastChecked.textContent = formatTime(status.lastChecked);
  errorText.textContent = status.error || "-";
  details.hidden = connected && !status.error;
}

async function loadStoredStatus() {
  const { NATIVE_HOST_STATUS } = await chrome.storage.local.get("NATIVE_HOST_STATUS");
  const status = parseWithSchema(NativeHostStatusSchema, NATIVE_HOST_STATUS);
  if (status) renderStatus(status);
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" }, (response: { status?: unknown } | undefined) => {
    if (chrome.runtime.lastError) {
      renderStatus({ state: "disconnected", error: chrome.runtime.lastError.message, lastChecked: Date.now() });
      return;
    }
    renderStatus(parseWithSchema(NativeHostStatusSchema, response?.status) || { state: "disconnected", lastChecked: Date.now() });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  const status = parseWithSchema(NativeHostStatusSchema, changes.NATIVE_HOST_STATUS?.newValue);
  if (area === "local" && status) renderStatus(status);
});

loadStoredStatus().finally(refreshStatus);
