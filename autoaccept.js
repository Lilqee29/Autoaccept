// Antigravity Auto-Accept Daemon (Free & Open Source)
// Hooks into Antigravity via Chrome DevTools Protocol (CDP)
// Auto-accepts prompts, commands, and permission dialogs.

const PORT = process.env.ANTIGRAVITY_PORT || 9333;
const POLL_INTERVAL_MS = 2000;

console.log(`[AutoAccept] Starting daemon on CDP port ${PORT}...`);
console.log(`[AutoAccept] Antigravity must be running with: --remote-debugging-port=${PORT}`);

const activeSockets = new Map(); // targetId -> WebSocket

const ACCEPT_KEYWORDS = [
  'always allow', 'allow once', 'allow this conversation', 'allow',
  'run', 'accept all', 'accept', 'retry', 'proceed', 'confirm'
];

const EXEMPT_COMMANDS = [
  'rm -rf', 'del /f', 'git push', 'npm publish', 'format', 'drop database'
];

// ─── Injected DOM script (runs inside Antigravity UI) ────────────────
function buildInjectionScript() {
  return `(function() {
    if (window.__AA_CLEANUP) { try { window.__AA_CLEANUP(); } catch(e){} }
    window.__AA_OBSERVER_ACTIVE = true;

    var TARGETS = ['always allow', 'allow this conversation', 'allow once', 'allow', 'run', 'accept all', 'accept', 'retry', 'proceed', 'continue'];
    var BLOCKED = ${JSON.stringify(EXEMPT_COMMANDS)};
    var HAS_FILTERS = BLOCKED.length > 0;
    var SIDEBAR = '[role="tree"],[role="treeitem"],[role="listbox"],[role="option"],[role="menu"],nav,.monaco-list,[class*="conversation-list"],[class*="chat-history"]';

    var cooldown = new WeakMap();
    var clickCount = 0;

    // Floating badge
    var badge = document.getElementById('aa-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'aa-badge';
      badge.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;padding:6px 12px;border-radius:20px;background:rgba(16,185,129,0.95);color:#fff;font-family:system-ui,sans-serif;font-size:12px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.25);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;transition:all .2s';
      badge.innerHTML = '<span>⚡</span><span>AutoAccept: ON</span>';
      badge.onclick = function(e) {
        e.stopPropagation();
        window.__AA_PAUSED = !window.__AA_PAUSED;
        badge.style.background = window.__AA_PAUSED ? 'rgba(239,68,68,0.95)' : 'rgba(16,185,129,0.95)';
        badge.innerHTML = window.__AA_PAUSED ? '<span>⏸️</span><span>AutoAccept: PAUSED</span>' : '<span>⚡</span><span>AutoAccept: ON (' + clickCount + ')</span>';
      };
      (document.body || document.documentElement).appendChild(badge);
    }

    function visible(el) {
      return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
    }

    function labelOf(el) {
      return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    }

    function matchTarget(label) {
      if (!label || label.length > 40) return null;
      for (var i = 0; i < TARGETS.length; i++) {
        var t = TARGETS[i];
        if (label === t || label.indexOf(t + ' ') === 0 || label.indexOf(t + '\\n') === 0) {
          return t;
        }
      }
      return null;
    }

    function nearbyCommand(btn) {
      var el = btn;
      for (var up = 0; up < 7 && el && el !== document.body; up++, el = el.parentElement) {
        var blocks = el.querySelectorAll ? el.querySelectorAll('pre, code, [class*="terminal"], [class*="command"]') : [];
        if (blocks.length) return (blocks[blocks.length - 1].innerText || blocks[blocks.length - 1].textContent || '');
      }
      return '';
    }

    function isBlocked(cmd) {
      if (!cmd || !HAS_FILTERS) return false;
      var lower = cmd.toLowerCase();
      for (var i = 0; i < BLOCKED.length; i++) {
        if (lower.indexOf(BLOCKED[i].toLowerCase()) !== -1) return true;
      }
      return false;
    }

    function scan(root) {
      if (window.__AA_PAUSED) return false;

      // 1. Handle Antigravity Permission Modal Dialogs ("Yes, allow this time" + "Submit")
      var docText = (root.body ? root.body.innerText : (root.textContent || '')).toLowerCase();
      if (docText.indexOf('yes, allow') !== -1 || docText.indexOf('confirm the command is safe') !== -1) {
        var submitBtn = null;
        var allowOption = null;
        var candidates = root.querySelectorAll('button, [role="button"], div');
        for (var k = 0; k < candidates.length; k++) {
          var cEl = candidates[k];
          var cText = (cEl.innerText || cEl.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          if (!allowOption && (cText.indexOf('yes, allow this time') !== -1 || cText.indexOf('yes, and always allow') !== -1)) {
            allowOption = cEl;
          }
          if (cText === 'submit' || cText.indexOf('submit') === 0) {
            submitBtn = cEl;
          }
        }
        if (submitBtn) {
          var lastS = cooldown.get(submitBtn) || 0;
          if (Date.now() - lastS > 1500) {
            cooldown.set(submitBtn, Date.now());
            if (allowOption) {
              try { allowOption.click(); } catch(e){}
            }
            console.log('[AA] Auto-clicking permission Submit button');
            clickCount++;
            submitBtn.focus();
            submitBtn.click();
            if (badge) {
              badge.style.transform = 'scale(1.15)';
              setTimeout(function() { badge.style.transform = ''; }, 200);
              badge.querySelector('span:last-child').textContent = 'AutoAccept: ON (' + clickCount + ')';
            }
            return true;
          }
        }
      }

      var nodes = root.querySelectorAll('button, [role="button"], a[role="button"], .monaco-button, [class*="btn"], [class*="button"]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;

        // Never click sidebar items
        if (el.closest && el.closest(SIDEBAR)) continue;

        // Skip chat trajectory accordion rows (like "Execute inspect.js" or "Worked for 10s")
        var cls = el.className || '';
        if (typeof cls === 'string' && (cls.indexOf('w-full') !== -1 && cls.indexOf('min-w-0') !== -1)) continue;

        var label = labelOf(el);
        if (label.indexOf('worked for') !== -1 || label.indexOf('thought for') !== -1 || label.indexOf('individual quota') !== -1) continue;

        var t = matchTarget(label);
        if (!t) continue;

        var last = cooldown.get(el) || 0;
        if (Date.now() - last < 3000) continue;

        if (HAS_FILTERS && (t === 'run' || t === 'always allow' || t === 'allow')) {
          var cmd = nearbyCommand(el);
          if (cmd && isBlocked(cmd)) {
            cooldown.set(el, Date.now() + 10000);
            console.log('[AA] BLOCKED exempt command:', cmd);
            continue;
          }
        }

        cooldown.set(el, Date.now());
        console.log('[AA] Auto-clicking:', t, '(' + label + ')');
        clickCount++;

        el.focus();
        el.click();

        if (badge) {
          badge.style.transform = 'scale(1.15)';
          setTimeout(function() { badge.style.transform = ''; }, 200);
          badge.querySelector('span:last-child').textContent = 'AutoAccept: ON (' + clickCount + ')';
        }
        return true;
      }

      // Shadow DOM support
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {
        if (all[j].shadowRoot && scan(all[j].shadowRoot)) return true;
      }
      return false;
    }

    var mo = new MutationObserver(function() { scan(document); });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    var tick = setInterval(function() { scan(document); }, 1000);

    window.__AA_CLEANUP = function() {
      mo.disconnect();
      clearInterval(tick);
      window.__AA_OBSERVER_ACTIVE = false;
    };

    scan(document);
    return 'installed';
  })()`;
}

