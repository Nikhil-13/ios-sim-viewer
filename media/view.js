// The simulator page. Decodes the H.264 frames in hardware (WebCodecs) onto a canvas, and sends touches, trackpad
// scrolls and keys. The extension drives it with {type: 'state' | 'config' | 'frame' | 'toast'}. Docs: README.md
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const card = $('card');
const toastEl = $('toast');
const controls = $('controls');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const send = (m) => vscode.postMessage(m);

let live = false; // the extension says the stream and input are up
let drawn = false; // a frame is on the canvas
let decoder = null;
let needKey = true;
let toastTimer;

// --- states ---

const svg = (body, size = 40) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  phone: svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>'),
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>'),
  power: svg('<path d="M12 3v9"/><path d="M17.7 6.8a8 8 0 1 1-11.4 0"/>'),
};

// The bar under the screen: [icon, label, message].
for (const [icon, label, m] of [
  ['<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9v11.5h13V9"/><path d="M10 20.5v-6h4v6"/>', 'Home', { type: 'button', name: 'HOME' }],
  ['<rect x="4.5" y="10.5" width="15" height="10.5" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>', 'Lock', { type: 'button', name: 'LOCK' }],
  ['<rect x="6" y="6" width="12" height="12" rx="2"/>', 'Stop the viewer (the simulator keeps running)', { type: 'stop' }],
]) {
  const b = document.createElement('button');
  b.className = 'icon';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = svg(icon, 16);
  b.onclick = () => (send(m), canvas.focus()); // keep typing going to the simulator
  controls.append(b);
}

// A centred message: an icon (or a spinner), a title, text, and buttons [label, message type].
function showCard(icon, title, text, ...actions) {
  canvas.hidden = controls.hidden = true;
  card.hidden = false;
  card.dataset.kind = icon; // not className: the card itself must not get the spinner's .spin style
  card.replaceChildren();
  const big = document.createElement('div');
  if (icon === 'spin') big.className = 'spin';
  else (big.className = 'big'), (big.innerHTML = ICONS[icon]);
  const h = document.createElement('h3');
  h.textContent = title;
  card.append(big, h);
  if (text) {
    const p = document.createElement('p');
    p.textContent = text;
    card.append(p);
  }
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'actions';
    actions.forEach(([label, type], i) => {
      const b = document.createElement('button');
      b.className = i ? 'secondary' : '';
      b.textContent = label;
      b.onclick = () => send({ type });
      row.append(b);
    });
    card.append(row);
  }
}

function setState(m) {
  live = m.state === 'live';
  if (!live) (drawn = false), releaseAll();
  if (m.state === 'connecting') showCard('spin', m.text || 'Connecting…');
  else if (m.state === 'live') drawn || showCard('spin', 'Waiting for the screen…');
  else if (m.state === 'stopped') showCard('power', 'Viewer is off', 'The stream and input are stopped. The simulator keeps running.', ['Start', 'start']);
  else if (m.state === 'none') showCard('phone', 'No simulator running', 'Choose one to boot it.', ['Choose Simulator', 'pick']);
  else if (m.state === 'error') showCard('alert', "Can't show the simulator", m.text, ['Retry', 'retry'], ['Choose Simulator', 'pick']);
}

function toast(text) {
  toastEl.textContent = String(text).slice(0, 240);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4000);
}

// --- screen ---

const stats = { frames: 0, decodeMs: 0, sent: new Map() };

function configure(c) {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({ output: draw, error: (e) => (toast(`Video: ${e.message}`), send({ type: 'hello' })) });
  decoder.configure({ codec: c.codec, description: c.description, optimizeForLatency: true });
  needKey = true;
  canvas.width = c.width;
  canvas.height = c.height;
  // ponytail: one corner radius (12% of the width) for every tall iPhone, none for the rest; read the device
  // type's framebufferMask if other shapes matter.
  canvas.style.borderRadius = c.height / c.width > 1.9 ? `12% / ${(12 * c.width) / c.height}%` : '';
}

function decode(m) {
  if (!decoder || decoder.state !== 'configured' || (needKey && !m.key)) return;
  if (decoder.decodeQueueSize > 8) return (needKey = true), send({ type: 'hello' }); // fell behind: start fresh
  needKey = false;
  const timestamp = performance.now() * 1000;
  stats.sent.set(timestamp, performance.now());
  decoder.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp, data: m.data }));
}

function draw(frame) {
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  const t = stats.sent.get(frame.timestamp);
  if (t !== undefined) (stats.decodeMs += performance.now() - t), stats.sent.delete(frame.timestamp);
  stats.frames++;
  frame.close();
  if (live && !drawn) (drawn = true), (canvas.hidden = controls.hidden = false), (card.hidden = true);
}

setInterval(() => {
  if (live && stats.frames) send({ type: 'stats', fps: stats.frames / 2, decodeMs: +(stats.decodeMs / stats.frames).toFixed(1) });
  stats.frames = stats.decodeMs = 0;
  stats.sent.clear();
}, 2000);

// --- touch ---

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
// Screen position as 0..1 across the simulator's screen.
const at = (e) => {
  const r = canvas.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
};
const touch = (phase, p) => send({ type: 'touch', phase, x: p.x, y: p.y });

