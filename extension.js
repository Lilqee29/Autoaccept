const vscode = require('vscode');

let statusBarItem;
let pollTimer = null;
const activeSockets = new Map(); // targetId -> WebSocket
let outputChannel;

function getConfiguration() {
  const config = vscode.workspace.getConfiguration('antigravityAutoAccept');
  return {
    enabled: config.get('enabled', true),
    port: config.get('cdpPort', 9333),
    exemptCommands: config.get('exemptCommands', [
      "rm -rf",
      "del /f",
      "git push",
      "npm publish",
      "format",
      "drop database"
    ]),
    allowedKeywords: config.get('allowedKeywords', [
      "run",
      "accept",
      "always allow",
      "allow",
      "proceed",
      "continue",
      "confirm",
      "execute"
    ]),
    pollIntervalMs: config.get('pollIntervalMs', 2000)
  };
}

function updateStatusBar(enabled, connectedCount = 0) {
  if (!statusBarItem) return;
  if (enabled) {
    statusBarItem.text = `$(check) AutoAccept: ON`;
    statusBarItem.tooltip = `AntiGravity AutoAccept is active.\nConnected targets: ${connectedCount}\nClick to toggle or configure exemptions.`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(circle-slash) AutoAccept: PAUSED`;
    statusBarItem.tooltip = `AntiGravity AutoAccept is paused.\nClick to resume.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

function buildInjectionScript(config) {
  return `(() => {
    window.__antigravityConfig = ${JSON.stringify(config)};
    
    if (window.__antigravityAutoAcceptInstalled) {
      return "Config updated";
    }
    window.__antigravityAutoAcceptInstalled = true;

    function findAssociatedCommand(button) {
      // Traverse up to find container (card, step, dialog, code snippet)
      let current = button;
      let depth = 0;
      while (current && depth < 8 && current !== document.body) {
        // Look for code blocks, pre tags, terminal lines, or commands in parent container
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

    function isCommandExempt(commandText, exemptList) {
      if (!commandText || !exemptList || exemptList.length === 0) return false;
      const lower = commandText.toLowerCase();
      return exemptList.some(exempt => {
        const target = exempt.trim().toLowerCase();
        return target && lower.includes(target);
      });
    }

    function tryAcceptButtons() {
      const cfg = window.__antigravityConfig;
      if (!cfg || !cfg.enabled) return;

      const candidates = document.querySelectorAll('button, [role="button"], .monaco-button, a.action-label');

      for (const btn of candidates) {
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
        if (btn.dataset.autoAccepted || btn.dataset.exempted) continue;

        const text = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (!text) continue;

        const isMatch = cfg.allowedKeywords.some(keyword => {
          return text === keyword || text.startsWith(keyword + " ") || text.endsWith(" " + keyword);
        });

        if (isMatch) {
          // Check for exempt command if this is a command proposal button
          const associatedCmd = findAssociatedCommand(btn);
          if (associatedCmd && isCommandExempt(associatedCmd, cfg.exemptCommands)) {
            btn.dataset.exempted = "true";
            console.log("[AutoAccept Exemption] Blocked command:", associatedCmd);
            return;
          }

          // Safe to auto-accept
          btn.dataset.autoAccepted = "true";
          console.log("[AutoAccept Executed] Auto-accepted button:", text);

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

    setInterval(tryAcceptButtons, 1200);
    return "Installed successfully";
  })()`;
}

async function fetchTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

function attachTarget(target, config) {
  const { id, title, url, webSocketDebuggerUrl } = target;
  if (!webSocketDebuggerUrl) return;
  if (activeSockets.has(id)) return;

  try {
    const ws = new WebSocket(webSocketDebuggerUrl);

    ws.on('open', () => {
      outputChannel.appendLine(`[Attached] Target [${id.slice(0, 8)}] (${title || url || 'Workbench'})`);
      updateStatusBar(config.enabled, activeSockets.size + 1);

      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.enable"
      }));

      ws.send(JSON.stringify({
        id: 2,
        method: "Runtime.evaluate",
        params: {
          expression: buildInjectionScript(config),
          userGesture: true,
          awaitPromise: true
        }
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === "Runtime.consoleAPICalled") {
          const logText = msg.params.args?.map(a => a.value || '').join(' ');
          if (logText.includes("[AutoAccept Exemption]")) {
            const cmd = logText.replace("[AutoAccept Exemption] Blocked command:", "").trim();
            outputChannel.appendLine(`[Exemption] Skipped command: ${cmd}`);
            vscode.window.showWarningMessage(`AutoAccept: Skipped exempted command: "${cmd}" (requires manual approval)`);
          } else if (logText.includes("[AutoAccept Executed]")) {
            outputChannel.appendLine(`[Executed] ${logText}`);
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      activeSockets.delete(id);
      updateStatusBar(config.enabled, activeSockets.size);
    });

    ws.on('error', () => {
      activeSockets.delete(id);
      updateStatusBar(config.enabled, activeSockets.size);
    });

    activeSockets.set(id, ws);
  } catch (err) {
    outputChannel.appendLine(`[Error] Failed attaching to ${id}: ${err.message}`);
  }
}

function broadcastConfigUpdate(config) {
  const updateScript = `(() => {
    window.__antigravityConfig = ${JSON.stringify(config)};
    return "Config refreshed";
  })()`;

  for (const [id, ws] of activeSockets.entries()) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({
        id: Date.now(),
        method: "Runtime.evaluate",
        params: { expression: updateScript }
      }));
    }
  }
}

