const { spawn }        = require('child_process');
const { EventEmitter } = require('events');

class StreamBus extends EventEmitter {}
const bus = new StreamBus();
bus.setMaxListeners(100);

let ffmpegProcess = null;
let initSegment   = null;
let _starting     = false;   // lock — prevents concurrent spawns

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

// Kill existing process and WAIT for it to fully exit
function killExisting() {
  return new Promise(resolve => {
    if (!ffmpegProcess) return resolve();
    const proc = ffmpegProcess;
    ffmpegProcess = null;
    initSegment   = null;

    if (proc.exitCode !== null) return resolve();  // already dead

    proc.once('close', () => resolve());
    proc.kill('SIGTERM');

    // Force kill after 3s if SIGTERM doesn't work
    const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
    proc.once('close', () => clearTimeout(force));
  });
}

async function startStream(inputUrl) {
  if (_starting) {
    console.log('[FFMPEG] Already starting — ignoring duplicate call');
    return;
  }
  _starting = true;

  try {
    await killExisting();   // fully wait for old process to die

    console.log('[FFMPEG] Starting');

    const args = [
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',

      // Disable persistent HTTP connections for HLS segments
      // IMOU segment servers drop keepalive connections causing EOF errors
      '-http_persistent',  '0',

      '-fflags',          'nobuffer+discardcorrupt',
      '-flags',           'low_delay',
      '-probesize',       '1000000',
      '-analyzeduration', '1000000',

      '-i', inputUrl,

      '-c:v',    'libx264',
      '-preset', 'ultrafast',
      '-tune',   'zerolatency',
      '-crf',    '28',
      '-vf',     'scale=1280:-2',
      '-an',
      '-bf',     '0',
      '-refs',   '1',
      '-g',            '5',
      '-keyint_min',   '5',
      '-sc_threshold', '0',

      '-f',             'mp4',
      '-movflags',      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '250000',
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
      // Suppress noisy Skip/#EXTM3U/reconnect lines — only log real errors
      if (/Error|error|Stream #0|Input #0/i.test(msg) && !/frame=|Skip|EXTM3U|reconnect/i.test(msg))
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

function stopStream() {
  console.log('[FFMPEG] Stop requested');
  killExisting();
}

function getInitSegment() { return initSegment; }
function isRunning()      { return ffmpegProcess !== null; }

module.exports = { startStream, stopStream, getInitSegment, isRunning, bus };