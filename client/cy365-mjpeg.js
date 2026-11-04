#!/usr/bin/env node
'use strict';
/*
 * cy365-mjpeg.js — native, appless client for CY365 / SHIX (shix.cy.camera) cameras.
 *
 * These cameras (e.g. CYCAM_T99, Beken BK7252, DID prefix "EEE") speak the CS2
 * "PPPP" P2P protocol wrapped in a custom XOR stream cipher. This client:
 *   1. rendezvous: Hello + P2pReq(DID) to the CS2 super-nodes (:32100)
 *   2. hole-punch: the camera punches back; we learn its (LAN) endpoint
 *   3. session:   PunchPkt/P2pRdy + P2PAlive keepalives
 *   4. control:   DRW channel 0, plaintext JSON  {"pro":..,"cmd":..,"user":..,"pwd":..}
 *                 login (check_user) then start video (stream/111)
 *   5. video:     DRW channel 1, 55aa frame header + MJPEG; we carve JPEGs
 * and serves the result at http://<host>:<httpPort>/  (+ /snapshot, /stream).
 *
 * Transport cipher: aiopppp XOR1 keystream table + ENC_KEY [3c c4 68 0a]
 * (recovered from the device's libobject_jni.so and verified against a capture).
 *
 * Usage:
 *   node cy365-mjpeg.js --did EEE-123456-ABCDE --pwd 6666 [--user admin] \
 *        [--cam-ip 192.168.0.50] [--http 8090] [--debug]
 */

const dgram = require('dgram');
const http = require('http');
const os = require('os');

// ---- args ----------------------------------------------------------------
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const DID       = arg('did', 'EEE-123456-ABCDE');
const USER      = arg('user', 'admin');
const PWD       = arg('pwd', '6666');
const CAM_IP    = arg('cam-ip', '');           // optional hint; else learned from punch
const HTTP_PORT = parseInt(arg('http', '8090'), 10);
const DEBUG     = process.argv.includes('--debug');
// optional HTTP basic auth for the local server: --auth user:pass (empty = open)
const AUTH      = arg('auth', '');
const SUPERNODES = (arg('supernodes', '8.129.214.91,8.131.242.166,101.32.177.97')).split(',');
const SN_PORT   = 32100;
const log = (...a) => console.error(...a);
const dbg = (...a) => { if (DEBUG) console.error(...a); };

// ---- transport cipher (chained XOR; aiopppp table + this device's ENC_KEY) --
const TABLE = Buffer.from(
  '7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3' +
  '88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42' +
  '37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b73' +
  '36c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17', 'hex');
const EK = [0x3c, 0xc4, 0x68, 0x0a];
const ks = (prev) => TABLE[(EK[prev & 3] + prev) & 0xff];
function decode(buf) { const o = Buffer.alloc(buf.length); let prev = 0; for (let i = 0; i < buf.length; i++) { o[i] = buf[i] ^ ks(prev); prev = buf[i]; } return o; }
function encode(buf) { const o = Buffer.alloc(buf.length); let prev = 0; for (let i = 0; i < buf.length; i++) { o[i] = buf[i] ^ ks(prev); prev = o[i]; } return o; }

// ---- CS2 packet helpers --------------------------------------------------
const T = { Hello: 0x00, LanSearch: 0x30, P2pReq: 0x20, PunchTo: 0x40, PunchPkt: 0x41, P2pRdy: 0x42, P2PAlive: 0xe0, P2PAliveAck: 0xe1, Drw: 0xd0, DrwAck: 0xd1, Close: 0xf0 };
// PunchTo payload: <fam BE: 0x0002=WAN, 0x0000=LAN> <port BE> <ipv4 little-endian> ...
function parseEndpoint(p) { if (p.length < 8) return null; return { fam: p.readUInt16BE(0), port: p.readUInt16BE(2), address: `${p[7]}.${p[6]}.${p[5]}.${p[4]}` }; }
function pkt(type, payload = Buffer.alloc(0)) { const h = Buffer.alloc(4); h[0] = 0xf1; h[1] = type; h.writeUInt16BE(payload.length, 2); return Buffer.concat([h, payload]); }

