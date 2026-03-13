require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const axios   = require('axios');
const { WebSocketServer } = require('ws');
const { request }   = require('./imouclient');
const StreamManager = require('./streammanager');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── Camera config ─────────────────────────────────────────────────────────────
// CAMERAS env var: "deviceId1:Label 1,deviceId2:Label 2"
// Falls back to legacy IMOU_DEVICE_ID for single-camera setups
function parseCameras() {
  if (process.env.CAMERAS) {
    return process.env.CAMERAS.split(',').map(entry => {
      const [id, ...rest] = entry.trim().split(':');
      return { id: id.trim(), label: rest.join(':').trim() || id.trim() };
    });
  }
  if (process.env.IMOU_DEVICE_ID) {
    return [{ id: process.env.IMOU_DEVICE_ID, label: 'CAM-01' }];
  }
  return [];
}
const CAMERAS = parseCameras();
console.log('[CONFIG] Cameras:', CAMERAS.map(c => `${c.id}(${c.label})`).join(', '));

// ── Stream manager ────────────────────────────────────────────────────────────
const mgr = new StreamManager();

// Per-device state: lock + active quality
const deviceState = {};  // { [deviceId]: { lock, quality, reconnecting } }
function getState(id) {
  if (!deviceState[id]) deviceState[id] = { lock: false, quality: 0, reconnecting: false };
  return deviceState[id];
}

// ── WebSocket server ──────────────────────────────────────────────────────────
// Clients subscribe to a device via ?device=DEVICE_ID
const wss = new WebSocketServer({ server, path: '/stream' });
const subscribers = new Map();  // Map<deviceId, Set<ws>>
const MAX_QUEUE   = 3;

function subscribe(deviceId, ws) {
  if (!subscribers.has(deviceId)) subscribers.set(deviceId, new Set());
  subscribers.get(deviceId).add(ws);
}
function unsubscribe(deviceId, ws) {
  subscribers.get(deviceId)?.delete(ws);
}
function broadcast(deviceId, data, opts = { binary: true }) {
  const subs = subscribers.get(deviceId);
  if (!subs) return;
  for (const ws of subs) {
    if (ws.readyState !== ws.OPEN) continue;
    ws._queue = ws._queue || [];
    ws._queue.push({ data, opts });
    while (ws._queue.length > MAX_QUEUE) ws._queue.shift();
    if (!ws._draining) drain(ws);
  }
}
function broadcastJson(deviceId, obj) {
  broadcast(deviceId, JSON.stringify(obj), { binary: false });
}
function drain(ws) {
  if (!ws._queue?.length) { ws._draining = false; return; }
  ws._draining = true;
  const { data, opts } = ws._queue.shift();
  try { ws.send(data, opts, () => drain(ws)); }
  catch (_) { ws._draining = false; }
}

wss.on('connection', (ws, req) => {
  const params   = new URL(req.url, 'http://localhost').searchParams;
  const deviceId = params.get('device');
  if (!deviceId || !CAMERAS.find(c => c.id === deviceId)) {
    ws.close(1008, 'Unknown device'); return;
  }

  ws._queue = []; ws._draining = false;
  subscribe(deviceId, ws);
  console.log(`[WS:${deviceId}] Client connected (${subscribers.get(deviceId).size} total)`);

  // Send cached init segment immediately so MSE can set up codec
  const init = mgr.getInit(deviceId);
  if (init) ws.send(init, { binary: true });

  ws.on('close', () => {
    unsubscribe(deviceId, ws);
    console.log(`[WS:${deviceId}] Client disconnected (${subscribers.get(deviceId)?.size || 0} total)`);
  });
  ws.on('error', err => console.error(`[WS:${deviceId}] Error:`, err.message));
});

mgr.on('init', (deviceId, chunk) => broadcast(deviceId, chunk));
mgr.on('data', (deviceId, chunk) => broadcast(deviceId, chunk));

// ── Auto-recover when FFmpeg dies ─────────────────────────────────────────────
mgr.on('end', async deviceId => {
  const state   = getState(deviceId);
  const viewers = subscribers.get(deviceId)?.size || 0;

  await unbindCurrent(deviceId).catch(() => {});

  if (!viewers || state.reconnecting || state.lock) return;

  state.reconnecting = true;
  console.log(`[RECOVER:${deviceId}] FFmpeg ended — auto-restarting in 3s`);
  broadcastJson(deviceId, { type: 'reconnecting' });

  await sleep(3000);
  try {
    const chosen = await bindAndGetUrl(deviceId, state.quality);
    const { ok }  = await fetchPlaylist(chosen.hls);
    if (!ok) throw new Error('Playlist not ready');

    await mgr.start(deviceId, chosen.hls);

    await new Promise((resolve, reject) => {
      if (mgr.getInit(deviceId)) return resolve();
      const t     = setTimeout(() => reject(new Error('init timeout')), 20000);
      const onEnd = (id) => { if (id === deviceId) { clearTimeout(t); reject(new Error('exited again')); } };
      mgr.once('init', (id) => { if (id === deviceId) { clearTimeout(t); mgr.removeListener('end', onEnd); resolve(); } });
      mgr.once('end', onEnd);
    });

    // Send fresh init to all subscribers so MSE resets
    const init = mgr.getInit(deviceId);
    if (init) broadcast(deviceId, init);
    broadcastJson(deviceId, { type: 'reconnected' });
    console.log(`[RECOVER:${deviceId}] Stream restored`);
  } catch (err) {
    console.error(`[RECOVER:${deviceId}] Failed:`, err.message);
    broadcastJson(deviceId, { type: 'stream_ended' });
    await unbindCurrent(deviceId).catch(() => {});
  } finally {
    state.reconnecting = false;
  }
});

