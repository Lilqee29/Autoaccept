// Antigravity Auto-Accept Daemon (Free & Open Source)
// Hooks into Antigravity via Chrome DevTools Protocol (CDP)
// Auto-accepts prompts, commands, and permission dialogs.

const PORT = process.env.ANTIGRAVITY_PORT || 9333;
const POLL_INTERVAL_MS = 2000;

console.log(`[AutoAccept] Starting daemon on CDP port ${PORT}...`);
console.log(`[AutoAccept] Antigravity must be running with: --remote-debugging-port=${PORT}`);

const activeSockets = new Map(); // targetId -> WebSocket

const ACCEPT_KEYWORDS = [
  'run', 'accept', 'always allow', 'allow', 'proceed',
  'continue', 'confirm', 'execute', 'allow this conversation'
];

const EXEMPT_COMMANDS = [
  'rm -rf', 'del /f', 'git push', 'npm publish', 'format', 'drop database'
];

// ─── Injected DOM script (runs inside Antigravity UI) ────────────────
function buildInjectionScript() {
  return `(function() {
    if (window.__AA_OBSERVER_ACTIVE) return 'already-active';
    window.__AA_OBSERVER_ACTIVE = true;

    var BUTTON_TEXTS = ${JSON.stringify(ACCEPT_KEYWORDS)};
    var BLOCKED = ${JSON.stringify(EXEMPT_COMMANDS)};
    var HAS_FILTERS = BLOCKED.length > 0;

    // Sidebar guard — don't click conversation titles that contain "Run" etc.
    var AMBIGUOUS = { 'run':1, 'accept':1, 'allow':1, 'retry':1, 'continue':1 };
    var SIDEBAR_SEL = '[role="tree"],[role="treeitem"],[role="listbox"],[role="option"],.conversation-list,[class*="conversation-list"],[class*="trajectory"],[class*="history"],[class*="chat-history"],[class*="past-chat"],nav,[role="navigation"],[role="menu"]';

    function isSidebar(el) {
      if (!el || !el.closest) return false;
      if (el.closest(SIDEBAR_SEL)) return true;
      var cls = el.className || '';
      if (typeof cls === 'string' && cls.indexOf('select-none') !== -1 && cls.indexOf('cursor-pointer') !== -1 && cls.indexOf('rounded') !== -1) {
        return true;
      }
      var p = el.parentElement;
      for (var up = 0; up < 6 && p && p !== document.body; up++) {
        var pc = p.className || '';
        var scrollable = (typeof pc === 'string' && (pc.indexOf('overflow-y') !== -1 || pc.indexOf('overflow-auto') !== -1));
        if (!scrollable) {
          try { var cs = getComputedStyle(p); scrollable = (cs.overflowY === 'auto' || cs.overflowY === 'scroll'); } catch(e) {}
        }
        if (scrollable && p.children.length >= 3) return true;
        p = p.parentElement;
      }
      return false;
    }

    function getCommandText(el) {
      var c = el;
      for (var d = 0; d < 8 && c && c !== document.body; d++) {
        var codes = c.querySelectorAll('code, pre, .terminal, [data-command]');
        for (var i = 0; i < codes.length; i++) {
          var t = (codes[i].innerText || '').trim();
          if (t) return t;
        }
        c = c.parentElement;
      }
      return '';
    }

    function isBlocked(cmdText) {
      if (!cmdText || !HAS_FILTERS) return false;
      var lower = cmdText.toLowerCase();
      for (var i = 0; i < BLOCKED.length; i++) {
        if (lower.indexOf(BLOCKED[i].toLowerCase()) !== -1) return true;
      }
      return false;
    }

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
        badge.innerHTML = window.__AA_PAUSED ? '<span>⏸️</span><span>AutoAccept: PAUSED</span>' : '<span>⚡</span><span>AutoAccept: ON</span>';
      };
      (document.body || document.documentElement).appendChild(badge);
    }

    var COOLDOWN = {};
    var clickCount = 0;

    function scan() {
      if (window.__AA_PAUSED) return;
      var now = Date.now();
      var els = document.querySelectorAll('button, [role="button"], .monaco-button, a.action-label');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (el.offsetParent === null) continue;

        var raw = (el.innerText || el.textContent || '').trim();
        var text = raw.toLowerCase();
        if (!text || text.length > 40) continue;

        var matched = false;
        for (var j = 0; j < BUTTON_TEXTS.length; j++) {
          if (text === BUTTON_TEXTS[j] || text.startsWith(BUTTON_TEXTS[j] + ' ') || text.endsWith(' ' + BUTTON_TEXTS[j])) {
            matched = true; break;
          }
        }
        if (!matched) continue;

        // Guard: skip sidebar/list items
        if (AMBIGUOUS[text] && isSidebar(el)) continue;

        // Guard: check command exemptions
        if (HAS_FILTERS) {
          var cmd = getCommandText(el);
          if (cmd && isBlocked(cmd)) {
            console.log('[AA] BLOCKED exempt command:', cmd);
            continue;
          }
        }

        // Cooldown dedup
        var key = raw + ':' + el.className;
        if (COOLDOWN[key] && now - COOLDOWN[key] < 5000) continue;
        COOLDOWN[key] = now;

        console.log('[AA] Clicking:', raw);
        el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        clickCount++;

        // Flash badge
        if (badge) {
          badge.style.transform = 'scale(1.15)';
          setTimeout(function() { badge.style.transform = ''; }, 200);
          badge.querySelector('span:last-child').textContent = 'AutoAccept: ON (' + clickCount + ')';
        }
      }
    }

    // MutationObserver for instant reaction
    window.__AA_OBSERVER = new MutationObserver(function() { scan(); });
    window.__AA_OBSERVER.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'class', 'style', 'aria-disabled']
    });

    // Fallback interval
    window.__AA_FALLBACK = setInterval(scan, 1500);

    window.__AA_CLEANUP = function() {
      if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; }
      if (window.__AA_FALLBACK) { clearInterval(window.__AA_FALLBACK); window.__AA_FALLBACK = null; }
      window.__AA_OBSERVER_ACTIVE = false;
    };

    scan();
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
        method: 'Runtime.evaluate',
        params: { expression: buildInjectionScript(), userGesture: true }
      }));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
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
