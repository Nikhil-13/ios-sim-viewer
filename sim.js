// Simulator plumbing, with no idb CLI and no Python:
// - simctl: the device list, boot, pasteboard;
// - idb_companion's gRPC API on a private Unix socket (node:http2 plus a tiny protobuf codec): screen size, and
//   touches, keys and buttons as one live HID stream. The companion speaks Xcode 27's new HID service (dtuhidd);
//   the older Indigo messages no longer deliver keys or buttons there;
// - `sim-video stream` (ships with idb-companion): the screen as H.264 in fragmented MP4, one frame per fragment.
// Docs: README.md
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http2 = require('http2');
const net = require('net');
const os = require('os');
const path = require('path');

// VS Code started from the Dock doesn't get the shell PATH; idb-companion lives in Homebrew.
const env = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };
const run = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { env }, (err, out, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(out)));
    if (input !== undefined) p.stdin.end(input);
  });
const DEVICE_SET = path.join(os.homedir(), 'Library/Developer/CoreSimulator/Devices');

// --- simctl ---

// Every available iOS simulator, booted ones first. A device can appear under more than one runtime: keep the first.
async function listDevices() {
  const { devices } = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const seen = new Set();
  const out = [];
  for (const [runtime, list] of Object.entries(devices)) {
    const m = /SimRuntime\.iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) continue;
    for (const d of list) {
      if (seen.has(d.udid)) continue;
      seen.add(d.udid);
      out.push({ udid: d.udid, name: d.name, ios: `${m[1]}.${m[2]}`, booted: d.state === 'Booted' });
    }
  }
  return out.sort((a, b) => b.booted - a.booted || a.name.localeCompare(b.name));
}

const boot = (udid) => run('xcrun', ['simctl', 'boot', udid]).catch((e) => { if (!/current state: Booted/.test(e.message)) throw e; });
const pbcopy = (udid, text) => run('xcrun', ['simctl', 'pbcopy', udid], text);
const pbpaste = (udid) => run('xcrun', ['simctl', 'pbpaste', udid]);

// --- idb-companion binaries ---

const INSTALL = 'Needs idb-companion 1.7.8 or later. Run: brew install idb-companion (or brew upgrade idb-companion)';
let tools;
async function findTools() {
  if (tools) return tools;
  let companion;
  try {
    companion = fs.realpathSync((await run('sh', ['-c', 'command -v idb_companion'])).trim());
  } catch {
    throw new Error(INSTALL);
  }
  const dir = path.dirname(companion);
  const video = [path.join(dir, 'sim-video'), path.join(dir, '../libexec/sim-video')].find((f) => fs.existsSync(f));
  if (!video) throw new Error(INSTALL);
  return (tools = { companion, video });
}

// Keeps the last lines a process wrote to stderr, for error messages.
const tailOf = (stream) => {
  let log = '';
  stream.on('data', (d) => (log = (log + d).slice(-4000)));
  return () => log.trim().split('\n').pop() || '';
};

// --- protobuf: just the parts of idb.proto used here ---

const varint = (n) => {
  const b = [];
  for (; n > 127; n = Math.floor(n / 128)) b.push((n % 128) | 128);
  b.push(n);
  return Buffer.from(b);
};
const msg = (no, ...parts) => {
  const m = Buffer.concat(parts);
  return Buffer.concat([varint((no << 3) | 2), varint(m.length), m]);
};
const int = (no, v) => Buffer.concat([varint(no << 3), varint(v)]);
const dbl = (no, v) => {
  const b = Buffer.alloc(9);
  b[0] = (no << 3) | 1;
  b.writeDoubleLE(v, 1);
  return b;
};

// Field number -> list of values (numbers, or Buffers for nested messages and strings).
function decode(buf) {
  const out = {};
  let i = 0;
  const read = () => {
    let n = 0;
    for (let shift = 1, b; ; shift *= 128) {
      b = buf[i++];
      n += (b & 127) * shift;
      if (!(b & 128)) return n;
    }
  };
  while (i < buf.length) {
    const tag = read();
    const wire = tag & 7;
    let v;
    if (wire === 0) v = read();
    else if (wire === 1) (v = buf.readDoubleLE(i)), (i += 8);
    else if (wire === 2) {
      const len = read();
      v = buf.subarray(i, (i += len));
    } else if (wire === 5) (v = buf.readFloatLE(i)), (i += 4);
    else throw new Error(`protobuf: unexpected wire type ${wire}`);
    (out[tag >>> 3] = out[tag >>> 3] || []).push(v);
  }
  return out;
}

// HIDEvent { press: HIDPress { action: HIDPressAction { touch | button | key }, direction: DOWN 0 | UP 1 } }.
// A touch DOWN at a new point while already down moves the finger.
const press = (action, down) => msg(1, msg(1, action), int(2, down ? 0 : 1));
const HID = {
  touch: (x, y, down) => press(msg(1, msg(1, dbl(1, x), dbl(2, y))), down), // points
  button: (button, down) => press(msg(2, int(1, button)), down),
  key: (usage, down) => press(msg(3, int(1, usage)), down), // USB HID keyboard usage
};
const BUTTON = { HOME: 1, LOCK: 2 };

const grpcFrame = (m) => {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(m.length, 1);
  return Buffer.concat([h, m]);
};
const grpcError = (h) => h['grpc-status'] && h['grpc-status'] !== '0' && new Error(decodeURIComponent(h['grpc-message'] || `gRPC status ${h['grpc-status']}`));

// --- companion ---

let seq = 0;

