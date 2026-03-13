require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const axios      = require('axios');
const { spawn }  = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { request } = require('./imouclient');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;
const G2R    = 'http://127.0.0.1:1984';

app.use(cors());
app.use(express.json());

// ── Camera config ─────────────────────────────────────────────────────────────
function parseCameras() {
  if (process.env.CAMERAS) {
    return process.env.CAMERAS.split(',').map(entry => {
      const [id, ...rest] = entry.trim().split(':');
      return { id: id.trim(), label: rest.join(':').trim() || id.trim() };
    });
  }
  if (process.env.IMOU_DEVICE_ID) return [{ id: process.env.IMOU_DEVICE_ID, label: 'CAM-01' }];
  return [];
}
const CAMERAS = parseCameras();
console.log('[CONFIG] Cameras:', CAMERAS.map(c => `${c.id}(${c.label})`).join(', '));

// ── go2rtc process ────────────────────────────────────────────────────────────
// go2rtc only serves MSE — it reads from our FFmpeg via RTSP
// We run FFmpeg ourselves so we control codec/transcode args
let g2rProc = null;

function writeGo2rtcConfig(cameraIds) {
  const fs = require('fs');
  let streamLines = '';
  for (const id of cameraIds) {
    // go2rtc reads from our FFmpeg output via RTSP
    streamLines += `  ${id}:\n    - rtsp://127.0.0.1:8554/${id}\n`;
  }
  const cfg = `api:
  listen: "127.0.0.1:1984"
  origin: "*"
rtsp:
  listen: "127.0.0.1:8554"
webrtc:
  listen: ""
log:
  level: warn
streams:
${streamLines || '  {}\n'}`;
  fs.writeFileSync('/tmp/go2rtc.yaml', cfg);
  console.log('[GO2RTC] Config written for:', cameraIds.join(', ') || 'none');
}

function killGo2rtc() {
  return new Promise(resolve => {
    if (!g2rProc) return resolve();
    const p = g2rProc; g2rProc = null;
    p.once('close', () => setTimeout(resolve, 200));
    p.kill('SIGTERM');
    setTimeout(() => { try { p.kill('SIGKILL'); } catch(_){} }, 2000);
  });
}

function startGo2rtc(cameraIds) {
  return new Promise(async (resolve, reject) => {
    await killGo2rtc();
    writeGo2rtcConfig(cameraIds);
    console.log('[GO2RTC] Starting...');

    g2rProc = spawn('go2rtc', ['-config', '/tmp/go2rtc.yaml'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    g2rProc.stdout.on('data', d => process.stdout.write('[GO2RTC] ' + d));
    g2rProc.stderr.on('data', d => process.stderr.write('[GO2RTC] ' + d));
    g2rProc.on('close', code => { console.log('[GO2RTC] Exited', code); g2rProc = null; });

    let attempts = 0;
    const check = setInterval(async () => {
      try {
        await axios.get(`${G2R}/api/streams`, { timeout: 500 });
        clearInterval(check);
        console.log('[GO2RTC] Ready');
        resolve();
      } catch (_) {
        if (++attempts > 20) { clearInterval(check); reject(new Error('go2rtc failed to start')); }
      }
    }, 500);
  });
}

// ── FFmpeg processes (one per camera) ─────────────────────────────────────────
// Pipeline: IMOU HLS → FFmpeg (HEVC→H264 transcode) → RTSP → go2rtc → MSE
const ffmpegProcs = {}; // { deviceId: ChildProcess }

function startFFmpeg(deviceId, hlsUrl) {
  stopFFmpeg(deviceId);

  const rtspOut = `rtsp://127.0.0.1:8554/${deviceId}`;
  console.log(`[FFMPEG:${deviceId}] Starting: ${hlsUrl.substring(0, 60)}...`);
  console.log(`[FFMPEG:${deviceId}] Output:   ${rtspOut}`);

  const args = [
    '-hide_banner', '-v', 'warning',
    // Input options — low latency HLS reading
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-probesize', '500000',
    '-analyzeduration', '500000',
    '-i', hlsUrl,
    // Video: transcode HEVC→H264 (required for MSE browser compatibility)
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'baseline',
    '-level', '3.1',
    '-b:v', '1000k',
    '-maxrate', '1200k',
    '-bufsize', '500k',
    '-g', '30',           // keyframe every 30 frames
    '-sc_threshold', '0',
    // Audio: AAC passthrough (MSE supports AAC natively)
    '-c:a', 'aac',
    '-b:a', '64k',
    '-ar', '44100',
    '-ac', '1',
    // Output: RTSP to go2rtc
    '-f', 'rtsp',
    '-rtsp_transport', 'tcp',
    rtspOut
  ];

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegProcs[deviceId] = proc;

  proc.stdout.on('data', d => process.stdout.write(`[FFMPEG:${deviceId}] ` + d));
  proc.stderr.on('data', d => process.stderr.write(`[FFMPEG:${deviceId}] ` + d));
  proc.on('close', (code, sig) => {
    console.log(`[FFMPEG:${deviceId}] Exited code=${code} signal=${sig}`);
    if (ffmpegProcs[deviceId] === proc) delete ffmpegProcs[deviceId];
  });

  return proc;
}

function stopFFmpeg(deviceId) {
  const proc = ffmpegProcs[deviceId];
  if (!proc) return;
  delete ffmpegProcs[deviceId];
  proc.kill('SIGTERM');
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_){} }, 3000);
  console.log(`[FFMPEG:${deviceId}] Stopped`);
}