// ─── CDP Target Management ──────────────────────────────────────────
async function fetchTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function attachTarget(target) {
  const { id, title, url, webSocketDebuggerUrl } = target;
  if (!webSocketDebuggerUrl || activeSockets.has(id)) return;

  try {
    const ws = new WebSocket(webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
      console.log(`[AutoAccept] ✓ Attached [${id.slice(0, 8)}] ${title || url || 'Workbench'}`);
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: 2,
        method: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
      }));
      ws.send(JSON.stringify({
        id: 3,
        method: 'Runtime.evaluate',
        params: { expression: buildInjectionScript(), userGesture: true }
      }));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) {
          console.log(`[AutoAccept] Sub-frame/panel attached in [${id.slice(0, 8)}]`);
          ws.send(JSON.stringify({
            id: Date.now(),
            sessionId: msg.params.sessionId,
            method: 'Runtime.evaluate',
            params: { expression: buildInjectionScript(), userGesture: true }
          }));
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args?.map(a => a.value || '').join(' ');
          if (text.includes('[AA]')) {
            console.log(`[Target ${id.slice(0, 8)}] ${text}`);
          }
        }
      } catch {}
    });

    ws.addEventListener('close', () => {
      activeSockets.delete(id);
      console.log(`[AutoAccept] Target [${id.slice(0, 8)}] closed.`);
    });

    ws.addEventListener('error', () => {
      activeSockets.delete(id);
    });

    activeSockets.set(id, ws);
  } catch (err) {
    console.error(`[AutoAccept] Error attaching ${id}:`, err.message);
  }
}

async function loop() {
  const targets = await fetchTargets();
  if (targets.length === 0) {
    if (activeSockets.size > 0) {
      console.log('[AutoAccept] Lost CDP connection. Waiting...');
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

// Start
loop();
