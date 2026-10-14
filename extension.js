const vscode = require('vscode');

let statusBarItem;
let ch1Timer = null;   // Channel 1: VS Code Commands polling
let ch2Timer = null;   // Channel 2: CDP DOM observer polling
const activeSockets = new Map();
let outputChannel;
let isEnabled = true;
let clickCount = 0;

// ─── Antigravity's internal accept command IDs ───────────────────────
const ALL_ACCEPT_COMMANDS = [
  'antigravity.agent.acceptAgentStep',
  'antigravity.terminalCommand.accept',
  'antigravity.terminalCommand.run',
  'antigravity.command.accept',
];

// Terminal-specific commands — skipped when command filters are active
const TERMINAL_COMMANDS = [
  'antigravity.terminalCommand.accept',
  'antigravity.terminalCommand.run',
  'antigravity.command.accept',
];

function getConfiguration() {
  const config = vscode.workspace.getConfiguration('antigravityAutoAccept');
  return {
    enabled: config.get('enabled', true),
    port: config.get('cdpPort', 9333),
    exemptCommands: config.get('exemptCommands', [
      'rm -rf', 'del /f', 'git push', 'npm publish', 'format', 'drop database'
    ]),
    allowedKeywords: config.get('allowedKeywords', [
      'run', 'accept', 'always allow', 'allow', 'proceed', 'continue', 'confirm', 'execute'
    ]),
    autoAcceptFileEdits: config.get('autoAcceptFileEdits', true),
    pollIntervalMs: config.get('pollIntervalMs', 500)
  };
}

