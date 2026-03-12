const { spawn }        = require('child_process');
const { EventEmitter } = require('events');

class StreamBus extends EventEmitter {}
const bus = new StreamBus();
bus.setMaxListeners(100);

let ffmpegProcess = null;
let initSegment   = null;
let _starting     = false;

function findMoofOffset(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (type === 'moof') return offset;
    if (size < 8) break;
    offset += size;
  }
  return -1;
}

function killExisting() {
  return new Promise(resolve => {
    if (!ffmpegProcess) return resolve();
    const proc = ffmpegProcess;
    ffmpegProcess = null;
    initSegment   = null;
    if (proc.exitCode !== null) return resolve();
    proc.once('close', () => resolve());
    proc.kill('SIGTERM');
    const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
    proc.once('close', () => clearTimeout(force));
  });
}

async function startStream(inputUrl) {
  if (_starting) { console.log('[FFMPEG] Already starting — skipping'); return; }
  _starting = true;
  try {
    await killExisting();
    console.log('[FFMPEG] Starting');

    const args = [
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',

      // NOTE: no -http_persistent 0 — that flag breaks HLS manifest refresh,
      // causing FFmpeg to exit cleanly after the first set of segments.
      // The EOF/reconnect log spam is harmless; FFmpeg handles it internally.

      '-fflags',          'nobuffer+discardcorrupt',
      '-flags',           'low_delay',
      '-probesize',       '1000000',
      '-analyzeduration', '1000000',

      '-i', inputUrl,

      // Auto-detect codec — copy H.264 streams directly, transcode HEVC to H.264
      // The HD stream is HEVC; the SD stream comes as H.264 already
      '-c:v',    'libx264',   // always re-encode so output is always browser-compatible H.264
      '-preset', 'ultrafast',
      '-tune',   'zerolatency',
      '-crf',    '28',
      '-vf',     'scale=1280:-2',
      '-an',
      '-bf',     '0',
      '-refs',   '1',
      '-g',            '10',   // keyframe every 10 frames (~0.5s at 20fps)
      '-keyint_min',   '10',
      '-sc_threshold', '0',

      '-f',             'mp4',
      '-movflags',      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '500000',   // 500ms fragments — more stable than 250ms
      '-max_muxing_queue_size', '128',
      'pipe:1',
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpegProcess = proc;

    let pending  = Buffer.alloc(0);
    let initDone = false;

    proc.stdout.on('data', chunk => {
      if (!initDone) {
        pending      = Buffer.concat([pending, chunk]);
        const moofAt = findMoofOffset(pending);
        if (moofAt === -1) return;
        initSegment  = pending.slice(0, moofAt);
        const rest   = pending.slice(moofAt);
        initDone     = true;
        pending      = Buffer.alloc(0);
        console.log('[FFMPEG] Init segment ready:', initSegment.length, 'bytes');
        bus.emit('init', initSegment);
        if (rest.length > 0) bus.emit('data', rest);
      } else {
        bus.emit('data', chunk);
      }
    });

    proc.stderr.on('data', d => {
      const msg = d.toString();
      if (/Error|error|Stream #0:|Input #0,/i.test(msg) && !/frame=|Skip|EXTM3U|reconnect|keepalive/i.test(msg))
        console.log('[FFMPEG]', msg.trim().split('\n')[0]);
    });

    proc.on('close', code => {
      if (ffmpegProcess === proc) { ffmpegProcess = null; initSegment = null; }
      console.log('[FFMPEG] exited, code:', code);
      bus.emit('end');
    });

  } finally {
    _starting = false;
  }
}

function stopStream()     { console.log('[FFMPEG] Stop requested'); killExisting(); }
function getInitSegment() { return initSegment; }
function isRunning()      { return ffmpegProcess !== null; }

module.exports = { startStream, stopStream, getInitSegment, isRunning, bus };