function stopAllFFmpeg() {
  Object.keys(ffmpegProcs).forEach(stopFFmpeg);
}

// ── Wait for FFmpeg RTSP to be accepted by go2rtc ─────────────────────────────
async function waitForStream(deviceId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await axios.get(`${G2R}/api/streams`, { timeout: 2000 });
      const s = r.data?.[deviceId];
      // go2rtc shows tracks once it has received data from FFmpeg via RTSP
      if (s?.tracks?.length > 0) {
        console.log(`[GO2RTC] Stream ${deviceId} tracks ready:`, s.tracks.map(t => t.codec).join(', '));
        return true;
      }
    } catch (_) {}
    await sleep(500);
  }
  console.warn(`[GO2RTC] Stream ${deviceId} tracks not confirmed after ${timeoutMs}ms`);
  return false;
}

// ── Proxy go2rtc HTTP + WebSocket ─────────────────────────────────────────────
const g2rProxy = createProxyMiddleware({
  target: G2R,
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/go2rtc': '' },
  on: {
    error: (err, req, res) => {
      console.error('[PROXY] go2rtc error:', err.message);
      if (res?.writeHead) try { res.status(502).json({ error: 'go2rtc unavailable' }); } catch(_) {}
    }
  }
});
app.use('/go2rtc', g2rProxy);