function updateStatusBar() {
  if (!statusBarItem) return;
  if (isEnabled) {
    statusBarItem.text = `$(check) AutoAccept: ON (${clickCount})`;
    statusBarItem.tooltip = `AntiGravity AutoAccept is active.\n${clickCount} auto-accepted so far.\nClick to toggle.`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(circle-slash) AutoAccept: PAUSED`;
    statusBarItem.tooltip = `AntiGravity AutoAccept is paused.\nClick to resume.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

// ═══════════════════════════════════════════════════════════════════════
// CHANNEL 1: VS Code Commands API (Primary — fires Antigravity's native
// accept commands every 500ms. No CDP needed. Works instantly.)
// ═══════════════════════════════════════════════════════════════════════
let ch1Lock = false;

async function channel1Tick() {
  if (!isEnabled || ch1Lock) return;
  ch1Lock = true;

  const config = getConfiguration();
  const hasFilters = config.exemptCommands.length > 0;

  // Build the list of commands to fire this tick
  let commands = [...ALL_ACCEPT_COMMANDS];

  if (!config.autoAcceptFileEdits) {
    commands = commands.filter(c =>
      c !== 'antigravity.agent.acceptAgentStep' &&
      c !== 'antigravity.command.accept'
    );
  }

  // When filters are active, skip terminal commands (Channel 2 handles them
  // with DOM-based command text inspection for exemption matching)
  if (hasFilters) {
    commands = commands.filter(c => !TERMINAL_COMMANDS.includes(c));
  }

  for (const cmd of commands) {
    try {
      await vscode.commands.executeCommand(cmd);
      // Note: we don't increment clickCount here because executeCommand
      // resolves successfully even when nothing was pending to accept.
      // Ch2 DOM observer tracks actual clicks accurately.
    } catch {
      // Command doesn't exist or not available — expected
    }
  }

  ch1Lock = false;
}

// ═══════════════════════════════════════════════════════════════════════
// CHANNEL 2: CDP DOM Observer (Secondary — handles permission dialogs,
// "Always Allow", and custom button texts that aren't covered by Ch1)
// ═══════════════════════════════════════════════════════════════════════
function buildInjectionScript(config) {
  return `(function() {
    if (window.__AA_OBSERVER_ACTIVE) return 'already-active';
    window.__AA_OBSERVER_ACTIVE = true;

    var BUTTON_TEXTS = ${JSON.stringify(config.allowedKeywords)};
    var BLOCKED = ${JSON.stringify(config.exemptCommands)};
    var HAS_FILTERS = BLOCKED.length > 0;

    // Sidebar guard — ambiguous short words like "run" can be chat titles
    var AMBIGUOUS = { 'run':1, 'accept':1, 'allow':1, 'retry':1, 'continue':1 };
    var SIDEBAR_SEL = '[role="tree"],[role="treeitem"],[role="listbox"],[role="option"],.conversation-list,[class*="conversation-list"],[class*="trajectory"],[class*="history"],[class*="chat-history"],[class*="past-chat"],nav,[role="navigation"],[role="menu"]';

    function isSidebar(el) {
      if (!el || !el.closest) return false;
      if (el.closest(SIDEBAR_SEL)) return true;
      // Heuristic: select-none + cursor-pointer + rounded = list item, not button
      var cls = el.className || '';
      if (typeof cls === 'string' && cls.indexOf('select-none') !== -1 && cls.indexOf('cursor-pointer') !== -1 && cls.indexOf('rounded') !== -1) {
        return true;
      }
      // Scrollable parent with 3+ siblings = list container
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

    var COOLDOWN = {};
    function scan() {
      if (window.__AA_PAUSED || window.__AA_SWARM_PAUSED) return;
      var now = Date.now();
      var els = document.querySelectorAll('button, [role="button"], .monaco-button, a.action-label');
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (el.offsetParent === null) continue; // hidden

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

        // Guard: skip sidebar/list items for ambiguous keywords
        if (AMBIGUOUS[text] && isSidebar(el)) continue;

        // Guard: check command text exemptions
        if (HAS_FILTERS) {
          var cmd = getCommandText(el);
          if (cmd && isBlocked(cmd)) {
            console.log('[AA] BLOCKED exempt command:', cmd);
            continue;
          }
        }

        // Cooldown per DOM path
        var key = raw + ':' + el.className;
        if (COOLDOWN[key] && now - COOLDOWN[key] < 5000) continue;
        COOLDOWN[key] = now;

        console.log('[AA] Clicking:', raw);
        el.focus();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        window.__AA_CLICK_COUNT = (window.__AA_CLICK_COUNT || 0) + 1;
      }
    }

    // MutationObserver for instant reaction
    window.__AA_OBSERVER = new MutationObserver(function() { scan(); });
    window.__AA_OBSERVER.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['disabled', 'class', 'style', 'aria-disabled']
    });

    // Fallback interval
    window.__AA_FALLBACK_INTERVAL = setInterval(scan, 1500);

    // Cleanup function for re-injection
    window.__AA_CLEANUP = function() {
      if (window.__AA_OBSERVER) { window.__AA_OBSERVER.disconnect(); window.__AA_OBSERVER = null; }
      if (window.__AA_FALLBACK_INTERVAL) { clearInterval(window.__AA_FALLBACK_INTERVAL); window.__AA_FALLBACK_INTERVAL = null; }
      window.__AA_OBSERVER_ACTIVE = false;
    };

    scan();
    return 'installed';
  })()`;
}

async function fetchTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function attachTarget(target, config) {
  const { id, title, url, webSocketDebuggerUrl } = target;
  if (!webSocketDebuggerUrl || activeSockets.has(id)) return;

  try {
    const ws = new WebSocket(webSocketDebuggerUrl);

    ws.addEventListener('open', () => {
      outputChannel.appendLine(`[Ch2] Attached [${id.slice(0, 8)}] ${title || url || 'Workbench'}`);

      ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
      ws.send(JSON.stringify({
        id: 2,
        method: 'Runtime.evaluate',
        params: { expression: buildInjectionScript(config), userGesture: true }
      }));
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args?.map(a => a.value || '').join(' ');
          if (text.includes('[AA]')) {
            outputChannel.appendLine(`[Ch2 ${id.slice(0, 8)}] ${text}`);
            if (text.includes('Clicking:')) {
              clickCount++;
              updateStatusBar();
            }
            if (text.includes('BLOCKED')) {
              const cmd = text.split('BLOCKED exempt command:')[1]?.trim() || '';
              vscode.window.showWarningMessage(`AutoAccept: Skipped exempted command "${cmd}"`);
            }
          }
        }
      } catch {}
    });

    ws.addEventListener('close', () => { activeSockets.delete(id); });
    ws.addEventListener('error', () => { activeSockets.delete(id); });

    activeSockets.set(id, ws);
  } catch (err) {
    outputChannel.appendLine(`[Ch2] Error attaching ${id}: ${err.message}`);
  }
}