async function runPollCycle() {
  const config = getConfiguration();
  const targets = await fetchTargets(config.port);

  if (targets.length === 0) {
    if (activeSockets.size > 0) {
      outputChannel.appendLine("[Status] CDP disconnected. Waiting for Antigravity...");
      activeSockets.clear();
      updateStatusBar(config.enabled, 0);
    }
  } else {
    for (const t of targets) {
      if (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') {
        attachTarget(t, config);
      }
    }
  }
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("AntiGravity AutoAccept");
  outputChannel.appendLine("AntiGravity AutoAccept extension activated.");

  const config = getConfiguration();

  // Create Status Bar Item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravityAutoAccept.toggle';
  context.subscriptions.push(statusBarItem);
  updateStatusBar(config.enabled, 0);

  // Command: Toggle ON / OFF
  const toggleCmd = vscode.commands.registerCommand('antigravityAutoAccept.toggle', async () => {
    const current = vscode.workspace.getConfiguration('antigravityAutoAccept');
    const newState = !current.get('enabled', true);
    await current.update('enabled', newState, vscode.ConfigurationTarget.Global);
    const updated = getConfiguration();
    updateStatusBar(updated.enabled, activeSockets.size);
    broadcastConfigUpdate(updated);

    vscode.window.showInformationMessage(
      `AntiGravity AutoAccept is now ${newState ? 'ON (Active)' : 'PAUSED'}.`
    );
  });
  context.subscriptions.push(toggleCmd);

  // Command: Add Exempt Command
  const addExemptCmd = vscode.commands.registerCommand('antigravityAutoAccept.addExemptCommand', async () => {
    const input = await vscode.window.showInputBox({
      prompt: "Enter command pattern or keyword to exempt from auto-accepting (e.g. 'git push', 'rm -rf')",
      placeHolder: "e.g. git push"
    });

    if (input && input.trim()) {
      const current = vscode.workspace.getConfiguration('antigravityAutoAccept');
      const list = current.get('exemptCommands', []);
      if (!list.includes(input.trim())) {
        list.push(input.trim());
        await current.update('exemptCommands', list, vscode.ConfigurationTarget.Global);
        broadcastConfigUpdate(getConfiguration());
        vscode.window.showInformationMessage(`Added "${input.trim()}" to AutoAccept exemption list.`);
      }
    }
  });
  context.subscriptions.push(addExemptCmd);

  // Command: Open Settings
  const openSettingsCmd = vscode.commands.registerCommand('antigravityAutoAccept.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'antigravityAutoAccept');
  });
  context.subscriptions.push(openSettingsCmd);

  // Command: Show Status
  const statusCmd = vscode.commands.registerCommand('antigravityAutoAccept.status', () => {
    const cfg = getConfiguration();
    const exemptList = cfg.exemptCommands.join(', ') || 'None';
    vscode.window.showInformationMessage(
      `AutoAccept: ${cfg.enabled ? 'ON' : 'PAUSED'} | Targets: ${activeSockets.size} | Port: ${cfg.port}\nExempted: [${exemptList}]`
    );
  });
  context.subscriptions.push(statusCmd);

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('antigravityAutoAccept')) {
        const updated = getConfiguration();
        updateStatusBar(updated.enabled, activeSockets.size);
        broadcastConfigUpdate(updated);
      }
    })
  );

  // Start continuous polling loop
  pollTimer = setInterval(runPollCycle, config.pollIntervalMs);
  runPollCycle();
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  for (const ws of activeSockets.values()) {
    try { ws.close(); } catch {}
  }
  activeSockets.clear();
}

module.exports = {
  activate,
  deactivate
};
