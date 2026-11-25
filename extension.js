// Shows an iOS simulator in a VS Code view. Screen: H.264 from `sim-video`, decoded in hardware by the webview
// (WebCodecs) and drawn on a canvas. Input: live touches, keys and buttons over idb_companion's HID stream.
// Title bar: simulator picker, Reconnect. Under the screen: Home, Lock, Stop. Docs: README.md
const vscode = require('vscode');
const crypto = require('crypto');
const sim = require('./sim');

let context;
let view = null; // the WebviewView, while it exists
let session = null; // { device, screen, companion, video, config } for the simulator being shown
let state = null; // last {type: 'state'} sent, re-sent when the page (re)loads
let stoppedByUser = false;
let showing = null; // udid of the simulator shown last (also saved across reloads)

const post = (m) => view && view.webview.postMessage(m);
const toast = (text) => post({ type: 'toast', text });
function setState(name, extra = {}) {
  post((state = { type: 'state', state: name, ...extra }));
  vscode.commands.executeCommand('setContext', 'iosSim.on', name === 'live' || name === 'connecting');
}

function stop() {
  const s = session;
  session = null;
  if (s) s.videoToken = null, s.companion && s.companion.close(), s.video && s.video.close();
}

// The screen stream for session s. Restarted on its own when the page reloads, since a new decoder needs a keyframe
// and an idle simulator sends no frames at all.
async function startVideo(s) {
  const token = (s.videoToken = {}); // only the newest start may post frames or keep its process
  const mine = () => session === s && s.videoToken === token;
  if (s.video) s.video.close(), (s.video = null);
  const v = await sim.startVideo(s.device.udid, {
    onConfig: (c) => mine() && post({ type: 'config', ...c }),
    onFrame: (data, key) => mine() && post({ type: 'frame', key, data: new Uint8Array(data) }),
    onExit: (e) => mine() && fail(s, e),
  });
  if (!mine()) return v.close();
  s.video = v;
}

function fail(s, e) {
  if (session !== s) return;
  stop();
  setState('error', { text: e.message });
}

// Shows `udid` if it's booted, else the first booted simulator.
async function connect(udid = showing) {
  stop();
  stoppedByUser = false;
  if (!view) return;
  let devices;
  try {
    devices = await sim.listDevices();
  } catch (e) {
    return setState('error', { text: `Couldn't list simulators: ${e.message}` });
  }
  if (!view || session) return; // closed, or a newer connect() took over
  const device = devices.find((d) => d.udid === udid && d.booted) || devices.find((d) => d.booted);
  view.description = device ? `${device.name} · iOS ${device.ios}` : '';
  if (!device) return setState('none');

  const s = (session = { device });
  setState('connecting', { text: `Connecting to ${device.name}…` });
  try {
    const companion = await Promise.all([
      sim.startCompanion(device.udid, { onExit: (e) => fail(s, e), onError: (e) => session === s && toast(e.message) }),
      startVideo(s),
    ]).then(([c]) => c);
    if (session !== s) return companion.close();
    s.companion = companion;
    s.screen = companion.screen;
  } catch (e) {
    return fail(s, e);
  }
  showing = device.udid;
  context.globalState.update('udid', showing);
  setState('live');
}

async function pickDevice() {
  let devices;
  try {
    devices = await sim.listDevices();
  } catch (e) {
    return vscode.window.showErrorMessage(`Couldn't list simulators: ${e.message}`);
  }
  const current = session && session.device.udid;
  const item = (d) => ({
    label: `$(${d.udid === current ? 'check' : d.booted ? 'device-mobile' : 'circle-outline'}) ${d.name}`,
    description: `iOS ${d.ios}`,
    device: d,
  });
  const group = (label, list) => (list.length ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...list.map(item)] : []);
  const pick = await vscode.window.showQuickPick(
    [...group('Running', devices.filter((d) => d.booted)), ...group('Shut down (choosing one boots it)', devices.filter((d) => !d.booted))],
    { placeHolder: 'Choose a simulator', matchOnDescription: true },
  );
  if (!pick || !view) return;
  const d = pick.device;
  if (!d.booted) {
    stop();
    setState('connecting', { text: `Booting ${d.name}…` });
    try {
      await sim.boot(d.udid);
    } catch (e) {
      return setState('error', { text: e.message });
    }
  }
  connect(d.udid);
}

