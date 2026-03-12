const { spawn }        = require('child_process');
const { EventEmitter } = require('events');

class StreamBus extends EventEmitter {}
const bus = new StreamBus();
bus.setMaxListeners(100);

let ffmpegProcess = null;
let initSegment   = null;

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

function startStream(inputUrl) {
  if (ffmpegProcess) { ffmpegProcess.kill('SIGTERM'); ffmpegProcess = null; initSegment = null; }

  console.log('[FFMPEG] Starting — sub-1s latency mode');

  const args = [
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',

    // Disable HTTP keepalive — IMOU segment servers drop persistent connections
    '-headers',         'Connection: close\r\n',

    // Input buffering
    '-fflags',          'nobuffer+discardcorrupt',
    '-flags',           'low_delay',
    '-probesize',       '1000000',
    '-analyzeduration', '1000000',

    // Reconnect if a segment fetch fails (network hiccup)
    '-reconnect',          '1',
    '-reconnect_at_eof',   '1',
    '-reconnect_streamed',  '1',
    '-reconnect_delay_max', '2',

    '-i', inputUrl,

    // HEVC → H.264
    '-c:v',    'libx264',
    '-preset', 'ultrafast',
    '-tune',   'zerolatency',
    '-crf',    '28',
    '-vf',     'scale=1280:-2',
    '-an',

    // Keyframe every 5 frames at 20fps = 0.25s
    // Fragments split on keyframes — so fragment = 0.25s
    '-g',            '5',
    '-keyint_min',   '5',
    '-sc_threshold', '0',
    '-forced-idr',   '1',

    // No B-frames — they require future frames, adding latency
    '-bf',   '0',
    '-refs', '1',

    // fMP4 pipe — 250ms fragments
    '-f',             'mp4',
    '-movflags',      'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '250000',
    '-max_muxing_queue_size', '64',

    'pipe:1',
  ];

  ffmpegProcess = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let pending  = Buffer.alloc(0);
  let initDone = false;

  ffmpegProcess.stdout.on('data', chunk => {
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

  ffmpegProcess.stderr.on('data', d => {
    const msg = d.toString();
    if (/Error|error|Stream #|Input #/i.test(msg) && !/frame=/.test(msg))
      console.log('[FFMPEG]', msg.trim().split('\n')[0]);
  });

  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] exited, code:', code);
    ffmpegProcess = null; initSegment = null;
    bus.emit('end');
  });
}

function stopStream()     { if (ffmpegProcess) { ffmpegProcess.kill('SIGTERM'); ffmpegProcess = null; initSegment = null; } }
function getInitSegment() { return initSegment; }
function isRunning()      { return ffmpegProcess !== null; }

module.exports = { startStream, stopStream, getInitSegment, isRunning, bus };