async function channel2Poll() {
  if (!isEnabled) return;
  const config = getConfiguration();
  const targets = await fetchTargets(config.port);
  for (const t of targets) {
    if (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') {
      attachTarget(t, config);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════
function activate(context) {
  outputChannel = vscode.window.createOutputChannel('AntiGravity AutoAccept');
  outputChannel.appendLine('AntiGravity AutoAccept activated — dual channel (Ch1: VS Code Commands + Ch2: CDP DOM)');

  const config = getConfiguration();
  isEnabled = config.enabled;

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravityAutoAccept.toggle';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Toggle command
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAutoAccept.toggle', async () => {
      isEnabled = !isEnabled;
      await vscode.workspace.getConfiguration('antigravityAutoAccept')
        .update('enabled', isEnabled, vscode.ConfigurationTarget.Global);
      updateStatusBar();
      // Broadcast pause/resume to CDP sessions
      const expr = isEnabled ? 'window.__AA_PAUSED=false;"resumed"' : 'window.__AA_PAUSED=true;"paused"';
      for (const [, ws] of activeSockets) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ id: Date.now(), method: 'Runtime.evaluate', params: { expression: expr } }));
        }
      }
      vscode.window.showInformationMessage(`AutoAccept ${isEnabled ? 'ON' : 'PAUSED'}`);
    })
  );

  // Add exempt command
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAutoAccept.addExemptCommand', async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Enter command pattern to exempt (e.g. 'git push --force')",
        placeHolder: 'e.g. git push'
      });
      if (input?.trim()) {
        const cfg = vscode.workspace.getConfiguration('antigravityAutoAccept');
        const list = cfg.get('exemptCommands', []);
        if (!list.includes(input.trim())) {
          list.push(input.trim());
          await cfg.update('exemptCommands', list, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Added "${input.trim()}" to exemption list.`);
        }
      }
    })
  );

  // Open settings
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAutoAccept.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityAutoAccept');
    })
  );

  // Status
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityAutoAccept.status', () => {
      const cfg = getConfiguration();
      vscode.window.showInformationMessage(
        `AutoAccept ${isEnabled ? 'ON' : 'PAUSED'} | Clicks: ${clickCount} | CDP targets: ${activeSockets.size} | Exempted: [${cfg.exemptCommands.join(', ')}]`
      );
    })
  );

  // Config watcher
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('antigravityAutoAccept')) {
        const updated = getConfiguration();
        isEnabled = updated.enabled;
        updateStatusBar();
      }
    })
  );

  // ─── Start both channels ───────────────────────────────────────────
  // Channel 1: VS Code commands every 500ms
  ch1Timer = setInterval(channel1Tick, config.pollIntervalMs);
  channel1Tick();

  // Channel 2: CDP discovery every 3s
  ch2Timer = setInterval(channel2Poll, 3000);
  channel2Poll();

  // ─── Command Discovery — log available antigravity commands ────────
  vscode.commands.getCommands(true).then(cmds => {
    const agyCmds = cmds.filter(c => c.toLowerCase().includes('antigravity') || c.toLowerCase().includes('autoaccept'));
    outputChannel.appendLine(`\n=== Discovered ${agyCmds.length} antigravity/autoaccept commands ===`);
    agyCmds.forEach(c => outputChannel.appendLine(`  • ${c}`));
    outputChannel.appendLine('='.repeat(55));
  });
}

function deactivate() {
  if (ch1Timer) clearInterval(ch1Timer);
  if (ch2Timer) clearInterval(ch2Timer);
  for (const ws of activeSockets.values()) {
    try { ws.close(); } catch {}
  }
  activeSockets.clear();
}

module.exports = { activate, deactivate };