// DID "EEE-123456-ABCDE" -> 20-byte block: prefix(4) + serial(8 BE) + suffix(8)
function didBlock(did) {
  const [prefix, serialStr, suffix] = did.split('-');
  const b = Buffer.alloc(20);
  Buffer.from(prefix, 'ascii').copy(b, 0);
  b.writeBigUInt64BE(BigInt(parseInt(serialStr, 10)), 4);
  Buffer.from(suffix, 'ascii').copy(b, 12);
  return b;
}
// P2pReq payload is the 20-byte DID block + 16 trailing bytes (const observed on the wire)
function p2pReqPayload(did) { return Buffer.concat([didBlock(did), Buffer.from('0000000002263f000000000000000000', 'hex')]); }

// ---- DRW (reliable channel) ----------------------------------------------
function drw(chan, idx, data) {
  const sub = Buffer.alloc(4); sub[0] = 0xd1; sub[1] = chan; sub.writeUInt16BE(idx & 0xffff, 2);
  return pkt(T.Drw, Buffer.concat([sub, data]));
}
function drwAck(chan, idxs) {
  const p = Buffer.alloc(4 + idxs.length * 2); p[0] = 0xd1; p[1] = chan; p.writeUInt16BE(idxs.length, 2);
  idxs.forEach((v, i) => p.writeUInt16BE(v & 0xffff, 4 + i * 2));
  return pkt(T.DrwAck, p);
}
// control command framing: 06 0a a0 80 <len32 LE> <json>
const FMT = parseInt((() => { const i = process.argv.indexOf('--fmt'); return i >= 0 ? process.argv[i + 1] : '1'; })(), 10);
function ctrlFrame(obj) {
  const j = Buffer.from(JSON.stringify(obj), 'ascii');
  const h = Buffer.alloc(8);
  Buffer.from('060aa080', 'hex').copy(h, 0);
  switch (FMT) {
    case 2: h.writeUInt32BE(j.length, 4); break;          // longitud big-endian
    case 3: return j;                                      // JSON pelado, sin cabecera
    case 4: h.writeUInt32LE(j.length + 8, 4); break;       // longitud incluyendo cabecera
    case 5: h.writeUInt16LE(j.length, 4); break;           // longitud 16 bits
    default: h.writeUInt32LE(j.length, 4); break;          // 1 = LE (repo)
  }
  return Buffer.concat([h, j]);
}

// ---- session state -------------------------------------------------------
const sock = dgram.createSocket('udp4');
let cam = null;                 // {address, port} of the camera once punched
let wanFallback = null;         // WAN PunchTo endpoint, used if no LAN one arrives
let rdvStart = Date.now();      // when rendezvous began
let sessionUp = false;
let lastCamPacket = Date.now(); // for session-death watchdog (battery cam sleeps)
function resetSession(why) {
  log(`[SESSION] lost (${why}) — re-discovering`);
  cam = null; wanFallback = null; sessionUp = false; streamStarted = false;
  for (const k of Object.keys(recvChan)) delete recvChan[k];
  for (const k of Object.keys(nextIdx)) delete nextIdx[k];
  vbuf = Buffer.alloc(0);
}
let txIdx = 0;                  // our DRW ch0 send index
const recvChan = { 0: {}, 1: {} }; // reassembly buffers per channel
const ackQueue = { 0: [], 1: [] };

function sendTo(dst, raw) { const e = encode(raw); sock.send(e, dst.port, dst.address); }
function sendCam(raw) { if (cam) sendTo(cam, raw); }

function sendCtrl(obj) {
  const data = ctrlFrame(obj);
  // small commands fit one DRW packet
  sendCam(drw(0, txIdx++, data));
  dbg('[TX ctrl]', JSON.stringify(obj));
}

