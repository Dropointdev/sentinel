const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

let ffmpegProcess = null;
const OUTPUT_DIR  = process.env.STREAMS_DIR || path.join(__dirname, '..', 'streams');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function clearDir(dir) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir).forEach(f => {
    if (f.endsWith('.ts') || f.endsWith('.m3u8') || f.endsWith('.tmp'))
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  });
}

function waitForPlaylist(playlistPath, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      try {
        if (fs.existsSync(playlistPath)) {
          const txt = fs.readFileSync(playlistPath, 'utf8');
          if (txt.includes('#EXTINF')) { clearInterval(check); return resolve(); }
        }
      } catch (_) {}
      if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error('Timed out waiting for video segments — FFmpeg may have failed'));
      }
    }, 400);
  });
}

function isRunning() { return ffmpegProcess !== null; }

function startStream(inputUrl, deviceId = 'cam') {
  // Kill any existing process
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
  }

  const outDir     = path.join(OUTPUT_DIR, deviceId);
  const outPlaylist = path.join(outDir, 'index.m3u8');

  ensureDir(outDir);
  clearDir(outDir);

  console.log('[FFMPEG] Starting transcode for:', deviceId);
  console.log('[FFMPEG] Input:', inputUrl);

  const args = [
    // Input
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags', 'nobuffer+discardcorrupt',
    '-flags', 'low_delay',
    '-probesize', '500000',
    '-analyzeduration', '500000',
    '-i', inputUrl,

    // HEVC → H.264 (camera outputs HEVC, browsers need H.264)
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '28',
    '-vf', 'scale=1280:-2',   // downscale from 2688 to 1280 wide
    '-an',                     // drop audio (IMOU audio causes issues)

    // Low-latency keyframes (1 per second at 20fps)
    '-g', '20',
    '-keyint_min', '20',
    '-sc_threshold', '0',

    // HLS output — 1s segments for low latency
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments+append_list+omit_endlist+split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, 'seg%d.ts'),
    outPlaylist,
  ];

  ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProcess.stdout.on('data', d => process.stdout.write('[FFMPEG] ' + d));
  ffmpegProcess.stderr.on('data', d => {
    const msg = d.toString();
    // Log useful lines, skip per-frame noise
    if (/Error|error|Opening.*writing|Input #|Stream #|hevc|h264/i.test(msg) && !/frame=/.test(msg)) {
      console.log('[FFMPEG]', msg.trim().split('\n')[0]);
    }
  });

  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] exited, code:', code);
    ffmpegProcess = null;
  });

  return outPlaylist;
}

function stopStream() {
  if (!ffmpegProcess) return;
  console.log('[FFMPEG] Stopping');
  ffmpegProcess.kill('SIGTERM');
  ffmpegProcess = null;
}

module.exports = { startStream, stopStream, waitForPlaylist, isRunning, OUTPUT_DIR };