// ── IMOU helpers ──────────────────────────────────────────────────────────────
async function unbindCurrent(deviceId) {
  try {
    const info = await request('getLiveStreamInfo', { deviceId, channelId: '0' });
    const tok  = (info.streams || [])[0]?.liveToken;
    if (tok) { await request('unbindLive', { liveToken: tok }); return true; }
  } catch (_) {}
  return false;
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

async function fetchPlaylist(url) {
  try {
    const r    = await axios.get(url, { timeout: 6000 });
    const body = String(r.data || '');
    return { ok: body.includes('.ts') && !body.includes('errorcode'), body };
  } catch (e) { return { ok: false, body: e.message }; }
}

// ── Per-device lock ───────────────────────────────────────────────────────────
const locks = {};
function getLock(id) { return locks[id] || (locks[id] = { connecting: false }); }

// ── API: cameras ──────────────────────────────────────────────────────────────
app.get('/api/cameras', (req, res) => res.json({ cameras: CAMERAS }));

// ── API: start stream ─────────────────────────────────────────────────────────
app.get('/api/stream/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  const streamId     = req.query.quality === 'SD' ? 1 : 0;

  if (!CAMERAS.find(c => c.id === deviceId))
    return res.status(403).json({ error: 'Unknown device' });

  const lock = getLock(deviceId);
  if (lock.connecting) return res.status(429).json({ error: 'Already connecting' });
  lock.connecting = true;

  try {
    // Stop any existing FFmpeg for this device
    stopFFmpeg(deviceId);

    // Unbind stale IMOU session
    const hadSession = await unbindCurrent(deviceId);
    if (hadSession) { await sleep(3000); }

    // Get fresh HLS URL
    const chosen = await bindAndGetUrl(deviceId, streamId);
    const { ok, body } = await fetchPlaylist(chosen.hls);
    console.log(`[STREAM:${deviceId}] Playlist:`, body.substring(0, 120).replace(/\n/g, ' | '));

    if (!ok) {
      await unbindCurrent(deviceId);
      return res.status(502).json({ error: 'Camera not ready — wait 15s and try again' });
    }

    // Start our FFmpeg → RTSP → go2rtc pipeline
    startFFmpeg(deviceId, chosen.hls);

    // Give FFmpeg 3s to connect to go2rtc before waiting for tracks
    await sleep(3000);

    // Wait up to 12s for go2rtc to receive tracks from FFmpeg
    const ready = await waitForStream(deviceId, 12000);
    if (!ready) {
      console.warn(`[STREAM:${deviceId}] Tracks not confirmed — browser will connect anyway`);
    }

    res.json({
      success: true,
      wsUrl:  `/go2rtc/api/ws?src=${deviceId}`,
      mseUrl: `/go2rtc/api/stream.mp4?src=${deviceId}`,
    });
  } catch (err) {
    console.error(`[STREAM ERROR:${deviceId}]:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    lock.connecting = false;
  }
});

// ── API: stop stream ──────────────────────────────────────────────────────────
app.post('/api/stream/:deviceId/stop', async (req, res) => {
  const { deviceId } = req.params;
  stopFFmpeg(deviceId);
  await unbindCurrent(deviceId);
  res.json({ success: true });
});

// ── API: flush sessions ───────────────────────────────────────────────────────
app.post('/api/stream/:deviceId/flush', async (req, res) => {
  const { deviceId } = req.params;
  stopFFmpeg(deviceId);
  let unbound = 0;
  for (let i = 0; i < 5; i++) {
    if (!await unbindCurrent(deviceId)) break;
    unbound++; await sleep(500);
  }
  res.json({ success: true, unbound, message: `Cleared ${unbound} session(s). Wait 15s.` });
});

// ── API: device online ────────────────────────────────────────────────────────
app.get('/api/device/:deviceId/online', async (req, res) => {
  try {
    const data = await request('deviceOnline', { deviceId: req.params.deviceId });
    res.json({ success: true, online: data.onLine === '1' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── API: health ───────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let g2rStreams = {};
  try { g2rStreams = (await axios.get(`${G2R}/api/streams`, { timeout: 1000 })).data; } catch (_) {}
  res.json({
    status: 'ok',
    cameras: CAMERAS.length,
    go2rtc: !!g2rProc,
    ffmpeg: Object.keys(ffmpegProcs),
    streams: Object.keys(g2rStreams),
    time: new Date().toISOString()
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

process.on('SIGINT',  () => { stopAllFFmpeg(); if (g2rProc) g2rProc.kill(); process.exit(); });
process.on('SIGTERM', () => { stopAllFFmpeg(); if (g2rProc) g2rProc.kill(); process.exit(); });

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    // Start go2rtc with all cameras pre-configured (RTSP sources from our FFmpeg)
    await startGo2rtc(CAMERAS.map(c => c.id));
  } catch (e) {
    console.error('[FATAL] go2rtc failed to start:', e.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
    console.log(`   Cameras : ${CAMERAS.length}`);
    console.log(`   go2rtc  : ${G2R} (MSE via RTSP from our FFmpeg)\n`);
  });

  // Forward WebSocket upgrades to go2rtc
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/go2rtc')) {
      req.url = req.url.replace(/^\/go2rtc/, '');
      g2rProxy.upgrade(req, socket, head);
    }
  });
})();