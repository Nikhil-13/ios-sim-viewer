// Self-check, outside VS Code: `node check.js` with a simulator booted. Loads the extension with a fake `vscode`,
// opens the view on a fake webview and checks: it goes live with a decoder config and H.264 frames (the first a
// keyframe), input goes through without errors (and a drag makes the screen send frames), Stop leaves nothing
// running and Start comes back, a page reload restarts only the video, Reload and closing the view leave exactly
// the processes they should.
const Module = require('module');
const assert = require('assert');
const { execSync } = require('child_process');

let provider;
const commands = {};
const fake = {
  window: {
    registerWebviewViewProvider: (_id, p) => ((provider = p), { dispose() {} }),
    showQuickPick: async () => undefined,
    showErrorMessage: (m) => console.error('error message:', m),
  },
  commands: {
    registerCommand: (id, f) => ((commands[id] = f), { dispose() {} }),
    executeCommand: async () => {},
  },
  Uri: { joinPath: (base, ...p) => ({ path: [base.path, ...p].join('/') }) },
  QuickPickItemKind: { Separator: -1 },
  env: { clipboard: { readText: async () => '', writeText: async () => {} } },
};
const load = Module._load;
Module._load = (req, ...rest) => (req === 'vscode' ? fake : load(req, ...rest));
require('./extension.js').activate({ subscriptions: [], extensionUri: { path: __dirname }, globalState: { get: () => null, update: () => {} } });

let state = null;
let config = null;
const frames = [];
const toasts = [];
let listeners = [];
let disposeView;
const send = (m) => listeners.forEach((f) => f(m));
const view = {
  visible: true,
  description: '',
  webview: {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (u) => u.path,
    postMessage: async (m) => {
      if (m.type === 'state') state = m;
      else if (m.type === 'config') config = m;
      else if (m.type === 'frame') frames.push(m);
      else if (m.type === 'toast') toasts.push(m.text);
    },
    onDidReceiveMessage: (f) => (listeners.push(f), { dispose: () => (listeners = listeners.filter((x) => x !== f)) }),
  },
  onDidChangeVisibility: () => ({ dispose() {} }),
  onDidDispose: (f) => ((disposeView = f), { dispose() {} }),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, ok, secs = 20) => {
  for (let i = 0; i < secs * 10 && !ok(); i++) await sleep(100);
  assert(ok(), `${what} (state: ${JSON.stringify(state)})`);
};
const count = (pattern) => execSync('ps -axo command').toString().split('\n').filter((l) => pattern.test(l)).length;
const videos = () => count(/sim-video stream/);
const companions = () => count(/idb_companion .*--grpc-domain-sock .*ios-sim-/);
const drag = async () => {
  send({ type: 'touch', phase: 'down', x: 0.7, y: 0.5 });
  for (let i = 1; i <= 15; i++) await sleep(16), send({ type: 'touch', phase: 'move', x: 0.7 - 0.02 * i, y: 0.5 });
  send({ type: 'touch', phase: 'up', x: 0.4, y: 0.5 });
  await sleep(600);
  send({ type: 'touch', phase: 'down', x: 0.3, y: 0.5 }); // and back
  for (let i = 1; i <= 15; i++) await sleep(16), send({ type: 'touch', phase: 'move', x: 0.3 + 0.02 * i, y: 0.5 });
  send({ type: 'touch', phase: 'up', x: 0.6, y: 0.5 });
};

(async () => {
  const v0 = videos();
  const c0 = companions();

  provider.resolveWebviewView(view);
  assert(/view\.js/.test(view.webview.html) && /Content-Security-Policy/.test(view.webview.html), 'page loads view.js under a CSP');
  send({ type: 'hello' });
  await until('goes live', () => state && state.state === 'live');
  assert(view.description, 'the view says which simulator it shows');
  await until('decoder config arrives', () => config);
  assert(/^avc1\.[0-9a-f]{6}$/.test(config.codec) && config.description.length > 0 && config.width > 0 && config.height > 0, 'config is H.264 with avcC');
  await until('first frame arrives', () => frames.length > 0);
  assert(frames[0].key && frames[0].data instanceof Uint8Array && !Buffer.isBuffer(frames[0].data), 'first frame is a keyframe, sent as a plain Uint8Array');
  assert.strictEqual(videos(), v0 + 1, 'one sim-video');
  assert.strictEqual(companions(), c0 + 1, 'one companion');

  // Input: a drag makes the screen move (so frames come), a no-op key reports no error.
  const before = frames.length;
  await drag();
  send({ type: 'key', usage: 0, down: true });
  send({ type: 'key', usage: 0, down: false });
  await sleep(800);
  assert(frames.length - before > 10, `a drag streams frames (${frames.length - before})`);
  assert.deepStrictEqual(toasts, [], 'input reports no error');

  // The page reloads (hello again): only the video restarts, with a fresh config and keyframe.
  config = null;
  frames.length = 0;
  send({ type: 'hello' });
  await until('fresh config after a page reload', () => config && frames.length > 0 && frames[0].key);
  await until('still one sim-video and one companion', () => videos() === v0 + 1 && companions() === c0 + 1, 5);

  // Stop: nothing left running, no frames; Start: back.
  commands['iosSim.stop']();
  assert.strictEqual(state.state, 'stopped', 'Stop turns the viewer off');
  await until('Stop ends both processes', () => videos() === v0 && companions() === c0, 5);
  frames.length = 0;
  await drag();
  assert.strictEqual(frames.length, 0, 'no frames while off');
  commands['iosSim.start']();
  await until('Start goes live again', () => state.state === 'live' && frames.length > 0);

  // Reload twice in a row: still exactly one of each, and the listeners don't pile up.
  const n = listeners.length;
  commands['iosSim.reload']();
  commands['iosSim.reload']();
  await until('Reload goes live', () => state.state === 'live');
  await until('one sim-video and one companion after Reload', () => videos() === v0 + 1 && companions() === c0 + 1, 5);
  assert.strictEqual(listeners.length, n, 'Reload adds no listeners');

  // Closing the view stops everything.
  disposeView();
  await until('closing the view ends both processes', () => videos() === v0 && companions() === c0, 5);
  console.log(`ok: ${view.description}, ${config.width}x${config.height} ${config.codec}`);
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