// Starts a companion for one simulator on a private socket. Resolves with its screen size (points) and send(event).
// onExit(error): the companion died. onError(error): an input event failed (the stream reopens on the next one).
async function startCompanion(udid, { onExit, onError }) {
  const { companion } = await findTools();
  const sock = path.join(os.tmpdir(), `ios-sim-${process.pid}-${++seq}.sock`);
  // --idle-shutdown-time: if VS Code dies without stopping it, it exits once the HID stream drops.
  const p = spawn(companion, ['--udid', udid, '--grpc-domain-sock', sock, '--idle-shutdown-time', '20'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const last = tailOf(p.stderr);
  let closed = false;
  let client;
  let hid = null;
  const close = () => {
    if (closed) return;
    closed = true;
    if (hid) hid.end();
    if (client) client.close();
    p.kill();
    fs.rm(sock, { force: true }, () => {});
  };
  const exited = (code) => new Error(`idb_companion exited (${code}): ${last()}`);

  await new Promise((resolve, reject) => {
    p.stdout.once('data', resolve); // it prints {"grpc_path": ...} once listening
    p.once('error', reject);
    p.once('exit', (code) => reject(exited(code)));
  });
  p.once('exit', (code) => closed || (close(), onExit(exited(code))));

  client = http2.connect('http://localhost', { createConnection: () => net.connect(sock) });
  client.on('error', () => {}); // reported by the calls that fail
  const call = (method) =>
    client.request({ ':method': 'POST', ':path': `/idb.CompanionService/${method}`, 'content-type': 'application/grpc', te: 'trailers' });

  const unary = (method, request) =>
    new Promise((resolve, reject) => {
      const s = call(method);
      const chunks = [];
      let error = null;
      s.on('response', (h) => (error = error || grpcError(h)));
      s.on('trailers', (h) => (error = error || grpcError(h)));
      s.on('data', (c) => chunks.push(c));
      s.on('error', reject);
      s.on('end', () => (error ? reject(error) : resolve(decode(Buffer.concat(chunks).subarray(5)))));
      s.end(grpcFrame(request));
    });

  // One long-lived HID stream; reopened if the companion ends it (for example after a bad event).
  const openHid = () => {
    const s = (hid = call('hid'));
    s.on('data', () => {});
    s.on('trailers', (h) => grpcError(h) && !closed && onError(grpcError(h)));
    s.on('error', (e) => !closed && onError(e));
  };
  const send = (event) => {
    if (closed) return;
    if (!hid || hid.closed || hid.destroyed) openHid();
    hid.write(grpcFrame(event));
  };

  try {
    // TargetDescriptionResponse.target_description(1).screen_dimensions(3).{width_points 4, height_points 5}
    const response = await unary('describe', Buffer.alloc(0));
    const dims = decode(decode(response[1][0])[3][0]);
    openHid(); // opened now so the companion counts as busy and doesn't idle out
    return { screen: { w: dims[4][0], h: dims[5][0] }, send, close };
  } catch (e) {
    close();
    throw e;
  }
}

// --- screen ---

// `sim-video stream` in fragmented MP4: an init segment (ftyp, moov with the avcC decoder config), then one
// moof + mdat per frame. It sends a frame only when the screen changes, and a keyframe every second.
// onConfig({codec, description, width, height}) on each init segment; onFrame(data, key) per frame (AVCC NAL units).
async function startVideo(udid, { onConfig, onFrame, onExit }) {
  const { video } = await findTools();
  // stdin stays open: sim-video stops when it closes, so it also stops if VS Code dies.
  const args = ['stream', '--set', DEVICE_SET, '--udid', udid, '--encoding', 'h264', '--transport', 'fmp4', '--key-frame-rate', '1', '-'];
  const p = spawn(video, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const last = tailOf(p.stderr);
  let closed = false;
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(0);
      if (size < 8) return p.kill(); // 64-bit or open-ended boxes: sim-video doesn't write them
      if (buf.length < size) break;
      const type = buf.toString('latin1', 4, 8);
      const box = buf.subarray(0, size);
      buf = buf.subarray(size);
      if (type === 'moov') onConfig(avcConfig(box));
      else if (type === 'mdat') onFrame(box.subarray(8), isKeyframe(box.subarray(8)));
    }
  });
  p.on('error', (e) => closed || onExit(e));
  p.on('exit', (code) => closed || onExit(new Error(`sim-video exited (${code}): ${last()}`)));
  return {
    close() {
      if (closed) return;
      closed = true;
      p.stdin.end(); // asks it to stop cleanly
      setTimeout(() => p.kill(), 1000).unref();
    },
  };
}

// From the moov box: the avc1 sample entry (width, height) and its avcC box (the decoder's description).
function avcConfig(moov) {
  const entry = moov.indexOf('avc1'); // then 24 bytes of fixed fields, width, height
  const at = moov.indexOf('avcC');
  const avcC = moov.subarray(at + 4, at - 4 + moov.readUInt32BE(at - 4));
  return {
    codec: `avc1.${avcC.subarray(1, 4).toString('hex')}`,
    description: new Uint8Array(avcC),
    width: moov.readUInt16BE(entry + 28),
    height: moov.readUInt16BE(entry + 30),
  };
}

// AVCC: 4-byte length-prefixed NAL units; type 5 is an IDR slice.
function isKeyframe(data) {
  for (let i = 0; i + 4 < data.length; i += 4 + data.readUInt32BE(i)) if ((data[i + 4] & 31) === 5) return true;
  return false;
}

module.exports = { listDevices, boot, pbcopy, pbpaste, startCompanion, startVideo, HID, BUTTON, decode };
