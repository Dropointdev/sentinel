const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net  = require('net');

let mediamtxProcess = null;
let ffmpegProcess   = null;

// Replace the MEDIAMTX_PATH line with:
const MEDIAMTX_BIN  = process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx';
const MEDIAMTX_PATH = path.join(__dirname, '..', MEDIAMTX_BIN);
const MEDIAMTX_CONF = path.join(__dirname, '..', 'mediamtx.yml');
const WEBRTC_URL    = 'http://localhost:8889/cam/whep';

// ─── START MEDIAMTX ──────────────────────────────────────────────────────────
function startMediaMTX() {
  if (mediamtxProcess) return;
  console.log('[MEDIAMTX] Starting...');
  mediamtxProcess = spawn(MEDIAMTX_PATH, [MEDIAMTX_CONF], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mediamtxProcess.stdout.on('data', d => console.log('[MEDIAMTX]', d.toString().trim()));
  mediamtxProcess.stderr.on('data', d => console.log('[MEDIAMTX]', d.toString().trim()));
  mediamtxProcess.on('close', code => {
    console.log('[MEDIAMTX] exited with code', code);
    mediamtxProcess = null;
  });
}

// ─── WAIT FOR MEDIAMTX API PORT ──────────────────────────────────────────────
function waitForMediaMTX(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const client = new net.Socket();
      client.setTimeout(500);
      client.connect(9997, '127.0.0.1', () => { client.destroy(); resolve(); });
      client.on('error', () => {
        client.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('MediaMTX did not start in time'));
        setTimeout(check, 400);
      });
      client.on('timeout', () => {
        client.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('MediaMTX timeout'));
        setTimeout(check, 400);
      });
    };
    check();
  });
}

// ─── SET MEDIAMTX SOURCE DIRECTLY (no FFmpeg) ────────────────────────────────
// MediaMTX pulls RTSP from IMOU and serves as WebRTC — zero transcode latency
function setMediaMTXSource(rtspUrl) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      source: rtspUrl,
      sourceProtocol: 'tcp',
      sourceAnyPortEnable: true,
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 9997,
      path: '/v3/config/paths/patch/cam',
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[MEDIAMTX] Source set to RTSP — zero transcode path active');
          resolve();
        } else {
          reject(new Error(`MediaMTX API returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── FFMPEG FALLBACK (used only if no RTSP URL from IMOU) ────────────────────
// Stream copy only — no transcode, just remux HLS segments into RTSP
function startStreamFallback(inputUrl) {
  if (ffmpegProcess) {
    console.log('[FFMPEG] Already running');
    return;
  }

  console.log('[FFMPEG] Fallback remux HLS→RTSP (video copy, audio→opus):', inputUrl);

  const args = [
  '-allowed_extensions', 'ALL',
  '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
  '-probesize', '500000',
  '-analyzeduration', '500000',
  '-fflags', 'nobuffer+discardcorrupt+flush_packets',
  '-flags', 'low_delay',
  '-avoid_negative_ts', 'make_zero',
  '-use_wallclock_as_timestamps', '1',
  '-i', inputUrl,

  '-map', '0:v:0',
  '-map', '0:a:0',

  '-c:v', 'copy',
  '-c:a', 'libopus',
  '-b:a', '32k',
  '-ar', '16000',  // IMOU native rate — no resampling needed
  '-ac', '1',
  '-application', 'lowdelay',
  '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',

  '-f', 'rtsp',
  '-rtsp_transport', 'tcp',
  'rtsp://localhost:8554/cam'
];

  ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProcess.stdout.on('data', d => process.stdout.write('[FFMPEG] ' + d));
  ffmpegProcess.stderr.on('data', d => {
    const msg = d.toString();
    if (/error|Error|Stream #|Input #|Output #|Video:|Audio:|fps|speed/i.test(msg)) {
      console.log('[FFMPEG]', msg.trim());
    }
  });
  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] exited with code', code);
    ffmpegProcess = null;
  });
}

// ─── WAIT FOR VIDEO TRACK IN MEDIAMTX ────────────────────────────────────────
function waitForStream(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get('http://localhost:9997/v3/paths/list', res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const cam  = (json.items || []).find(p => p.name === 'cam');
            // H264, H265, HEVC — all supported by Chrome/Edge WebRTC
            if (cam && cam.tracks && cam.tracks.some(t => /H264|H265|HEVC/i.test(t))) {
              console.log('[STREAM] Tracks ready:', cam.tracks);
              return resolve();
            }
          } catch {}
          if (Date.now() - start > timeoutMs) return reject(new Error('Stream not ready in time'));
          setTimeout(check, 500);
        });
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('MediaMTX API not responding'));
        setTimeout(check, 500);
      });
    };
    check();
  });
}

// ─── STOP ────────────────────────────────────────────────────────────────────
function isRunning() { return ffmpegProcess !== null; }

function stopStream() {
  if (ffmpegProcess) {
    console.log('[FFMPEG] Stopping');
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }
  // Reset MediaMTX path back to passive publisher mode
  const body = JSON.stringify({ source: 'publisher' });
  const req = http.request({
    hostname: '127.0.0.1', port: 9997,
    path: '/v3/config/paths/patch/cam', method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

function stopAll() {
  stopStream();
  if (mediamtxProcess) {
    console.log('[MEDIAMTX] Stopping');
    mediamtxProcess.kill('SIGTERM');
    mediamtxProcess = null;
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────
module.exports = {
  startMediaMTX,
  waitForMediaMTX,
  setMediaMTXSource,
  startStreamFallback,
  waitForStream,
  stopStream,
  stopAll,
  isRunning,
  WEBRTC_URL
};