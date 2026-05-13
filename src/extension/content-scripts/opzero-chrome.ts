import { parseWithSchema, RuntimeMessageSchema, type CursorState } from "../../shared/extension-schemas";

(() => {
  const INSTANCE_ID = `${Date.now()}:${Math.random()}`;
  const ROOT_ID = "opzero-chrome-agent-overlay-root";
  const OLD_KEY = "__opChromeCursorOverlay";
  const topFrame = window.top === window.self;

  if (!topFrame) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "CONTENT_PING") sendResponse({ ok: true, frame: "child" });
      return false;
    });
    return;
  }

  type OverlayWindow = Window & { [OLD_KEY]?: { dispose: () => void; instanceId: string } };
  const overlayWindow = window as OverlayWindow;

  if (overlayWindow[OLD_KEY]?.dispose) overlayWindow[OLD_KEY].dispose();

  let root: HTMLDivElement | null = null;
  let shadow: ShadowRoot | null = null;
  let cursor: HTMLDivElement | null = null;
  let currentState: CursorState | null = null;
  let animationFrame: number | null = null;
  let currentPosition = { x: 0, y: 0 };
  let lastLocation = location.href;

  function ensureRoot() {
    if (root?.isConnected && shadow && cursor) return;
    root = document.getElementById(ROOT_ID) as HTMLDivElement | null;
    if (root) root.remove();
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.dataset.instanceId = INSTANCE_ID;
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.pointerEvents = "none";
    root.style.zIndex = "2147483646";
    root.style.contain = "layout style paint";
    (document.documentElement || document.body || document).appendChild(root);
    shadow = root.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      @media print { .cursor { display: none !important; } }
      .cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: 42px;
        height: 42px;
        transform: translate3d(-9999px, -9999px, 0);
        pointer-events: none;
        will-change: transform, opacity;
        opacity: 0;
        transition: opacity 120ms linear;
      }
      .cursor.visible { opacity: 1; }
      .cursor img {
        display: block;
        width: 42px;
        height: 42px;
        filter: drop-shadow(0 3px 8px rgba(0,0,0,.28));
      }
      .fallback {
        width: 22px;
        height: 22px;
        background: #111827;
        border: 2px solid #fff;
        clip-path: polygon(0 0, 0 100%, 35% 72%, 55% 100%, 75% 88%, 55% 61%, 100% 60%);
        filter: drop-shadow(0 3px 8px rgba(0,0,0,.28));
      }
    `;
    const nextCursor = document.createElement("div");
    nextCursor.className = "cursor";
    const img = document.createElement("img");
    img.alt = "";
    img.src = chrome.runtime.getURL("images/cursor-chat.svg");
    img.onerror = () => {
      nextCursor.textContent = "";
      const fallback = document.createElement("div");
      fallback.className = "fallback";
      nextCursor.appendChild(fallback);
    };
    nextCursor.appendChild(img);
    cursor = nextCursor;
    shadow.append(style, nextCursor);
  }

  function viewportSize() {
    const viewport = window.visualViewport;
    return {
      width: viewport?.width || window.innerWidth || document.documentElement.clientWidth,
      height: viewport?.height || window.innerHeight || document.documentElement.clientHeight
    };
  }

  function clampPoint(x: number, y: number) {
    const { width, height } = viewportSize();
    return {
      x: Math.max(0, Math.min(width - 1, x)),
      y: Math.max(0, Math.min(height - 1, y))
    };
  }

  function setPosition(x: number, y: number, visible: boolean) {
    ensureRoot();
    if (!cursor) return;
    const point = clampPoint(x, y);
    currentPosition = point;
    cursor.classList.toggle("visible", visible);
    cursor.style.transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.y)}px, 0)`;
  }

  function notifyArrival(state: CursorState | null) {
    if (!state?.cursor) return;
    chrome.runtime.sendMessage({
      type: "AGENT_CURSOR_ARRIVED",
      sessionId: state.sessionId,
      turnId: state.turnId,
      moveSequence: state.cursor.moveSequence
    }).catch(() => undefined);
  }

  function animateTo(state: CursorState) {
    if (!state.cursor) return;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    const target = clampPoint(Number(state.cursor.x) || 0, Number(state.cursor.y) || 0);
    const start = { ...currentPosition };
    const startedAt = performance.now();
    const duration = state.cursor.animateMovement === false ? 0 : 180;
    const tick = (time: number) => {
      const progress = duration ? Math.min(1, (time - startedAt) / duration) : 1;
      const eased = 1 - Math.pow(1 - progress, 3);
      const x = start.x + (target.x - start.x) * eased;
      const y = start.y + (target.y - start.y) * eased;
      setPosition(x, y, true);
      if (progress < 1) {
        animationFrame = requestAnimationFrame(tick);
      } else {
        animationFrame = null;
        notifyArrival(state);
      }
    };
    animationFrame = requestAnimationFrame(tick);
  }

  function render(state: CursorState | null) {
    currentState = state || null;
    ensureRoot();
    if (!state?.cursor || state.isVisible === false || state.cursor.visible === false) {
      cursor?.classList.remove("visible");
      return;
    }
    animateTo(state);
  }

  function requestInitialState() {
    chrome.runtime.sendMessage({ type: "GET_AGENT_CURSOR_STATE" }, (response: { state?: unknown } | undefined) => {
      if (chrome.runtime.lastError) return;
      const state = response?.state ? parseWithSchema(RuntimeMessageSchema, { type: "AGENT_CURSOR_STATE", state: response.state }) : null;
      if (state?.type === "AGENT_CURSOR_STATE") render(state.state);
    });
  }

  function dispose() {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    root?.remove();
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onResize);
  }

  function onResize() {
    if (currentState?.cursor) setPosition(currentState.cursor.x, currentState.cursor.y, currentState.cursor.visible !== false);
  }

  function observeDomReady() {
    if (document.documentElement || document.body) {
      ensureRoot();
      return;
    }
    const observer = new MutationObserver(() => {
      if (document.documentElement || document.body) {
        observer.disconnect();
        ensureRoot();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  function observeLocation() {
    const check = () => {
      if (lastLocation !== location.href) {
        lastLocation = location.href;
        requestInitialState();
      }
    };
    if ("navigation" in window) {
      window.navigation.addEventListener("navigate", () => setTimeout(check, 0));
      window.navigation.addEventListener("currententrychange", check);
    }
    setInterval(check, 1000);
  }

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const parsed = parseWithSchema(RuntimeMessageSchema, message);
    if (parsed?.type === "CONTENT_PING") {
      sendResponse({ ok: true, frame: "top", instanceId: INSTANCE_ID });
      return false;
    }
    if (parsed?.type === "AGENT_CURSOR_STATE") {
      render(parsed.state);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  overlayWindow[OLD_KEY] = { dispose, instanceId: INSTANCE_ID };
  window.addEventListener("resize", onResize, { passive: true });
  window.visualViewport?.addEventListener("resize", onResize, { passive: true });
  observeDomReady();
  observeLocation();
  requestInitialState();
})();