// ---- video reassembly (carve JPEGs from chan-1 stream) -------------------
let vbuf = Buffer.alloc(0);
let latestJpeg = null, latestAt = 0, frameCount = 0, bytesTotal = 0;
const clients = new Set();
// Video frames on chan1 are: [32-byte "55 aa" header, JPEG length LE at offset 16] + JPEG.
// Parse that framing (robust) rather than scanning for FF D8/FF D9 (false markers desync).
function feedVideo(data) {
  vbuf = vbuf.length ? Buffer.concat([vbuf, data]) : data;
  for (;;) {
    const m = vbuf.indexOf('55aa', 0, 'hex');
    if (m < 0) { if (vbuf.length > 4 << 20) vbuf = vbuf.slice(-2); break; }
    if (vbuf.length < m + 32) { if (m > 0) vbuf = vbuf.slice(m); break; }
    const jlen = vbuf.readUInt32LE(m + 16);
    if (jlen < 100 || jlen > 500000) { vbuf = vbuf.slice(m + 2); continue; } // bad header, resync
    if (vbuf.length < m + 32 + jlen) { if (m > 0) vbuf = vbuf.slice(m); break; } // wait for full frame
    const frame = vbuf.slice(m + 32, m + 32 + jlen);
    vbuf = vbuf.slice(m + 32 + jlen);
    // emit only complete JPEGs (FF D8 … FF D9); drop torn frames from UDP loss/reorder
    if (frame[0] === 0xff && frame[1] === 0xd8) {
      const eoi = frame.lastIndexOf(0xd9);
      if (eoi > 2 && frame[eoi - 1] === 0xff) pushJpeg(frame.slice(0, eoi + 1));
    }
  }
}
function pushJpeg(j) {
  latestJpeg = j; latestAt = Date.now(); frameCount++; bytesTotal += j.length;
  if (frameCount === 1 || frameCount % 30 === 0) log(`[VIDEO] frame ${frameCount} (${j.length} bytes)`);
  broadcast(j);
}
// reenvía un frame ya recibido (al conectar un visor nuevo, sin contarlo como nuevo)
function broadcast(j) {
  for (const res of clients) { try { res.write(`--f\r\nContent-Type: image/jpeg\r\nContent-Length: ${j.length}\r\n\r\n`); res.write(j); res.write('\r\n'); } catch {} }
}

// ---- incoming packet handling --------------------------------------------
sock.on('message', (enc, rinfo) => {
  const d = decode(enc);
  if (d[0] !== 0xf1) return;
  const type = d[1];
  dbg(`[RX] ${rinfo.address}:${rinfo.port} type=0x${type.toString(16)} len=${enc.length}`);
  const fromCam = cam ? (rinfo.address === cam.address && rinfo.port === cam.port)
                      : (CAM_IP ? rinfo.address === CAM_IP : rinfo.port !== SN_PORT && rinfo.address.startsWith('192.168.'));
  if (fromCam) lastCamPacket = Date.now();

  if (!cam && fromCam && (type === T.P2pRdy || type === T.PunchPkt || type === T.Drw || type === T.P2PAlive)) {
    cam = { address: rinfo.address, port: rinfo.port };
    log(`[SESSION] camera punched from ${cam.address}:${cam.port} (type 0x${type.toString(16)})`);
    // complete handshake
    sendCam(pkt(T.PunchPkt, didBlock(DID)));
    sendCam(pkt(T.P2pRdy, didBlock(DID)));
    sendCam(pkt(T.P2PAlive));
  }
  // super-node PunchTo tells us the camera's endpoint (public + LAN); prefer LAN
  if (!sessionUp && type === T.PunchTo && rinfo.port === SN_PORT) {
    const ep = parseEndpoint(d.slice(4));
    if (ep) {
      const isLan = ep.address.startsWith('192.168.') || ep.address.startsWith('10.') || ep.address.startsWith('172.');
      const target = isLan ? { address: ep.address, port: ep.port } : { address: CAM_IP || ep.address, port: ep.port };
      // keep refreshing the endpoint until the session is actually up (ports can be stale)
      if (!cam || cam.port !== target.port || cam.address !== target.address) {
        cam = target;
        log(`[SESSION] PunchTo(fam=0x${ep.fam.toString(16)}) -> punching camera at ${cam.address}:${cam.port}`);
      }
      for (let k = 0; k < 4; k++) { sendCam(pkt(T.PunchPkt, didBlock(DID))); sendCam(pkt(T.P2pRdy, didBlock(DID))); }
      sendCam(pkt(T.P2PAlive));
    }
    return;
  }
  if (!fromCam && !cam) return; // ignore remaining super-node bookkeeping

  switch (type) {
    case T.P2pRdy:
      if (!sessionUp) { sessionUp = true; log('[SESSION] up — logging in + starting stream'); startStream(); }
      break;
    case T.P2PAlive: sendCam(pkt(T.P2PAliveAck)); break;
    case T.P2PAliveAck: break;
    case T.DrwAck: break;
    case T.Drw: {
      const chan = d[5], idx = d.readUInt16BE(6), data = d.slice(8);
      sendCam(drwAck(chan, [idx]));
      if (chan === 1) { feedVideo(data); }          // video: arrival order (keeps camera streaming)
      else { if (!recvChan[chan]) recvChan[chan] = {}; if (nextIdx[chan] === undefined) nextIdx[chan] = idx; recvChan[chan][idx] = data; drainChannel(chan); }
      break;
    }
  }
});

