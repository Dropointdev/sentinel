require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const axios   = require('axios');
const { WebSocketServer } = require('ws');
const { request } = require('./imouclient');
const { startStream, stopStream, getInitSegment, isRunning, bus } = require('./ffmpegstreamer');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let _streamLock    = false;
let _activeDevice  = null;   // currently streaming device
let _activeQuality = 0;      // 0=HD 1=SD
let _reconnecting  = false;

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' });
const MAX_QUEUE = 3;

wss.on('connection', ws => {
  console.log('[WS] Client connected, total:', wss.clients.size);
  ws._queue = []; ws._draining = false;
  const init = getInitSegment();
  if (init) ws.send(init, { binary: true });
  ws.on('close', () => console.log('[WS] Client disconnected, total:', wss.clients.size));
  ws.on('error', err => console.error('[WS] Error:', err.message));
});

function sendToClient(ws, chunk) {
  if (ws.readyState !== ws.OPEN) return;
  ws._queue.push(chunk);
  while (ws._queue.length > MAX_QUEUE) ws._queue.shift();
  if (!ws._draining) drain(ws);
}
function drain(ws) {
  if (ws._queue.length === 0) { ws._draining = false; return; }
  ws._draining = true;
  try { ws.send(ws._queue.shift(), { binary: true }, () => drain(ws)); }
  catch (_) { ws._draining = false; }
}
bus.on('init', chunk => { for (const ws of wss.clients) sendToClient(ws, chunk); });
bus.on('data', chunk => { for (const ws of wss.clients) sendToClient(ws, chunk); });

// ── IMOU helpers ──────────────────────────────────────────────────────────────
async function unbindCurrent(deviceId) {
  try {
    const info = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const tok  = (info.streams || [])[0]?.liveToken;
    if (tok) {
      await request('unbindLive', { liveToken: tok });
      console.log('[IMOU] Unbound session');
      return true;
    }
  } catch (_) {}
  return false;
}

async function fetchPlaylist(url) {
  try {
    const r    = await axios.get(url, { timeout: 6000 });
    const body = String(r.data || '');
    return { ok: body.includes('.ts') && !body.includes('errorcode'), body };
  } catch (e) {
    return { ok: false, body: e.message };
  }
}

// Bind IMOU session and return the HLS URL
async function bindAndGetUrl(deviceId, streamId) {
  await request('bindDeviceLive', { deviceId, channelId: '0', streamId });
  await sleep(1000);
  const info    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
  const streams = info.streams || [];
  if (!streams.length) throw new Error('No streams from IMOU');
  const chosen =
    streams.find(s => s.hls?.startsWith('http:') && s.streamId === streamId) ||
    streams.find(s => s.streamId === streamId) || streams[0];
  if (!chosen?.hls) throw new Error('No HLS URL');
  return chosen;
}

// ── Auto-restart when FFmpeg dies ─────────────────────────────────────────────
bus.on('end', async () => {
  if (!_activeDevice || _reconnecting || wss.clients.size === 0) {
    // No active device, already reconnecting, or no viewers — just clean up
    if (_activeDevice) await unbindCurrent(_activeDevice).catch(() => {});
    return;
  }

  _reconnecting = true;
  console.log('[RECOVER] FFmpeg ended — auto-restarting in 2s');

  // Notify clients stream is briefly interrupted (they keep WS open)
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN)
      try { ws.send(JSON.stringify({ type: 'reconnecting' })); } catch (_) {}
  }

  await sleep(2000);

  try {
    await unbindCurrent(_activeDevice);
    await sleep(2000);

    const chosen = await bindAndGetUrl(_activeDevice, _activeQuality);
    const { ok, body } = await fetchPlaylist(chosen.hls);
    if (!ok) throw new Error('Playlist not ready: ' + body.substring(0, 100));

    console.log('[RECOVER] Got fresh URL, restarting FFmpeg');
    await startStream(chosen.hls);

    // Wait for new init segment and send to all connected clients
    await new Promise((resolve, reject) => {
      if (getInitSegment()) return resolve();
      const t     = setTimeout(() => reject(new Error('init timeout')), 20000);
      const onEnd = () => { clearTimeout(t); reject(new Error('FFmpeg exited again')); };
      bus.once('init', () => { clearTimeout(t); bus.removeListener('end', onEnd); resolve(); });
      bus.once('end', onEnd);
    });

    // Send fresh init segment to all connected clients so MSE resets codec
    const init = getInitSegment();
    if (init) {
      for (const ws of wss.clients) {
        if (ws.readyState === ws.OPEN)
          try { ws.send(init, { binary: true }); } catch (_) {}
      }
    }

    // Notify clients stream is back
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN)
        try { ws.send(JSON.stringify({ type: 'reconnected' })); } catch (_) {}
    }

    console.log('[RECOVER] Stream restored');
  } catch (err) {
    console.error('[RECOVER] Failed:', err.message);
    await unbindCurrent(_activeDevice).catch(() => {});
    // Tell clients to reload
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN)
        try { ws.send(JSON.stringify({ type: 'stream_ended' })); } catch (_) {}
    }
  } finally {
    _reconnecting = false;
  }
});

