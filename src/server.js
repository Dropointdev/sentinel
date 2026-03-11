require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const { WebSocketServer } = require('ws');
const { request } = require('./imouclient');
const { startStream, stopStream, getInitSegment, isRunning, bus } = require('./ffmpegstreamer');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/stream' });
const PORT   = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ─── WEBSOCKET — pipe fMP4 chunks to every connected client ──────────────────
wss.on('connection', ws => {
  console.log('[WS] Client connected, total:', wss.clients.size);

  // Send init segment immediately so client can set up MediaSource
  const init = getInitSegment();
  if (init) {
    ws.send(init, { binary: true });
    console.log('[WS] Sent cached init segment to new client');
  }

  ws.on('close', () => console.log('[WS] Client disconnected, total:', wss.clients.size));
  ws.on('error', err => console.error('[WS] Error:', err.message));
});

// Broadcast init segment to all clients when FFmpeg produces it
bus.on('init', chunk => {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  }
});

// Broadcast media chunks to all clients
bus.on('data', chunk => {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  }
});

// ─── START STREAM ─────────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const wantSD       = req.query.quality === 'SD';

  // If already running, clients just need to connect to WebSocket
  if (isRunning() && getInitSegment()) {
    console.log('[STREAM] Already running, returning WS URL');
    return res.json({ success: true, wsUrl: '/stream' });
  }

  try {
    // Unbind old IMOU session
    try {
      const info      = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
      const liveToken = (info.streams || [])[0]?.liveToken;
      if (liveToken) { await request('unbindLive', { liveToken }); console.log('[STREAM] Unbound old'); }
    } catch (_) {}

    // Bind fresh session
    await request('bindDeviceLive', { deviceId, channelId: '0', streamId: wantSD ? 1 : 0 });

    const data    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const streams = data.streams || [];
    if (!streams.length) return res.status(502).json({ error: 'No streams returned' });

    const targetId = wantSD ? 1 : 0;
    const chosen   =
      streams.find(s => s.hls?.startsWith('http:') && s.streamId === targetId) ||
      streams.find(s => s.streamId === targetId) ||
      streams[0];

    if (!chosen?.hls) return res.status(502).json({ error: 'No HLS URL in response' });

    // Start FFmpeg — it emits chunks via bus, no files written
    startStream(chosen.hls);

    // Wait up to 10s for init segment (ftyp+moov) to be ready
    await new Promise((resolve, reject) => {
      if (getInitSegment()) return resolve();
      const t = setTimeout(() => reject(new Error('FFmpeg init timed out')), 10000);
      bus.once('init', () => { clearTimeout(t); resolve(); });
    });

    res.json({ success: true, wsUrl: '/stream' });

  } catch (err) {
    console.error('[STREAM ERROR]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STOP ─────────────────────────────────────────────────────────────────────
app.post('/api/stream/stop', (req, res) => {
  stopStream();
  res.json({ success: true });
});

// ─── DEVICE STATUS ────────────────────────────────────────────────────────────
app.get('/api/device/:deviceId/online', async (req, res) => {
  try {
    const data = await request('deviceOnline', { deviceId: req.params.deviceId });
    res.json({ success: true, online: data.onLine === '1' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', deviceId: process.env.IMOU_DEVICE_ID, time: new Date().toISOString() });
});

// ─── FRONTEND ─────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

process.on('SIGINT',  () => { stopStream(); process.exit(); });
process.on('SIGTERM', () => { stopStream(); process.exit(); });

server.listen(PORT, () => {
  console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
  console.log(`   Device    : ${process.env.IMOU_DEVICE_ID}`);
  console.log(`   Transport : WebSocket + fMP4 (MSE)\n`);
});