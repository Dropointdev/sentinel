require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const axios   = require('axios');
const { WebSocketServer } = require('ws');
const { request } = require('./imouclient');
const { startStream, stopStream, getInitSegment, isRunning, bus } = require('./ffmpegstreamer');

let _streamLock = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ── IMOU session helpers ──────────────────────────────────────────────────────

// Unbind the ONE active session IMOU tracks — getLiveStreamInfo returns it
async function unbindCurrent(deviceId) {
  try {
    const info = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const tok  = (info.streams || [])[0]?.liveToken;
    if (tok) {
      await request('unbindLive', { liveToken: tok });
      console.log('[IMOU] Unbound session:', tok.slice(0, 16) + '...');
      return true;
    }
  } catch (_) {}
  return false;
}

// Fetch playlist and return { ok, body }
async function fetchPlaylist(url) {
  try {
    const r    = await axios.get(url, { timeout: 6000 });
    const body = String(r.data || '');
    return { ok: body.includes('.ts') && !body.includes('errorcode'), body };
  } catch (e) {
    return { ok: false, body: e.message };
  }
}

// ── GET /api/stream/:deviceId ─────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const wantSD       = req.query.quality === 'SD';

  if (_streamLock) return res.status(429).json({ error: 'Already connecting — please wait' });
  _streamLock = true;

  try {
    // 1. Stop FFmpeg and unbind IMOU session
    stopStream();
    const hadSession = await unbindCurrent(deviceId);
    if (hadSession) {
      console.log('[STREAM] Waiting 4s for camera to release session...');
      await sleep(4000);
    }

    // 2. Bind and get stream URL — single attempt, no retry loop
    //    (retry loops were stacking sessions and causing error 110030)
    await request('bindDeviceLive', { deviceId, channelId: '0', streamId: wantSD ? 1 : 0 });
    await sleep(1000);

    const info    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const streams = info.streams || [];
    if (!streams.length) throw new Error('No streams from IMOU');

    const targetId = wantSD ? 1 : 0;
    const chosen   =
      streams.find(s => s.hls?.startsWith('http:') && s.streamId === targetId) ||
      streams.find(s => s.streamId === targetId) || streams[0];

    if (!chosen?.hls) throw new Error('No HLS URL');

    // 3. Check playlist — if error, don't retry (avoids session stacking)
    const { ok, body } = await fetchPlaylist(chosen.hls);
    console.log('[STREAM] Playlist:', body.substring(0, 200).replace(/\n/g, ' | '));
    if (!ok) {
      // Unbind so camera is left clean — user will retry manually
      await unbindCurrent(deviceId);
      return res.status(502).json({
        error: 'Camera session not ready — wait 15s and try again',
        hint: body.includes('110030') ? 'Error 110030: too many sessions. Wait 15s.' : 'Camera busy'
      });
    }

    // 4. Start FFmpeg
    console.log('[STREAM] Starting FFmpeg with:', chosen.hls.substring(0, 70));
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
    res.status(500).json({ error: err.message });
  } finally {
    _streamLock = false;
  }
});

// ── POST /api/stream/flush — emergency session reset ─────────────────────────
// Call this when camera is stuck in error 110030
app.post('/api/stream/flush', async (req, res) => {
  const deviceId = req.query.deviceId || process.env.IMOU_DEVICE_ID;
  console.log('[FLUSH] Force-clearing sessions for', deviceId);
  stopStream();
  let unbound = 0;
  // Try unbinding up to 5 times in case multiple sessions are queued
  for (let i = 0; i < 5; i++) {
    const ok = await unbindCurrent(deviceId);
    if (!ok) break;
    unbound++;
    await sleep(500);
  }
  console.log(`[FLUSH] Unbound ${unbound} session(s)`);
  res.json({ success: true, unbound, message: `Cleared ${unbound} session(s). Wait 15s before connecting.` });
});

// ── POST /api/stream/stop ─────────────────────────────────────────────────────
app.post('/api/stream/stop', async (req, res) => {
  stopStream();
  const deviceId = req.query.deviceId || process.env.IMOU_DEVICE_ID;
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

// ── Auto-recover when FFmpeg unexpectedly exits ───────────────────────────────
// This handles the case where FFmpeg exits mid-stream (code 0 = stream ended,
// code 1/255 = network error). We unbind the dead IMOU session immediately
// so it doesn't accumulate, then notify connected clients to reconnect.
bus.on('end', async () => {
  const deviceId = process.env.IMOU_DEVICE_ID;
  if (!deviceId) return;
  console.log('[RECOVER] FFmpeg ended — cleaning up IMOU session');
  await unbindCurrent(deviceId);
  // Tell all connected WS clients the stream died so the browser shows reconnect UI
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify({ type: 'stream_ended' })); } catch (_) {}
    }
  }
});