// ── GET /api/stream/:deviceId ─────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const streamId     = req.query.quality === 'SD' ? 1 : 0;

  if (_streamLock) return res.status(429).json({ error: 'Already connecting — please wait' });
  _streamLock = true;

  try {
    stopStream();
    const hadSession = await unbindCurrent(deviceId);
    if (hadSession) {
      console.log('[STREAM] Waiting 3s for camera to release session...');
      await sleep(3000);
    }

    const chosen = await bindAndGetUrl(deviceId, streamId);
    const { ok, body } = await fetchPlaylist(chosen.hls);
    console.log('[STREAM] Playlist:', body.substring(0, 150).replace(/\n/g, ' | '));

    if (!ok) {
      await unbindCurrent(deviceId);
      return res.status(502).json({ error: 'Camera not ready — wait 15s and try again' });
    }

    console.log('[STREAM] Starting FFmpeg');
    _activeDevice  = deviceId;
    _activeQuality = streamId;
    await startStream(chosen.hls);

    await new Promise((resolve, reject) => {
      if (getInitSegment()) return resolve();
      const t     = setTimeout(() => reject(new Error('FFmpeg init timeout')), 20000);
      const onEnd = () => { clearTimeout(t); reject(new Error('FFmpeg exited before init')); };
      bus.once('init', () => { clearTimeout(t); bus.removeListener('end', onEnd); resolve(); });
      bus.once('end', onEnd);
    });

    res.json({ success: true, wsUrl: '/stream' });
  } catch (err) {
    console.error('[STREAM ERROR]:', err.message);
    _activeDevice = null;
    res.status(500).json({ error: err.message });
  } finally {
    _streamLock = false;
  }
});

// ── POST /api/stream/flush ────────────────────────────────────────────────────
app.post('/api/stream/flush', async (req, res) => {
  const deviceId = req.query.deviceId || process.env.IMOU_DEVICE_ID;
  console.log('[FLUSH] Clearing sessions for', deviceId);
  stopStream(); _activeDevice = null;
  let unbound = 0;
  for (let i = 0; i < 5; i++) {
    const ok = await unbindCurrent(deviceId);
    if (!ok) break;
    unbound++; await sleep(500);
  }
  res.json({ success: true, unbound, message: `Cleared ${unbound} session(s). Wait 15s before connecting.` });
});

// ── POST /api/stream/stop ─────────────────────────────────────────────────────
app.post('/api/stream/stop', async (req, res) => {
  const deviceId = _activeDevice || req.query.deviceId || process.env.IMOU_DEVICE_ID;
  stopStream(); _activeDevice = null; _reconnecting = false;
  if (deviceId) await unbindCurrent(deviceId);
  res.json({ success: true });
});

app.get('/api/device/:deviceId/online', async (req, res) => {
  try {
    const data = await request('deviceOnline', { deviceId: req.params.deviceId });
    res.json({ success: true, online: data.onLine === '1' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', deviceId: process.env.IMOU_DEVICE_ID, streaming: isRunning(), time: new Date().toISOString() });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

process.on('SIGINT',  () => { stopStream(); process.exit(); });
process.on('SIGTERM', () => { stopStream(); process.exit(); });

server.listen(PORT, () => {
  console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
  console.log(`   Device : ${process.env.IMOU_DEVICE_ID}\n`);
});