require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { request } = require('./imouclient');
const {
  startMediaMTX, waitForMediaMTX,
  setMediaMTXSource, startStreamFallback,
  waitForStream, stopStream, stopAll,
  isRunning, WEBRTC_URL
} = require('./ffmpegstreamer');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Start MediaMTX immediately on boot
startMediaMTX();

// ─── WHEP PROXY ───────────────────────────────────────────────────────────────
// Browser can't reach localhost:8889 on Render — proxy through Express instead
app.post('/whep', (req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const options = {
      hostname: '127.0.0.1',
      port: 8889,
      path: '/cam/whep',
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const proxy = http.request(options, proxyRes => {
      res.status(proxyRes.statusCode);
      Object.entries(proxyRes.headers).forEach(([k, v]) => res.setHeader(k, v));
      proxyRes.pipe(res);
    });

    proxy.on('error', err => {
      console.error('[WHEP PROXY] Error:', err.message);
      res.status(502).json({ error: 'MediaMTX not reachable' });
    });

    proxy.write(body);
    proxy.end();
  });
});

// ─── GET STREAM ───────────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const wantSD   = req.query.quality === 'SD';
  const streamId = wantSD ? 1 : 0;

  try {
    await waitForMediaMTX();

    // Unbind any existing session
    try {
      const liveInfo = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
      const liveToken = (liveInfo.streams || [])[0]?.liveToken;
      if (liveToken) {
        await request('unbindLive', { liveToken });
        console.log('[STREAM] Unbound old session');
      }
    } catch (e) { console.log('[STREAM] Unbind skipped:', e.message); }

    // Bind fresh session
    const bindData = await request('bindDeviceLive', { deviceId, channelId: '0', streamId });
    const streams  = bindData.streams || [];
    if (!streams.length) return res.status(502).json({ error: 'No streams in bind response', raw: bindData });

    const chosen = streams.find(s => s.hls || s.rtsp) || streams[0];
    console.log('[STREAM] Available URLs:', JSON.stringify({
      rtsp: chosen.rtsp ? chosen.rtsp.substring(0, 60) + '...' : 'none',
      hls:  chosen.hls  ? chosen.hls.substring(0, 60)  + '...' : 'none',
    }));

    // ── PATH 1: RTSP direct → MediaMTX (zero transcode, ~100-200ms latency) ──
    if (chosen.rtsp) {
      console.log('[STREAM] Using RTSP direct path — no FFmpeg, no transcode');
      await setMediaMTXSource(chosen.rtsp);
      await waitForStream(15000);
      return res.json({ success: true, webrtcUrl: '/whep' });
    }

    // ── PATH 2: HLS → FFmpeg remux (video copy, audio→opus) → MediaMTX ──────
    if (chosen.hls) {
      console.log('[STREAM] RTSP not available, falling back to HLS copy remux');
      startStreamFallback(chosen.hls);
      await waitForStream(15000);
      return res.json({ success: true, webrtcUrl: '/whep' });
    }

    return res.status(502).json({ error: 'No usable stream URL', streams });

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

// ─── FRONTEND ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Cleanup on exit
process.on('SIGINT',  () => { stopAll(); process.exit(); });
process.on('SIGTERM', () => { stopAll(); process.exit(); });

app.listen(PORT, () => {
  console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
  console.log(`   Device : ${process.env.IMOU_DEVICE_ID}`);
  console.log(`   WebRTC : proxied via /whep\n`);
});