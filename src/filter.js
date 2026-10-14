'use strict';
// Pure logic, shared by the extension host, the injected page script, and tests.
// commandAllowed is deliberately self-contained so it can be stringified into the page.
function commandAllowed(command, blocked, allowed) {
  var norm = function (l) { return (Array.isArray(l) ? l : []).map(function (s) { return String(s).trim().toLowerCase(); }).filter(Boolean); };
  var c = String(command || '').toLowerCase(), b = norm(blocked), a = norm(allowed);
  if (b.some(function (p) { return c.indexOf(p) !== -1; })) return false;
  if (a.length && !a.some(function (p) { return c.indexOf(p) !== -1; })) return false;
  return true;
}
function hasFilters(blocked, allowed) {
  var n = function (l) { return (Array.isArray(l) ? l : []).filter(function (s) { return String(s).trim(); }).length; };
  return n(blocked) + n(allowed) > 0;
}
module.exports = { commandAllowed, hasFilters };