// ── IMOU helpers ──────────────────────────────────────────────────────────────
async function unbindCurrent(deviceId) {
  try {
    const info = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const tok  = (info.streams || [])[0]?.liveToken;
    if (tok) { await request('unbindLive', { liveToken: tok }); return true; }
  } catch (_) {}
  return false;
}

async function fetchPlaylist(url) {
  try {
    const r    = await axios.get(url, { timeout: 6000 });
    const body = String(r.data || '');
    return { ok: body.includes('.ts') && !body.includes('errorcode'), body };
  } catch (e) { return { ok: false, body: e.message }; }
}

async function bindAndGetUrl(deviceId, streamId) {
  await request('bindDeviceLive', { deviceId, channelId: '0', streamId });
  await sleep(1000);
  const info    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
  const streams = info.streams || [];
  if (!streams.length) throw new Error('No streams from IMOU');
  return streams.find(s => s.hls?.startsWith('http:') && s.streamId === streamId)
      || streams.find(s => s.streamId === streamId)
      || streams[0];
}

// ── API: list cameras ─────────────────────────────────────────────────────────
app.get('/api/cameras', (req, res) => {
  res.json({ cameras: CAMERAS });
});

// ── API: start stream ─────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const streamId     = req.query.quality === 'SD' ? 1 : 0;

  if (!CAMERAS.find(c => c.id === deviceId))
    return res.status(403).json({ error: 'Unknown device' });

  const state = getState(deviceId);
  if (state.lock) return res.status(429).json({ error: 'Already connecting — please wait' });
  state.lock = true;

  try {
    mgr.stop(deviceId);
    const hadSession = await unbindCurrent(deviceId);
    if (hadSession) {
      console.log(`[STREAM:${deviceId}] Waiting 3s for session reset`);
      await sleep(3000);
    }

    const chosen = await bindAndGetUrl(deviceId, streamId);
    const { ok, body } = await fetchPlaylist(chosen.hls);
    console.log(`[STREAM:${deviceId}] Playlist:`, body.substring(0, 120).replace(/\n/g, ' | '));

    if (!ok) {
      await unbindCurrent(deviceId);
      return res.status(502).json({ error: 'Camera not ready — wait 15s and try again' });
    }

    state.quality = streamId;
    await mgr.start(deviceId, chosen.hls);

    await new Promise((resolve, reject) => {
      if (mgr.getInit(deviceId)) return resolve();
      const t     = setTimeout(() => reject(new Error('FFmpeg init timeout')), 20000);
      const onEnd = (id) => { if (id === deviceId) { clearTimeout(t); reject(new Error('FFmpeg exited before init')); } };
      mgr.once('init', (id) => { if (id === deviceId) { clearTimeout(t); mgr.removeListener('end', onEnd); resolve(); } });
      mgr.once('end', onEnd);
    });

    res.json({ success: true, wsUrl: `/stream?device=${deviceId}` });
  } catch (err) {
    console.error(`[STREAM ERROR:${deviceId}]:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    state.lock = false;
  }
});

// ── API: stop stream ──────────────────────────────────────────────────────────
app.post('/api/stream/:deviceId/stop', async (req, res) => {
  const { deviceId } = req.params;
  mgr.stop(deviceId);
  getState(deviceId).reconnecting = false;
  await unbindCurrent(deviceId);
  res.json({ success: true });
});

// ── API: flush stuck sessions ─────────────────────────────────────────────────
app.post('/api/stream/:deviceId/flush', async (req, res) => {
  const { deviceId } = req.params;
  mgr.stop(deviceId);
  getState(deviceId).reconnecting = false;
  let unbound = 0;
  for (let i = 0; i < 5; i++) {
    if (!await unbindCurrent(deviceId)) break;
    unbound++; await sleep(500);
  }
  res.json({ success: true, unbound, message: `Cleared ${unbound} session(s). Wait 15s before connecting.` });
});

// ── API: device online ────────────────────────────────────────────────────────
app.get('/api/device/:deviceId/online', async (req, res) => {
  try {
    const data = await request('deviceOnline', { deviceId: req.params.deviceId });
    res.json({ success: true, online: data.onLine === '1' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: health ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', cameras: CAMERAS.length, running: mgr.running(), time: new Date().toISOString() });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

process.on('SIGINT',  () => { mgr.stopAll(); process.exit(); });
process.on('SIGTERM', () => { mgr.stopAll(); process.exit(); });

server.listen(PORT, () => {
  console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
  console.log(`   Cameras: ${CAMERAS.length}\n`);
});