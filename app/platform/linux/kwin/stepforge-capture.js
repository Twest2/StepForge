// StepForge Capture for KWin (KDE Plasma 6).
//
// StepForge's capture helper (kwin_companion.py) loads this script through
// KWin's scripting D-Bus API while a recording is open and unloads it when
// the recording ends. The helper asks for the pointer position and the window
// under it at a click's time; the script answers with those, the window's
// title and app, and the monitor layout. It never sees keyboard input and
// never changes a window.
//
// KWin scripts cannot export D-Bus methods, so the script long-polls the
// helper: Poll returns the pending requests (or an empty list every few
// seconds), and the script answers with Reply. The helper's unique bus name
// is filled in when the script is written out.
const SERVICE = '@SERVICE@';
const PATH = '/org/stepforge/KWin';
const IFACE = 'org.stepforge.KWin1';
const PROTOCOL = 1;
const HISTORY_MS = 2000;
// The helper answers every Poll within seconds. Silence means it is gone
// (a crash cannot unload the script), so stop following the pointer.
const ORPHAN_MS = 30000;

const history = [];
let lastAnswer = Date.now();
let running = true;

function point(p) { return { x: p.x, y: p.y }; }
function rect(r) { return { x: r.x, y: r.y, width: r.width, height: r.height }; }
function contains(r, p) { return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height; }

// cursorPosChanged fires for every pointer move; keep a short history so a
// click is matched with where the pointer was when the button went down,
// not where it is when the request arrives.
function remember() {
  const now = Date.now();
  if (now - lastAnswer > ORPHAN_MS) { stop(); return; }
  history.push({ at: now, pos: point(workspace.cursorPos) });
  while (history.length > 2 && now - history[0].at > HISTORY_MS) history.shift();
}

function pointerAt(at) {
  if (!Number.isFinite(at)) return point(workspace.cursorPos);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].at <= at) return history[i].pos;
  }
  return history.length ? history[0].pos : point(workspace.cursorPos);
}

function onCurrentDesktop(w) {
  if (w.onAllDesktops) return true;
  const current = workspace.currentDesktop;
  return (w.desktops || []).some((desktop) => desktop === current);
}

function shown(w) {
  return Boolean(w) && !w.deleted && !w.minimized && !w.hidden && onCurrentDesktop(w);
}

// A menu, dropdown or tooltip stands for the window it belongs to.
function isPopup(w) {
  return w.popupWindow || w.popupMenu || w.dropdownMenu || w.tooltip || w.comboBox || w.menu;
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function windowAt(pos) {
  const stack = workspace.stackingOrder || [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const w = stack[i];
    if (shown(w) && !w.desktopWindow && contains(w.frameGeometry, pos)) return w;
  }
  return null;
}

const NOTHING = { appId: '', windowTitle: '', windowPid: 0, resourceClass: '', kind: 'desktop' };

function describe(w) {
  return { appId: w.desktopFileName || w.resourceClass || '', windowTitle: w.caption || '',
    windowPid: w.pid || 0, resourceClass: w.resourceClass || '',
    kind: w.dock ? 'panel' : (isPopup(w) ? 'popup' : 'window') };
}

function context(request) {
  const pos = pointerAt(request.at);
  // A click is about the window under the pointer; a capture without one
  // (Capture window, the hotkey) is about the active window.
  const clicked = Number.isFinite(request.at);
  const hit = clicked ? windowAt(pos) : (shown(workspace.activeWindow) ? workspace.activeWindow : null);
  let target = hit;
  let area = null;
  if (hit && isPopup(hit)) {
    const active = shown(workspace.activeWindow) ? workspace.activeWindow : null;
    const owner = shown(hit.transientFor) ? hit.transientFor : active;
    target = owner && owner !== hit ? owner : hit;
    if (target !== hit) area = union(rect(target.frameGeometry), rect(hit.frameGeometry));
  }
  // Only an application window is cut out; a panel or the desktop keeps the
  // whole screen.
  const cut = target && !target.dock && !isPopup(target);
  return Object.assign({ id: request.id, pointer: pos,
    window: cut ? (area || rect(target.frameGeometry)) : null },
  target ? describe(target) : NOTHING,
  { hitKind: hit ? describe(hit).kind : 'desktop', hitClass: hit ? hit.resourceClass || '' : '' });
}

function screens() {
  return (workspace.screens || []).map((output) => Object.assign({ name: output.name || '' }, rect(output.geometry)));
}

function answer(results) {
  callDBus(SERVICE, PATH, IFACE, 'Reply', JSON.stringify({ protocol: PROTOCOL, results, screens: screens() }));
}

function poll() {
  if (!running) return;
  callDBus(SERVICE, PATH, IFACE, 'Poll', JSON.stringify({ protocol: PROTOCOL }), (reply) => {
    lastAnswer = Date.now();
    let message;
    try { message = JSON.parse(reply); } catch (error) { message = { quit: true }; }
    if (message.quit) { stop(); return; }
    const requests = message.requests || [];
    if (requests.length) answer(requests.map(context));
    poll();
  });
}

function layoutChanged() {
  callDBus(SERVICE, PATH, IFACE, 'Event', JSON.stringify({ type: 'screens', screens: screens() }));
}

function stop() {
  if (!running) return;
  running = false;
  workspace.cursorPosChanged.disconnect(remember);
  workspace.screensChanged.disconnect(layoutChanged);
}

workspace.cursorPosChanged.connect(remember);
workspace.screensChanged.connect(layoutChanged);
remember();
callDBus(SERVICE, PATH, IFACE, 'Event', JSON.stringify({ type: 'hello', protocol: PROTOCOL, screens: screens() }));
poll();
