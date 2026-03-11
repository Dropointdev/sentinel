const { spawn }       = require('child_process');
const { EventEmitter } = require('events');

class StreamBus extends EventEmitter {}
const bus = new StreamBus();
bus.setMaxListeners(100);

let ffmpegProcess = null;
let initSegment   = null;   // fMP4 init (ftyp+moov) — sent to every new client

// ─── MP4 box parser — find where moov ends so we can split init vs media ─────
function findInitEnd(buf) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const type = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (type === 'moof') return offset;   // first moof = end of init segment
    if (size < 8) break;
    offset += size;
  }
  return -1;
}

function startStream(inputUrl) {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
    initSegment   = null;
  }

  console.log('[FFMPEG] Starting low-latency fMP4 pipe stream');
  console.log('[FFMPEG] Input:', inputUrl);

  const args = [
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-fflags',             'nobuffer+discardcorrupt',
    '-flags',              'low_delay',
    '-probesize',          '500000',
    '-analyzeduration',    '500000',
    '-i',                  inputUrl,

    // HEVC → H.264 (browsers need H.264)
    '-c:v',       'libx264',
    '-preset',    'ultrafast',
    '-tune',      'zerolatency',
    '-crf',       '28',
    '-vf',        'scale=1280:-2',
    '-an',                            // no audio

    // Keyframe every 15 frames (~0.75s at 20fps) for fast seeking/join
    '-g',             '15',
    '-keyint_min',    '15',
    '-sc_threshold',  '0',

    // fragmented MP4 to stdout — 500ms fragments
    '-f',         'mp4',
    '-movflags',  'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',   // 500 000 µs = 0.5 s
    'pipe:1',
  ];

  ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let pending = Buffer.alloc(0);
  let initDone = false;

  ffmpegProcess.stdout.on('data', chunk => {
    if (!initDone) {
      // Accumulate until we find the first moof box
      pending = Buffer.concat([pending, chunk]);
      const moofAt = findInitEnd(pending);
      if (moofAt === -1) return;   // init segment not complete yet

      initSegment = pending.slice(0, moofAt);
      const rest  = pending.slice(moofAt);
      initDone    = true;
      pending     = Buffer.alloc(0);

      console.log('[FFMPEG] Init segment ready:', initSegment.length, 'bytes');
      bus.emit('init', initSegment);
      if (rest.length > 0) bus.emit('data', rest);
    } else {
      bus.emit('data', chunk);
    }
  });

  ffmpegProcess.stderr.on('data', d => {
    const msg = d.toString();
    if (/Error|error|Stream #|Input #|hevc|h264/i.test(msg) && !/frame=/.test(msg)) {
      console.log('[FFMPEG]', msg.trim().split('\n')[0]);
    }
  });

  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] exited, code:', code);
    ffmpegProcess = null;
    initSegment   = null;
    bus.emit('end');
  });
}

function stopStream() {
  if (!ffmpegProcess) return;
  console.log('[FFMPEG] Stopping');
  ffmpegProcess.kill('SIGTERM');
  ffmpegProcess = null;
  initSegment   = null;
}

function getInitSegment()  { return initSegment; }
function isRunning()       { return ffmpegProcess !== null; }

module.exports = { startStream, stopStream, getInitSegment, isRunning, bus };