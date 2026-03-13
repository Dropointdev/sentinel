/**
 * StreamManager — one FFmpeg process per camera, independent lifecycle.
 *
 * Events emitted:
 *   'init'  (deviceId, buffer)  — ftyp+moov ready for new clients
 *   'data'  (deviceId, buffer)  — media fragment
 *   'end'   (deviceId)          — FFmpeg exited
 */
const { spawn }        = require('child_process');
const { EventEmitter } = require('events');

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

class StreamManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    // Map<deviceId, { proc, initSegment, pending, initDone, starting }>
    this._streams = new Map();
  }

  // Kill existing process for device and wait for it to fully exit
  _kill(deviceId) {
    return new Promise(resolve => {
      const state = this._streams.get(deviceId);
      if (!state) return resolve();
      this._streams.delete(deviceId);
      const proc = state.proc;
      if (!proc || proc.exitCode !== null) return resolve();
      proc.once('close', resolve);
      proc.kill('SIGTERM');
      const force = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 3000);
      proc.once('close', () => clearTimeout(force));
    });
  }

  async start(deviceId, inputUrl) {
    const existing = this._streams.get(deviceId);
    if (existing?._starting) {
      console.log(`[STREAM:${deviceId}] Already starting — skipping`);
      return;
    }

    await this._kill(deviceId);

    console.log(`[STREAM:${deviceId}] Starting FFmpeg`);

    const args = [
      '-allowed_extensions', 'ALL',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
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
      '-g',            '10',
      '-keyint_min',   '10',
      '-sc_threshold', '0',

      '-f',             'mp4',
      '-movflags',      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '500000',
      '-max_muxing_queue_size', '128',
      'pipe:1',
    ];

    const proc  = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { proc, initSegment: null, pending: Buffer.alloc(0), initDone: false };
    this._streams.set(deviceId, state);

    proc.stdout.on('data', chunk => {
      if (!state.initDone) {
        state.pending    = Buffer.concat([state.pending, chunk]);
        const moofAt     = findMoofOffset(state.pending);
        if (moofAt === -1) return;
        state.initSegment = state.pending.slice(0, moofAt);
        const rest        = state.pending.slice(moofAt);
        state.initDone    = true;
        state.pending     = Buffer.alloc(0);
        console.log(`[STREAM:${deviceId}] Init segment ready: ${state.initSegment.length}b`);
        this.emit('init', deviceId, state.initSegment);
        if (rest.length > 0) this.emit('data', deviceId, rest);
      } else {
        this.emit('data', deviceId, chunk);
      }
    });

    proc.stderr.on('data', d => {
      const msg = d.toString();
      if (/Error|error|Stream #0:|Input #0,/i.test(msg) && !/frame=|Skip|EXTM3U|reconnect|keepalive/i.test(msg))
        console.log(`[STREAM:${deviceId}]`, msg.trim().split('\n')[0]);
    });

    proc.on('close', code => {
      if (this._streams.get(deviceId)?.proc === proc) this._streams.delete(deviceId);
      console.log(`[STREAM:${deviceId}] FFmpeg exited, code: ${code}`);
      this.emit('end', deviceId);
    });
  }

  stop(deviceId) {
    console.log(`[STREAM:${deviceId}] Stop requested`);
    this._kill(deviceId);
  }

  stopAll() {
    for (const id of [...this._streams.keys()]) this.stop(id);
  }

  getInit(deviceId)  { return this._streams.get(deviceId)?.initSegment || null; }
  isRunning(deviceId){ return this._streams.has(deviceId); }
  running()          { return [...this._streams.keys()]; }
}

module.exports = StreamManager;