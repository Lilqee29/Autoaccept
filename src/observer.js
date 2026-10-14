'use strict';
const { commandAllowed } = require('./filter');

// Runs INSIDE the Antigravity page(s) via CDP Runtime.evaluate. Must be self-contained.
// Re-evaluating it is safe: it tears down the previous instance first.
function observer(cfg, commandAllowed) {
  if (window.__GA_CLEANUP) { try { window.__GA_CLEANUP(); } catch (e) {} }

  var TARGETS = cfg.texts;                       // lowercase labels, in priority order
  var AMBIGUOUS = { run: 1, accept: 1, allow: 1, retry: 1, continue: 1 };
  var SIDEBAR = '[role="tree"],[role="treeitem"],[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],nav,.monaco-list,[class*="conversation-list"],[class*="chat-history"],[class*="past-chat"],[class*="trajectory"]';
  var cooldown = new WeakMap();
  window.__GA_STATE = window.__GA_STATE || { clicks: 0, blocked: 0, paused: false, lastInput: Date.now(), swarm: false };
  var S = window.__GA_STATE;
  S.paused = !!cfg.paused; S.swarm = !!cfg.swarm;

  function onInput() { S.lastInput = Date.now(); }
  ['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(function (ev) { document.addEventListener(ev, onInput, true); });

  function visible(el) { return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }

  function labelOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  // "Run  Alt+⏎" -> matches "run". "Accept all" -> matches "accept". Longer targets win by order.
  function matchTarget(label) {
    if (!label || label.length > 40) return null;
    for (var i = 0; i < TARGETS.length; i++) {
      var t = TARGETS[i];
      if (label === t || label.indexOf(t + ' ') === 0) return t;
    }
    return null;
  }

  // Walk up from the button to find the command text the agent wants to run.
  function nearbyCommand(btn) {
    var el = btn;
    for (var up = 0; up < 7 && el && el !== document.body; up++, el = el.parentElement) {
      var blocks = el.querySelectorAll ? el.querySelectorAll('pre, code, [class*="terminal"], [class*="command"]') : [];
      if (blocks.length) return (blocks[blocks.length - 1].innerText || blocks[blocks.length - 1].textContent || '');
    }
    return '';
  }

  function isRunLike(t) { return t === 'run' || t === 'always allow' || t === 'allow' || t === 'allow this conversation'; }

  function scan(root) {
    if (S.paused) return false;

    // Handle Antigravity Permission Modal Dialogs ("Yes, allow this time" + "Submit")
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
          console.log('[GA] Auto-clicking permission Submit button');
          S.clicks++;
          submitBtn.focus();
          submitBtn.click();
          return true;
        }
      }
    }

    var nodes = root.querySelectorAll('button, [role="button"], a[role="button"], [class*="btn"], [class*="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.disabled || el.getAttribute('aria-disabled') === 'true' || !visible(el)) continue;
      if (el.closest(SIDEBAR)) continue;                       // never click chat titles named "Run" etc.
      var t = matchTarget(labelOf(el));
      if (!t) continue;
      var last = cooldown.get(el) || 0;
      if (Date.now() - last < 2500) continue;
      if (isRunLike(t) && cfg.filtersOn) {
        var cmd = nearbyCommand(el);
        // Fail closed: filters are configured but no command text found -> don't click.
        if (!cmd || !commandAllowed(cmd, cfg.blocked, cfg.allowed)) {
          cooldown.set(el, Date.now() + 10000); S.blocked++;
          el.setAttribute('data-ga-blocked', '1');
          console.log('[GA] blocked:', (cmd || '(no command text)').slice(0, 120));
          continue;
        }
      }
      cooldown.set(el, Date.now());
      S.clicks++; el.click();
      console.log('[GA] clicked:', t);
      return true;
    }
    // Shadow roots
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) if (all[j].shadowRoot && scan(all[j].shadowRoot)) return true;
    return false;
  }

  // Swarm (best effort): when idle, open a conversation that advertises it is waiting on you.
  var PENDING = /(needs?|requires?|awaiting|waiting( for)?)\s+(your\s+)?(input|approval|review|permission)|pending/i;
  var swarmCooldown = new WeakMap();
  function swarmStep() {
    if (!S.swarm || S.paused) return;
    if (Date.now() - S.lastInput < cfg.swarmIdleMs) return;
    var items = document.querySelectorAll(SIDEBAR);
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!visible(it) || it.getAttribute('aria-selected') === 'true') continue;
      var txt = (it.innerText || '').replace(/\s+/g, ' ');
      if (txt.length > 200 || !PENDING.test(txt)) continue;
      if (Date.now() - (swarmCooldown.get(it) || 0) < 30000) continue;
      swarmCooldown.set(it, Date.now());
      console.log('[GA] swarm: opening pending conversation');
      it.click();
      return;
    }
  }

  var scheduled = false;
  function schedule() { if (scheduled) return; scheduled = true; setTimeout(function () { scheduled = false; try { scan(document); } catch (e) {} }, 60); }
  var mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  var tick = setInterval(function () { try { scan(document); swarmStep(); } catch (e) {} }, 1000);

  window.__GA_CLEANUP = function () {
    mo.disconnect(); clearInterval(tick);
    ['keydown', 'mousedown', 'wheel', 'touchstart'].forEach(function (ev) { document.removeEventListener(ev, onInput, true); });
  };
  scan(document);
  return 'ga-active';
}

function buildScript(cfg) {
  return '(' + observer.toString() + ')(' + JSON.stringify(cfg) + ',' + commandAllowed.toString() + ')';
}
module.exports = { buildScript, observer };
