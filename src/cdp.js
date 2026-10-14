'use strict';
const http = require('http');
const WebSocket = require('ws');

// Minimal CDP injector: finds every debuggable target (windows, webviews, iframes/OOPIFs),
// evaluates our script in each, and re-evaluates periodically so it survives reloads.
class CdpInjector {
  constructor(log) { this.log = log; this.port = 9333; this.script = ''; this.sockets = new Map(); this.timer = null; this.connected = false; }

  start(port, script) { this.port = port; this.script = script; this.stop(); this.tick(); this.timer = setInterval(() => this.tick(), 3000); }
  update(script) { this.script = script; this.sockets.forEach((c) => this.inject(c)); }
  stop() {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    this.sockets.forEach((c) => { try { c.ws.close(); } catch (e) {} }); this.sockets.clear(); this.connected = false;
  }

  list() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/json/list', timeout: 1500 }, (res) => {
        let body = ''; res.on('data', (d) => (body += d));
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  async tick() {
    let targets;
    try { targets = await this.list(); this.connected = true; }
    catch (e) { if (this.connected) this.log('CDP unreachable on port ' + this.port + ' — is Antigravity launched with --remote-debugging-port=' + this.port + '?'); this.connected = false; return; }
    const live = new Set();
    for (const t of targets) {
      if (!t.webSocketDebuggerUrl || /^devtools:/i.test(t.url || '')) continue;
      live.add(t.id);
      const existing = this.sockets.get(t.id);
      if (existing) { if (existing.open) this.inject(existing); continue; }
      this.attach(t);
    }
    for (const [id, c] of this.sockets) if (!live.has(id)) { try { c.ws.close(); } catch (e) {} this.sockets.delete(id); }
  }

  attach(t) {
    const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
    const c = { ws, open: false, id: 1, title: t.title || t.type };
    this.sockets.set(t.id, c);
    ws.on('open', () => {
      c.open = true;
      // Also reach out-of-process iframes (Antigravity's agent panel) attached under this page.
      this.send(c, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      this.inject(c);
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.method === 'Target.attachedToTarget' && m.params && m.params.sessionId) {
        this.send(c, 'Runtime.evaluate', { expression: this.script, returnByValue: true }, m.params.sessionId);
      }
    });
    ws.on('close', () => { this.sockets.delete(t.id); });
    ws.on('error', () => { this.sockets.delete(t.id); });
  }

  send(c, method, params, sessionId) {
    if (!c.open) return;
    const msg = { id: c.id++, method, params };
    if (sessionId) msg.sessionId = sessionId;
    try { c.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
  inject(c) { this.send(c, 'Runtime.evaluate', { expression: this.script, returnByValue: true }); }
}
module.exports = { CdpInjector };