// The home-indicator swipe can't be injected as a touch — idb's HID makes the pill react but the gesture never
// commits. So a drag that starts in the bottom strip isn't sent to the app (that only scrolls it, then jerks to
// home); instead, as on iOS, a swipe up releases to Home and a swipe up that then holds opens the app switcher
// (a double Home press). A plain tap in the strip is still forwarded, so bottom bars and buttons keep working.
let finger = null; // pointer id while the mouse button is down
let start = null; // where the drag began
let inStrip = false; // started in the bottom home-indicator strip: hold the touch, decide tap vs swipe
let armed = false; // an upward swipe from the strip is under way
let holdTimer;
const endStrip = () => (inStrip = armed = false, clearTimeout(holdTimer));

canvas.addEventListener('pointerdown', (e) => {
  if (!live || e.button !== 0 || finger !== null) return;
  finger = e.pointerId;
  canvas.setPointerCapture(e.pointerId);
  start = at(e);
  inStrip = start.y >= 0.96;
  armed = false;
  if (!inStrip) touch('down', start);
});
const goHome = (double, id) => {
  send({ type: 'button', name: 'HOME', ...(double && { double: true }) });
  (finger = null), canvas.releasePointerCapture(id), endStrip();
};
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId !== finger) return;
  const p = at(e);
  if (!inStrip) return touch('move', p);
  const up = start.y - p.y;
  if (up >= 0.13) return goHome(false, e.pointerId); // committed swipe up: go home at once, no wait for release
  if (!armed && up >= 0.05) armed = true;
  if (armed) {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => goHome(true, e.pointerId), 160); // swiped up a little, then held still: app switcher
  }
});
const lift = (e) => {
  if (e.pointerId !== finger) return;
  finger = null;
  const p = at(e);
  if (inStrip) {
    if (armed) send({ type: 'button', name: 'HOME' }); // quick swipe up: go home
    else (touch('down', start), touch('up', p)); // just a tap in the strip
    return endStrip();
  }
  touch('up', p);
};
canvas.addEventListener('pointerup', lift);
canvas.addEventListener('pointercancel', lift);
canvas.addEventListener('lostpointercapture', lift);

// Trackpad and wheel scrolling: a finger drag that follows the scroll and lifts once it stops. It starts away from
// the top and bottom edges, where a drag would open Notification Centre or go home.
let wheel = null;
let wheelTimer;
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!live || finger !== null) return;
    const r = canvas.getBoundingClientRect();
    const k = e.deltaMode === 1 ? 16 : 1; // lines -> pixels
    const start = () => {
      const p = at(e);
      touch('down', (wheel = { x: clamp(p.x, 0.05, 0.95), y: clamp(p.y, 0.15, 0.85) }));
    };
    if (!wheel) start();
    const next = { x: wheel.x - (e.deltaX * k) / r.width, y: wheel.y - (e.deltaY * k) / r.height };
    if (next.x < 0.02 || next.x > 0.98 || next.y < 0.08 || next.y > 0.92) touch('up', wheel), start(); // out of room
    else touch('move', (wheel = next));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => (touch('up', wheel), (wheel = null)), 100);
  },
  { passive: false },
);

// --- keyboard: physical keys as USB HID usages, so it acts as a hardware keyboard (held keys, modifiers) ---

const USAGE = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46, BracketLeft: 47, BracketRight: 48,
  Backslash: 49, Semicolon: 51, Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, ControlRight: 228, ShiftRight: 229, AltRight: 230,
};
for (let i = 0; i < 26; i++) USAGE[`Key${String.fromCharCode(65 + i)}`] = 4 + i;
for (let i = 1; i <= 9; i++) USAGE[`Digit${i}`] = 29 + i;
USAGE.Digit0 = 39;
// Cmd+key: these go to the simulator (V pastes the Mac's clipboard; C and X copy back to it); the rest stay VS Code's.
const COMMANDS = { KeyA: 'command', KeyC: 'copy', KeyX: 'copy', KeyZ: 'command', KeyV: 'paste' };

const held = new Set();
canvas.addEventListener('keydown', (e) => {
  if (!live) return;
  if (e.metaKey) {
    const kind = COMMANDS[e.code];
    if (!kind) return;
    e.preventDefault();
    if (kind === 'paste') send({ type: 'paste' });
    else send({ type: 'command', usage: USAGE[e.code], copied: kind === 'copy' });
    return;
  }
  const usage = USAGE[e.code];
  if (!usage) return;
  e.preventDefault();
  if (e.repeat) return; // the simulator repeats held keys itself
  held.add(usage);
  send({ type: 'key', usage, down: true });
});
canvas.addEventListener('keyup', (e) => {
  const usage = USAGE[e.code];
  if (!held.delete(usage)) return;
  send({ type: 'key', usage, down: false });
});
// Keys still down when focus leaves would stay down in the simulator.
function releaseAll() {
  held.forEach((usage) => send({ type: 'key', usage, down: false }));
  held.clear();
}
canvas.addEventListener('blur', releaseAll);

window.addEventListener('message', ({ data: m }) => {
  if (m.type === 'frame') decode(m);
  else if (m.type === 'config') configure(m);
  else if (m.type === 'state') setState(m);
  else if (m.type === 'toast') toast(m.text);
});
send({ type: 'hello' });
