require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { request } = require('./imouclient');
const { startStream, stopStream, waitForPlaylist, OUTPUT_DIR } = require('./ffmpegstreamer');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve HLS segments — no caching
app.use('/streams', express.static(path.join(__dirname, '..', 'streams'), {
  maxAge: 0,
  setHeaders: res => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// ─── START STREAM ─────────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const wantSD       = req.query.quality === 'SD';
  const playlistPath = path.join(OUTPUT_DIR, deviceId, 'index.m3u8');

  try {
    // Unbind old IMOU session
    try {
      const info     = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
      const liveToken = (info.streams || [])[0]?.liveToken;
      if (liveToken) { await request('unbindLive', { liveToken }); console.log('[STREAM] Unbound old session'); }
    } catch (_) {}

    // Bind fresh session
    await request('bindDeviceLive', { deviceId, channelId: '0', streamId: wantSD ? 1 : 0 });

    // Get stream URLs
    const data    = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const streams = data.streams || [];
    if (!streams.length) return res.status(502).json({ error: 'No streams returned' });

    // Prefer HTTP stream (port 8888) — more reliable for FFmpeg than HTTPS 8890
    const targetId = wantSD ? 1 : 0;
    const chosen   =
      streams.find(s => s.hls?.startsWith('http:') && s.streamId === targetId) ||
      streams.find(s => s.streamId === targetId) ||
      streams[0];

    if (!chosen?.hls) return res.status(502).json({ error: 'No HLS URL in response' });

    console.log('[STREAM] Starting:', chosen.hls.substring(0, 80));

    // Start FFmpeg: HEVC → H.264 → HLS files on disk
    startStream(chosen.hls, deviceId);

    // Wait until FFmpeg has written real segments (up to 25s)
    await waitForPlaylist(playlistPath, 25000);
    console.log('[STREAM] Segments ready');

    res.json({ success: true, hlsUrl: `/streams/${deviceId}/index.m3u8` });

  } catch (err) {
    console.error('[STREAM ERROR]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── STOP STREAM ─────────────────────────────────────────────────────────────
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

app.listen(PORT, () => {
  console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
  console.log(`   Device : ${process.env.IMOU_DEVICE_ID}`);
  console.log(`   Mode   : HLS (H.264 via FFmpeg)\n`);
});