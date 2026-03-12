require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { WebSocketServer } = require('ws');
const { request } = require('./imouclient');
const { startStream, stopStream, getInitSegment, isRunning, bus } = require('./ffmpegstreamer');

let _streamLock = false;  // prevent concurrent /api/stream calls

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/stream' });

// Max chunks queued per client before we drop old ones — prevents latency buildup
const MAX_QUEUE = 3;

wss.on('connection', ws => {
  console.log('[WS] Client connected, total:', wss.clients.size);
  ws._queue    = [];
  ws._draining = false;

  // Send init segment so MSE can set up codec immediately
  const init = getInitSegment();
  if (init) ws.send(init, { binary: true });

  ws.on('close', () => console.log('[WS] Client disconnected, total:', wss.clients.size));
  ws.on('error', err => console.error('[WS] Error:', err.message));
});

function sendToClient(ws, chunk) {
  if (ws.readyState !== ws.OPEN) return;

  ws._queue.push(chunk);

  // Drop oldest chunks if queue grows — keeps us at live edge
  while (ws._queue.length > MAX_QUEUE) {
    ws._queue.shift();
  }

  if (!ws._draining) drain(ws);
}

function drain(ws) {
  if (ws._queue.length === 0) { ws._draining = false; return; }
  ws._draining = true;
  const chunk  = ws._queue.shift();
  try {
    ws.send(chunk, { binary: true }, () => drain(ws));
  } catch (_) { ws._draining = false; }
}

bus.on('init', chunk => {
  for (const ws of wss.clients) sendToClient(ws, chunk);
});

bus.on('data', chunk => {
  for (const ws of wss.clients) sendToClient(ws, chunk);
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const wantSD       = req.query.quality === 'SD';

  if (_streamLock) {
    console.log('[STREAM] Locked — concurrent request rejected');
    return res.status(429).json({ error: 'Stream start in progress, try again' });
  }
  _streamLock = true;

  try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    const axios = require('axios');

    // Helper: fully unbind any live session for this device
    async function unbindAll() {
      try {
        const info = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
        for (const s of (info.streams || [])) {
          if (s.liveToken) {
            try { await request('unbindLive', { liveToken: s.liveToken }); } catch (_) {}
          }
        }
      } catch (_) {}
    }

    // Helper: fetch playlist and check it has real segments
    async function checkPlaylist(url) {
      try {
        const r    = await axios.get(url, { timeout: 6000 });
        const body = String(r.data || '');
        // Log first 300 chars so we can see what IMOU is actually returning
        console.log('[STREAM] Playlist preview:', body.substring(0, 300).replace(/\n/g, ' | '));
        return body.includes('.ts') && !body.includes('errorcode');
      } catch (e) {
        console.log('[STREAM] Playlist fetch error:', e.message);
        return false;
      }
    }

    // Unbind everything first, then wait for camera to fully reset
    await unbindAll();
    console.log('[STREAM] Waiting 5s for camera session to fully reset...');
    await sleep(5000);

    // Single bind → check → if bad, full unbind+wait cycle (max 3 rounds)
    let chosen = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[STREAM] Bind attempt ${attempt}/3`);
      await request('bindDeviceLive', { deviceId, channelId: '0', streamId: wantSD ? 1 : 0 });
      await sleep(1500);  // brief pause for camera to prepare playlist after bind

      const data    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
      const streams = data.streams || [];
      if (!streams.length) throw new Error('No streams returned');

      const targetId = wantSD ? 1 : 0;
      const candidate =
        streams.find(s => s.hls?.startsWith('http:') && s.streamId === targetId) ||
        streams.find(s => s.streamId === targetId) || streams[0];

      if (!candidate?.hls) throw new Error('No HLS URL in response');

      const ok = await checkPlaylist(candidate.hls);
      console.log(`[STREAM] Playlist check (attempt ${attempt}/3): ${ok ? 'OK' : 'ERROR segments'}`);

      if (ok) { chosen = candidate; break; }

      // Not ready — full unbind and longer wait before next attempt
      await unbindAll();
      if (attempt < 3) {
        console.log('[STREAM] Waiting 5s before retry...');
        await sleep(5000);
      }
    }

    if (!chosen) return res.status(502).json({ error: 'Camera not ready after 3 attempts — wait 10s and try again' });

    console.log('[STREAM] Starting with fresh URL:', chosen.hls.substring(0, 70));
    await startStream(chosen.hls);

    await new Promise((resolve, reject) => {
      if (getInitSegment()) return resolve();
      const t = setTimeout(() => reject(new Error('FFmpeg init timeout')), 20000);
      bus.once('init', () => { clearTimeout(t); bus.removeListener('end', onEnd); resolve(); });
      const onEnd = () => { clearTimeout(t); reject(new Error('FFmpeg exited before producing stream')); };
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

app.post('/api/stream/stop', (req, res) => { stopStream(); res.json({ success: true }); });

app.get('/api/device/:deviceId/online', async (req, res) => {
  try {
    const data = await request('deviceOnline', { deviceId: req.params.deviceId });
    res.json({ success: true, online: data.onLine === '1' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', deviceId: process.env.IMOU_DEVICE_ID, time: new Date().toISOString() });
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