// deliver DRW payloads in index order; tolerate a genuinely lost packet by skipping
// it once many later packets have piled up (the reliable channel normally retransmits first).
const nextIdx = {};
function drainChannel(chan) {
  const buf = recvChan[chan];
  for (;;) {
    if (buf[nextIdx[chan]] !== undefined) {
      const data = buf[nextIdx[chan]];
      delete buf[nextIdx[chan]];
      nextIdx[chan] = (nextIdx[chan] + 1) & 0xffff;
      if (chan === 1) feedVideo(data);
      else if (chan === 0 && DEBUG) {
        const s = data.toString('ascii');
        dbg('[RX ctrl raw]', data.toString('hex'), '|', s.replace(/[^\x20-\x7e]/g, '.'));
      }
    } else if (Object.keys(buf).length > 64) {
      nextIdx[chan] = (nextIdx[chan] + 1) & 0xffff; // lost packet — skip to avoid a permanent stall
    } else break;
  }
}

// ---- startup / control ---------------------------------------------------
let streamStarted = false;
function startStream() {
  if (streamStarted) return; streamStarted = true;
  if (process.argv.includes('--nocontrol')) { log('[CTRL] desactivado (--nocontrol)'); return; }
  const cred = { user: USER, pwd: PWD };
  const DEVMAC = arg('devmac', '0000');
  const VIDEO_Q = parseInt(arg('video', '1'), 10);
  // OJO: en la unidad CYCAM_T99_v32_0226 de este usuario, mandar "check_user"
  // hace que la camara cierre la sesion (0xf0). Con "stream" a secas funciona.
  // Se deja "check_user" solo si se pide con --with-check.
  if (process.argv.includes('--with-check')) sendCtrl({ pro: 'check_user', cmd: 100, devmac: DEVMAC, ...cred });
  if (process.argv.includes('--onlycheck')) return;
  const CAMS = parseInt(arg('camsmode', '0'), 10);
  if (process.argv.includes('--onlystream')) { sendCtrl({ pro: 'stream', cmd: 111, video: VIDEO_Q, camsmode: CAMS, ...cred }); return; }
  sendCtrl({ pro: 'stream', cmd: 111, video: VIDEO_Q, camsmode: CAMS, ...cred });
  // resend a few times (matches app behaviour; DRW is reliable but be safe)
  let n = 0;
  const t = setInterval(() => {
    if (++n > 4 || frameCount > 0) return clearInterval(t);
    sendCtrl({ pro: 'stream', cmd: 111, video: VIDEO_Q, camsmode: 0, ...cred });
  }, 400);
}

// LAN discovery: broadcast the camera-ciphered LanSearch; the camera (when awake)
// replies with a PunchPkt from its LAN endpoint. No cloud/super-node needed.
// Broadcast targets: the global address plus this host's subnet broadcast (derived,
// so it works on any LAN), plus anything the user passes via --bcast.
function localBroadcast() {
  for (const ifs of Object.values(os.networkInterfaces()))
    for (const i of ifs)
      if (i.family === 'IPv4' && !i.internal) { const p = i.address.split('.'); return `${p[0]}.${p[1]}.${p[2]}.255`; }
  return null;
}
const BCAST = [...new Set(['255.255.255.255', localBroadcast(), ...arg('bcast', '').split(',')].filter(Boolean))];
function lanSearch() {
  const ls = pkt(T.LanSearch);
  for (const b of BCAST) sendTo({ address: b, port: 32108 }, ls);
  dbg('[LAN] broadcast LanSearch');
}
sock.bind(() => {
  try { sock.setBroadcast(true); } catch {}
  log(`[CY365] client for ${DID} (user=${USER}) bound on :${sock.address().port} — LAN discovery`);
  lanSearch();
  // keep broadcasting whenever we're not in a session (camera sleeps + wakes periodically)
  setInterval(() => { if (!sessionUp) lanSearch(); }, 500);
  setInterval(() => { if (cam) sendCam(pkt(T.P2PAlive)); }, 1000);
  // watchdog: if the camera goes quiet (it slept), tear down and re-discover
  setInterval(() => { if (sessionUp && Date.now() - lastCamPacket > 4000) resetSession('camera quiet'); }, 1000);
  // keep the stream alive: re-issue the stream request periodically if frames stall
  let lastFrames = 0;
  setInterval(() => {
    if (sessionUp && frameCount === lastFrames) sendCtrl({ pro: 'stream', cmd: 111, video: 1, camsmode: 0, user: USER, pwd: PWD });
    lastFrames = frameCount;
  }, 2000);
});

