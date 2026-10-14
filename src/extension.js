'use strict';
const vscode = require('vscode');
const { CdpInjector } = require('./cdp');
const { buildScript } = require('./observer');
const { hasFilters } = require('./filter');

// Antigravity-native commands. Missing ones simply reject and are ignored.
const EDIT_COMMANDS = ['antigravity.agent.acceptAgentStep'];
const TERMINAL_COMMANDS = ['antigravity.terminalCommand.accept', 'antigravity.terminalCommand.run', 'antigravity.command.accept'];

let out, status, injector, pollTimer, ctx;

const cfg = () => vscode.workspace.getConfiguration('gravityAutopilot');
const log = (m) => out && out.appendLine(new Date().toLocaleTimeString() + '  ' + m);

function pageConfig() {
  const c = cfg();
  const texts = ['run', 'always allow', 'allow this conversation', 'allow']
    .concat(c.get('autoAcceptFileEdits') ? ['accept all', 'accept'] : [])
    .concat(c.get('autoRetry') ? ['retry', 'continue'] : [])
    .concat((c.get('extraButtonTexts') || []).map((s) => String(s).toLowerCase()));
  const blocked = c.get('blockedCommands') || [], allowed = c.get('allowedCommands') || [];
  return {
    texts, blocked, allowed, filtersOn: hasFilters(blocked, allowed),
    paused: !c.get('enabled'), swarm: !!c.get('swarm.enabled'), swarmIdleMs: (c.get('swarm.idleSeconds') || 20) * 1000,
  };
}

function firePoll() {
  const c = cfg();
  if (!c.get('enabled')) return;
  // Native terminal accept is context-blind, so it is only used when NO command filters exist.
  // With filters on, terminal approval is left to the DOM observer, which can read the command.
  let cmds = c.get('autoAcceptFileEdits') ? EDIT_COMMANDS.slice() : [];
  if (!hasFilters(c.get('blockedCommands'), c.get('allowedCommands'))) cmds = cmds.concat(TERMINAL_COMMANDS);
  cmds.forEach((id) => vscode.commands.executeCommand(id).then(undefined, () => {}));
}

function render() {
  const c = cfg(), on = c.get('enabled');
  status.text = on ? '$(rocket) Autopilot' + (c.get('swarm.enabled') ? ' + Swarm' : '') : '$(circle-slash) Autopilot OFF';
  status.tooltip = 'Gravity Autopilot — click to toggle. CDP port ' + c.get('cdpPort') + (injector && injector.connected ? ' (connected)' : ' (not connected)');
  status.backgroundColor = on ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
}

function restart() {
  if (pollTimer) clearInterval(pollTimer);
  const c = cfg();
  pollTimer = setInterval(firePoll, Math.max(200, c.get('pollIntervalMs') || 600));
  injector.start(c.get('cdpPort') || 9333, buildScript(pageConfig()));
  render(); log('Started (CDP port ' + c.get('cdpPort') + ', filters ' + (hasFilters(c.get('blockedCommands'), c.get('allowedCommands')) ? 'ON' : 'off') + ')');
}

function setup() {
  const port = cfg().get('cdpPort') || 9333;
  const flag = '--remote-debugging-port=' + port;
  vscode.env.clipboard.writeText(flag);
  vscode.window.showInformationMessage(
    'Copied "' + flag + '". Launch Antigravity with it (shortcut target, or: antigravity ' + flag + '). ' +
    'Without it, only the native-command channel works.', { modal: false });
}

function activate(context) {
  ctx = context;
  out = vscode.window.createOutputChannel('Gravity Autopilot');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'gravityAutopilot.toggle'; status.show();
  injector = new CdpInjector(log);

  context.subscriptions.push(
    out, status,
    { dispose() { if (pollTimer) clearInterval(pollTimer); injector.stop(); } },
    vscode.commands.registerCommand('gravityAutopilot.toggle', async () => {
      await cfg().update('enabled', !cfg().get('enabled'), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('gravityAutopilot.toggleSwarm', async () => {
      await cfg().update('swarm.enabled', !cfg().get('swarm.enabled'), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('gravityAutopilot.setup', setup),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gravityAutopilot')) return;
      if (e.affectsConfiguration('gravityAutopilot.cdpPort') || e.affectsConfiguration('gravityAutopilot.pollIntervalMs')) restart();
      else { injector.update(buildScript(pageConfig())); render(); }
    })
  );
  const renderTimer = setInterval(render, 5000);
  context.subscriptions.push({ dispose() { clearInterval(renderTimer); } });
  restart();
}
function deactivate() { if (pollTimer) clearInterval(pollTimer); if (injector) injector.stop(); }
module.exports = { activate, deactivate };