// Hardware button: press and release. double: press twice (a double-press of Home opens the app switcher).
function button(name, double) {
  const c = session && session.companion;
  if (!c) return;
  const code = sim.BUTTON[name];
  const tap = (t) => (setTimeout(() => c.send(sim.HID.button(code, true)), t), setTimeout(() => c.send(sim.HID.button(code, false)), t + 60));
  tap(0);
  if (double) tap(180);
}

// Stop: ends the stream and input; the simulator keeps running.
function stopByUser() {
  stop();
  stoppedByUser = true;
  setState('stopped');
}

// Cmd+key in the simulator. After a copy or cut, the simulator's pasteboard goes to the Mac's clipboard.
const CMD = 227; // Left GUI
function command(usage, copied) {
  const s = session;
  if (!s || !s.companion) return;
  for (const [code, down] of [[CMD, true], [usage, true], [usage, false], [CMD, false]]) s.companion.send(sim.HID.key(code, down));
  if (copied)
    setTimeout(() => sim.pbpaste(s.device.udid).then((t) => t && vscode.env.clipboard.writeText(t), () => {}), 300);
}

async function onMessage(m) {
  const s = session;
  switch (m.type) {
    case 'hello': // the page (re)loaded: it needs the state, and a fresh decoder config and keyframe
      if (s) return post(state), startVideo(s).catch((e) => fail(s, e));
      return stoppedByUser ? post(state) : connect();
    case 'touch': // x, y: 0..1 across the screen
      return s && s.companion && s.companion.send(sim.HID.touch(m.x * s.screen.w, m.y * s.screen.h, m.phase !== 'up'));
    case 'key':
      return s && s.companion && s.companion.send(sim.HID.key(m.usage, m.down));
    case 'command':
      return command(m.usage, m.copied);
    case 'paste': {
      if (!s || !s.companion) return;
      try {
        await sim.pbcopy(s.device.udid, await vscode.env.clipboard.readText());
      } catch (e) {
        return toast(`Paste: ${e.message}`);
      }
      return command(25); // V
    }
    case 'button': // the bar under the screen, or a home-indicator swipe
      return button(m.name === 'LOCK' ? 'LOCK' : 'HOME', m.double);
    case 'stop':
      return stopByUser();
    case 'retry':
    case 'start':
      return connect();
    case 'pick':
      return pickDevice();
    case 'stats': // the page's decode stats; check.js and README "Check" use them
      if (process.env.SIM_VIEWER_STATS) require('fs').appendFileSync(process.env.SIM_VIEWER_STATS, JSON.stringify(m) + '\n');
  }
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media('view.css')}">
</head><body>
<div id="stage">
  <canvas id="screen" tabindex="0" aria-label="Simulator screen. Click to touch, drag to swipe, type when focused." hidden></canvas>
  <div id="controls" role="toolbar" aria-label="Simulator" hidden></div>
  <div id="card" role="status"></div>
  <div id="toast" role="alert" hidden></div>
</div>
<script nonce="${nonce}" src="${media('view.js')}"></script>
</body></html>`;
}

exports.activate = (ctx) => {
  context = ctx;
  showing = ctx.globalState.get('udid', null);
  const reg = (id, f) => vscode.commands.registerCommand(id, f);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('iosSim.view', {
      resolveWebviewView(v) {
        view = v;
        v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] };
        const subs = [
          v.webview.onDidReceiveMessage(onMessage),
          // Hidden: stop, so nothing runs in the background. Shown again: the page reloads and says hello.
          v.onDidChangeVisibility(() => (v.visible ? !session && !stoppedByUser && connect() : stop())),
        ];
        v.onDidDispose(() => {
          if (view === v) (view = null), stop();
          subs.forEach((d) => d.dispose());
        });
        v.webview.html = html(v.webview);
      },
    }),
    reg('iosSim.open', () => vscode.commands.executeCommand('iosSim.view.focus')),
    reg('iosSim.pick', pickDevice),
    reg('iosSim.home', () => button('HOME')),
    reg('iosSim.lock', () => button('LOCK')),
    reg('iosSim.reload', () => connect()),
    reg('iosSim.stop', stopByUser),
    reg('iosSim.start', () => connect()),
    { dispose: stop },
  );
};
exports.deactivate = stop;