// ---- HTTP MJPEG server ---------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let INDEX = `<!doctype html><meta charset=utf-8><title>Camarita</title>
<style>body{margin:0;background:#111}img{max-width:100%}</style><img src="/stream">`;
try { INDEX = fs.readFileSync(path.join(__dirname, 'web', 'index.html'), 'utf8'); } catch { dbg('[HTTP] web/index.html no encontrado, uso la página mínima'); }

// estado para la web (fps, kb/s, edad del último frame)
let fps = 0, kbps = 0, lastCount = 0, lastBytes = 0, lastTick = Date.now();
function status() {
  return {
    up: sessionUp,
    frames: frameCount,
    fps: Math.round(fps * 10) / 10,
    kbps: Math.round(kbps),
    bytes: bytesTotal,
    age: latestAt ? Math.round((Date.now() - latestAt) / 100) / 10 : null,
    clients: clients.size,
    ts: Date.now(),
  };
}

// WebSocket mínimo (RFC 6455), sin dependencias: solo hace falta mandar estado.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wss = new Set();
function wsFrame(obj) {
  const p = Buffer.from(JSON.stringify(obj));
  const n = p.length;
  let h;
  if (n < 126) { h = Buffer.alloc(2); h[0] = 0x81; h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function wsSend(sock, obj) { try { sock.write(wsFrame(obj)); } catch {} }

function authorized(req) {
  if (!AUTH) return true;
  const h = req.headers.authorization || '';
  return h.startsWith('Basic ') && Buffer.from(h.slice(6), 'base64').toString() === AUTH;
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="camarita"' });
    res.end('auth required');
    return;
  }
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(INDEX); }
  else if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); }
  else if (url === '/status') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(status())); }
  else if (url === '/snapshot') { if (!latestJpeg) { res.writeHead(503); res.end('no frame'); return; } res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': latestJpeg.length, 'Cache-Control': 'no-store' }); res.end(latestJpeg); }
  else if (url === '/stream') { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=f', 'Cache-Control': 'no-store', 'Connection': 'close' }); clients.add(res); if (latestJpeg) broadcast(latestJpeg); req.on('close', () => clients.delete(res)); }
  else { res.writeHead(404); res.end(); }
});

server.on('upgrade', (req, sock) => {
  if (!authorized(req) || !req.headers['sec-websocket-key']) { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + WS_GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acc}\r\n\r\n`);
  wss.add(sock);
  const bye = () => wss.delete(sock);
  sock.on('close', bye);
  sock.on('error', bye);
  sock.on('data', (b) => { if ((b[0] & 0x0f) === 0x8) sock.end(); }); // close del cliente
  wsSend(sock, status());
});

server.listen(HTTP_PORT, () => log(`[HTTP] http://0.0.0.0:${HTTP_PORT}/  (web: /, snapshot: /snapshot, mjpeg: /stream, ws: /ws)`));

// difunde el estado a las webs conectadas, una vez por segundo
setInterval(() => {
  const now = Date.now();
  const dt = Math.max(0.001, (now - lastTick) / 1000);
  fps = (frameCount - lastCount) / dt;
  kbps = (bytesTotal - lastBytes) / dt / 1024;
  lastTick = now; lastCount = frameCount; lastBytes = bytesTotal;
  if (wss.size) { const st = status(); for (const s of wss) wsSend(s, st); }
}, 1000);
