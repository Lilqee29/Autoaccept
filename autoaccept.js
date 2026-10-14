// Antigravity Auto-Accept Daemon (Free & Open Source)
// Hooks into Antigravity via Chrome DevTools Protocol (CDP)
// Renders an in-app visual indicator badge and auto-accepts prompts and commands.

const PORT = process.env.ANTIGRAVITY_PORT || 9333;
const POLL_INTERVAL_MS = 2000;

console.log(`[AutoAccept] Starting daemon on CDP port ${PORT}...`);
console.log(`[AutoAccept] Note: Ensure Antigravity is running with: --remote-debugging-port=${PORT}`);

const activeSockets = new Map(); // targetId -> WebSocket

// Injected client script that runs inside Antigravity UI
const INJECTION_SCRIPT = `(() => {
  if (window.__antigravityAutoAcceptInstalled) {
    console.log("[AutoAccept] In-page script already loaded.");
    return "Already installed";
  }
  window.__antigravityAutoAcceptInstalled = true;

  // Configuration
  window.__antigravityEnabled = true;
  const ACCEPT_KEYWORDS = [
    "run",
    "accept",
    "always allow",
    "allow",
    "proceed",
    "continue",
    "confirm",
    "execute"
  ];

  const EXEMPT_COMMANDS = [
    "rm -rf",
    "del /f",
    "git push",
    "npm publish",
    "format",
    "drop database"
  ];

  // 1. Create a floating in-app badge in Antigravity UI
  let badge = document.getElementById("antigravity-autoaccept-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "antigravity-autoaccept-badge";
    badge.style.position = "fixed";
    badge.style.bottom = "16px";
    badge.style.right = "16px";
    badge.style.zIndex = "999999";
    badge.style.padding = "6px 12px";
    badge.style.borderRadius = "20px";
    badge.style.backgroundColor = "rgba(16, 185, 129, 0.95)";
    badge.style.color = "#ffffff";
    badge.style.fontFamily = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    badge.style.fontSize = "12px";
    badge.style.fontWeight = "600";
    badge.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.25)";
    badge.style.cursor = "pointer";
    badge.style.userSelect = "none";
    badge.style.display = "flex";
    badge.style.alignItems = "center";
    badge.style.gap = "6px";
    badge.style.transition = "all 0.2s ease";
    badge.innerHTML = "<span>⚡</span> <span>AutoAccept: ON</span>";

    badge.onclick = (e) => {
      e.stopPropagation();
      window.__antigravityEnabled = !window.__antigravityEnabled;
      if (window.__antigravityEnabled) {
        badge.style.backgroundColor = "rgba(16, 185, 129, 0.95)";
        badge.innerHTML = "<span>⚡</span> <span>AutoAccept: ON</span>";
      } else {
        badge.style.backgroundColor = "rgba(239, 68, 68, 0.95)";
        badge.innerHTML = "<span>⏸️</span> <span>AutoAccept: PAUSED</span>";
      }
    };

    document.body.appendChild(badge);
  }

  function findAssociatedCommand(button) {
    let current = button;
    let depth = 0;
    while (current && depth < 8 && current !== document.body) {
      const codeEls = current.querySelectorAll('code, pre, .terminal, .command-line, .code-snippet, [data-command]');
      for (const el of codeEls) {
        const text = (el.innerText || el.textContent || "").trim();
        if (text) return text;
      }
      current = current.parentElement;
      depth++;
    }
    return "";
  }

  function isExempt(cmd) {
    if (!cmd) return false;
    const lower = cmd.toLowerCase();
    return EXEMPT_COMMANDS.some(pattern => lower.includes(pattern.toLowerCase()));
  }

  function tryAcceptButtons() {
    if (!window.__antigravityEnabled) return;

    const candidates = document.querySelectorAll('button, [role="button"], .monaco-button, a.action-label');

    for (const btn of candidates) {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      if (btn.dataset.autoAccepted || btn.dataset.exempted) continue;

      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (!text) continue;

      const isMatch = ACCEPT_KEYWORDS.some(k => text === k || text.startsWith(k + " ") || text.endsWith(" " + k));

      if (isMatch) {
        const associatedCmd = findAssociatedCommand(btn);
        if (associatedCmd && isExempt(associatedCmd)) {
          btn.dataset.exempted = "true";
          console.log("[AutoAccept Exemption] Blocked sensitive command:", associatedCmd);
          return;
        }

        btn.dataset.autoAccepted = "true";
        console.log("[AutoAccept In-Page] Clicking auto-accept button:", text);

        // Flash badge to show visual feedback
        if (badge) {
          const orig = badge.style.transform;
          badge.style.transform = "scale(1.15)";
          setTimeout(() => { badge.style.transform = orig; }, 200);
        }

        btn.focus();
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();

        setTimeout(() => {
          delete btn.dataset.autoAccepted;
        }, 3000);
      }
    }
  }

  // Periodic and Mutation check
  tryAcceptButtons();

  const observer = new MutationObserver(() => {
    tryAcceptButtons();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'class', 'style']
  });

  setInterval(tryAcceptButtons, 1000);
  return "AutoAccept in-page engine active";
})()`;

async function fetchTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function attachTarget(target) {
  const { id, title, url, webSocketDebuggerUrl } = target;
  if (!webSocketDebuggerUrl) return;
  if (activeSockets.has(id)) return;

  try {
    const ws = new WebSocket(webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
      console.log(`[AutoAccept] Successfully attached to [${id.slice(0, 8)}] (${title || url || 'Workbench'})`);
      
      // Enable Runtime domain
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.enable"
      }));

      // In-page evaluate
      ws.send(JSON.stringify({
        id: 2,
        method: "Runtime.evaluate",
        params: {
          expression: INJECTION_SCRIPT,
          userGesture: true,
          awaitPromise: true
        }
      }));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params.args?.map(a => a.value || '').join(' ');
          if (text.includes("[AutoAccept In-Page]") || text.includes("[AutoAccept Exemption]")) {
            console.log(`[Target ${id.slice(0, 8)}] ${text}`);
          }
        }
      } catch {}
    });

    ws.addEventListener('close', () => {
      activeSockets.delete(id);
      console.log(`[AutoAccept] Target [${id.slice(0, 8)}] closed.`);
    });

    ws.addEventListener('error', (err) => {
      activeSockets.delete(id);
      console.error(`[AutoAccept] Error on target [${id.slice(0, 8)}]:`, err.message || err);
    });

    activeSockets.set(id, ws);
  } catch (err) {
    console.error(`[AutoAccept] Error creating socket for ${id}:`, err.message);
  }
}

async function loop() {
  const targets = await fetchTargets();

  if (targets.length === 0) {
    if (activeSockets.size > 0) {
      console.log("[AutoAccept] Lost connection to Antigravity CDP. Waiting for reconnection...");
      activeSockets.clear();
    }
  } else {
    for (const t of targets) {
      if (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') {
        attachTarget(t);
      }
    }
  }

  setTimeout(loop, POLL_INTERVAL_MS);
}

// Start loop
loop();
