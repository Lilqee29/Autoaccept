// Antigravity Auto-Accept Daemon (Free & Open Source)
// Uses Chrome DevTools Protocol (CDP) to automatically accept agent steps,
// terminal commands, file edits, and tool permissions across all agent conversations.

const PORT = process.env.ANTIGRAVITY_PORT || 9333;
const POLL_INTERVAL_MS = 2000;

console.log(`[AutoAccept] Starting daemon on CDP port ${PORT}...`);
console.log(`[AutoAccept] Note: Ensure Antigravity is running with: --remote-debugging-port=${PORT}`);

const activeSockets = new Map(); // targetId -> WebSocket

// Injected client script that runs inside Antigravity webviews & UI
const INJECTION_SCRIPT = `(() => {
  if (window.__antigravityAutoAcceptInstalled) return "Already installed";
  window.__antigravityAutoAcceptInstalled = true;

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

  function tryAcceptButtons() {
    // Find all potential clickable buttons, chips, or action elements
    const candidates = document.querySelectorAll('button, [role="button"], .monaco-button, a.action-label');
    
    for (const btn of candidates) {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      if (btn.dataset.autoAccepted) continue;

      const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
      if (!text) continue;

      // Check if button text matches any target keyword
      const isMatch = ACCEPT_KEYWORDS.some(keyword => {
        return text === keyword || text.startsWith(keyword + " ") || text.endsWith(" " + keyword);
      });

      if (isMatch) {
        btn.dataset.autoAccepted = "true";
        console.log("[AutoAccept In-Page] Clicking auto-accept button:", text);

        // Simulate complete user interaction
        btn.focus();
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        btn.click();

        // Cleanup marker after short delay in case button is re-rendered or reused
        setTimeout(() => {
          delete btn.dataset.autoAccepted;
        }, 3000);
      }
    }
  }

  // Initial check
  tryAcceptButtons();

  // Watch for any dynamic changes in DOM
  const observer = new MutationObserver(() => {
    tryAcceptButtons();
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'class', 'style']
  });

  // Heartbeat interval check every 1 second
  setInterval(tryAcceptButtons, 1000);

  return "Installed successfully";
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

    ws.on('open', () => {
      console.log(`[AutoAccept] Attached to target [${id.slice(0, 8)}] (${title || url || 'Workbench'})`);
      
      // Enable Runtime domain
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.enable"
      }));

      // Evaluate injection script
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

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Runtime.consoleAPICalled") {
          const text = msg.params.args?.map(a => a.value || '').join(' ');
          if (text.includes("[AutoAccept In-Page]")) {
            console.log(`[AutoAccept Target ${id.slice(0, 8)}] ${text}`);
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      activeSockets.delete(id);
    });

    ws.on('error', () => {
      activeSockets.delete(id);
    });

    activeSockets.set(id, ws);
  } catch (err) {
    console.error(`[AutoAccept] Error attaching to ${id}:`, err.message);
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
      // Connect to page and webview targets
      if (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') {
        attachTarget(t);
      }
    }
  }

  setTimeout(loop, POLL_INTERVAL_MS);
}

// Start loop
loop();
