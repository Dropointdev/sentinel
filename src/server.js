require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');
const https      = require('https');
const axios      = require('axios');
const { spawn }  = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { request } = require('./imouclient');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;
const G2R    = 'http://127.0.0.1:1984'; // go2rtc internal address

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
let g2rProc = null;
const activeStreams = {}; // { deviceId: hlsUrl }

function writeConfig() {
  const fs = require('fs');
  let streamLines = '';
  for (const [name, hlsUrl] of Object.entries(activeStreams)) {
    streamLines += `  ${name}:\n    - ffmpeg:${hlsUrl}#video=h264\n`;
  }
  const cfg = `api:
  listen: "127.0.0.1:1984"
  origin: "*"
rtsp:
  listen: ""
webrtc:
  listen: ""
log:
  level: warn
ffmpeg:
  bin: ffmpeg
streams:
${streamLines || '  {}\n'}`;
  fs.writeFileSync('/tmp/go2rtc.yaml', cfg);
  console.log('[GO2RTC] Config written with streams:', Object.keys(activeStreams).join(', ') || 'none');
}

function killGo2rtc() {
  return new Promise(resolve => {
    if (!g2rProc) return resolve();
    const p = g2rProc;
    g2rProc = null;
    p.once('close', () => { setTimeout(resolve, 300); }); // 300ms after exit for port release
    p.kill('SIGTERM');
    setTimeout(() => { try { p.kill('SIGKILL'); } catch(_){} }, 2000);
  });
}

function startGo2rtc() {
  return new Promise(async (resolve, reject) => {
    await killGo2rtc();  // Wait for old process to fully exit + ports to release

    writeConfig();
    console.log('[GO2RTC] Starting...');

    g2rProc = spawn('go2rtc', ['-config', '/tmp/go2rtc.yaml'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    g2rProc.stdout.on('data', d => process.stdout.write('[GO2RTC] ' + d));
    g2rProc.stderr.on('data', d => process.stderr.write('[GO2RTC] ' + d));
    g2rProc.on('close', code => {
      console.log('[GO2RTC] Exited with code', code);
      g2rProc = null;
    });

    // Wait for go2rtc API to be ready
    let attempts = 0;
    const check = setInterval(async () => {
      attempts++;
      try {
        await axios.get(`${G2R}/api/streams`, { timeout: 500 });
        clearInterval(check);
        console.log('[GO2RTC] Ready');
        resolve();
      } catch (_) {
        if (attempts > 20) { clearInterval(check); reject(new Error('go2rtc failed to start')); }
      }
    }, 500);
  });
}

// ── go2rtc stream management ──────────────────────────────────────────────────
async function g2rAddStream(name, hlsUrl) {
  activeStreams[name] = hlsUrl;
  await startGo2rtc();
  console.log(`[GO2RTC] Stream added: ${name}`);
}

async function g2rDeleteStream(name) {
  delete activeStreams[name];
  console.log(`[GO2RTC] Stream removed: ${name}`);
  // Restart go2rtc without this stream if others still active
  if (Object.keys(activeStreams).length > 0) await startGo2rtc();
  else if (g2rProc) { g2rProc.kill(); g2rProc = null; }
}

async function g2rStreamReady(name, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await axios.get(`${G2R}/api/streams`, { timeout: 3000 });
      const s = r.data?.[name];
      if (i === 0) console.log(`[GO2RTC] Streams:`, JSON.stringify(r.data).substring(0, 300));
      if (s?.producers?.length > 0 || s?.tracks?.length > 0) return true;
    } catch (_) {}
    await sleep(1000);
  }
  return false;
}

// ── Proxy go2rtc HTTP endpoints ───────────────────────────────────────────────
const g2rProxy = createProxyMiddleware({
  target: G2R,
  changeOrigin: true,
  pathRewrite: { '^/go2rtc': '' },
  on: {
    error: (err, req, res) => {
      console.error('[PROXY] go2rtc proxy error:', err.message);
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
    // Remove any existing go2rtc stream for this device
    await g2rDeleteStream(deviceId);

    // Unbind stale IMOU session
    const hadSession = await unbindCurrent(deviceId);
    if (hadSession) { await sleep(3000); }

    // Get fresh HLS URL from IMOU
    const chosen = await bindAndGetUrl(deviceId, streamId);
    const { ok, body } = await fetchPlaylist(chosen.hls);
    console.log(`[STREAM:${deviceId}] Playlist:`, body.substring(0, 120).replace(/\n/g, ' | '));

    if (!ok) {
      await unbindCurrent(deviceId);
      return res.status(502).json({ error: 'Camera not ready — wait 15s and try again' });
    }

    // Register stream in go2rtc — it will spawn FFmpeg internally
    await g2rAddStream(deviceId, chosen.hls);

    // Wait for go2rtc to connect to source — but don't block the response
    // go2rtc buffers clients until FFmpeg is ready, so we can return the URL immediately
    g2rStreamReady(deviceId).then(ready => {
      if (!ready) console.log(`[GO2RTC] Warning: stream ${deviceId} never showed producers`);
    });

    // Return the WebSocket URL straight away — go2rtc handles the wait internally
    res.json({
      success: true,
      wsUrl:   `/go2rtc/api/ws?src=${deviceId}`,
      mseUrl:  `/go2rtc/api/stream.mp4?src=${deviceId}`,
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
  await g2rDeleteStream(deviceId);
  await unbindCurrent(deviceId);
  res.json({ success: true });
});

// ── API: flush sessions ───────────────────────────────────────────────────────
app.post('/api/stream/:deviceId/flush', async (req, res) => {
  const { deviceId } = req.params;
  await g2rDeleteStream(deviceId);
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
  res.json({ status: 'ok', cameras: CAMERAS.length, go2rtc: !!g2rProc, streams: Object.keys(g2rStreams), time: new Date().toISOString() });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

process.on('SIGINT',  () => { if (g2rProc) g2rProc.kill(); process.exit(); });
process.on('SIGTERM', () => { if (g2rProc) g2rProc.kill(); process.exit(); });

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await startGo2rtc();
  } catch (e) {
    console.error('[FATAL] go2rtc failed to start:', e.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`\n🟢 SENTINEL running at http://localhost:${PORT}`);
    console.log(`   Cameras : ${CAMERAS.length}`);
    console.log(`   go2rtc  : ${G2R}\n`);
  });

  // Forward WebSocket upgrades for /go2rtc/* to go2rtc
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.startsWith('/go2rtc')) {
      // Rewrite path: /go2rtc/api/ws?src=X  →  /api/ws?src=X
      req.url = req.url.replace(/^\/go2rtc/, '');
      g2rProxy.upgrade(req, socket, head);
    }
  });
})();