/** Capture lifecycle: selected devices, display audio, cancellation and track cleanup. */
import { checker, load } from '../tools/load.mjs';

const { AudioEngine } = await load('app/audio');
const { check, done } = checker();

class Track extends EventTarget {
  constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; }
  stop() { this.readyState = 'ended'; }
  end() { this.stop(); this.dispatchEvent(new Event('ended')); }
}
class Stream {
  constructor(tracks = [new Track('audio')]) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
class Node {
  gain = { value: 0 };
  disconnected = false;
  connect() { return this; }
  disconnect() { this.disconnected = true; }
}
class Context {
  state = 'running';
  destination = new Node();
  sampleRate = 48000;
  sources = [];
  createGain() { return new Node(); }
  createScriptProcessor() { return new Node(); }
  createMediaStreamSource(stream) { const node = new Node(); node.stream = stream; this.sources.push(node); return node; }
  async resume() { this.state = 'running'; }
}
globalThis.AudioContext = Context;
globalThis.MediaStream = Stream;
let nextStream;
let constraints;
let captureMethod;
const media = {
  async getUserMedia(options) { captureMethod = 'microphone'; constraints = options; return nextStream; },
  async getDisplayMedia(options) { captureMethod = 'loopback'; constraints = options; return nextStream; },
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: media } });
let ended = 0;
const engine = new AudioEngine(() => {}, () => ended++);
const stopped = (stream) => stream.getTracks().every((t) => t.readyState === 'ended');

nextStream = new Stream();
check('default input starts', await engine.startInput({ kind: 'microphone' }), null);
check('capture active', engine.inputOn, true);
check('no forced default device', constraints.audio.deviceId, undefined);
check('tone processing disabled', constraints.audio, { echoCancellation: false, noiseSuppression: false, autoGainControl: false });
engine.stopInput();
check('stop releases device', stopped(nextStream), true);
check('stop disconnects graph', engine.ctx.sources.at(-1).disconnected, true);
check('capture inactive', engine.inputOn, false);

nextStream = new Stream();
await engine.startInput({ kind: 'microphone', deviceId: 'usb-radio' });
check('selected input is exact', constraints.audio.deviceId, { exact: 'usb-radio' });
nextStream.getAudioTracks()[0].end();
check('unplug stops capture', engine.inputOn, false);
check('unplug notifies UI', ended, 1);

nextStream = new Stream([new Track('video'), new Track('audio')]);
const pending = engine.startInput({ kind: 'loopback' });
check('display picker called before first await', captureMethod, 'loopback');
check('display requests required video', constraints.video, true);
check('system audio requested', constraints.systemAudio, 'include');
check('loopback starts', await pending, null);
check('graph receives audio only', engine.ctx.sources.at(-1).stream.getTracks().map((t) => t.kind), ['audio']);
nextStream.getTracks()[0].end();
check('Stop sharing resets state', engine.inputOn, false);
check('Stop sharing releases all tracks', stopped(nextStream), true);
check('Stop sharing notifies UI once', ended, 2);

nextStream = new Stream([new Track('video')]);
check('video without audio is rejected', await engine.startInput({ kind: 'loopback' }), 'no-audio');
check('video-only capture released', stopped(nextStream), true);

const getUserMedia = media.getUserMedia;
for (const [name, expected] of [['NotAllowedError', 'denied'], ['NotFoundError', 'missing'], ['OverconstrainedError', 'missing'], ['NotReadableError', 'failed']]) {
  media.getUserMedia = async () => { throw new DOMException('test', name); };
  check(name, await engine.startInput({ kind: 'microphone' }), expected);
  check(`${name} stays off`, engine.inputOn, false);
}
media.getUserMedia = getUserMedia;
const getDisplayMedia = media.getDisplayMedia;
delete media.getDisplayMedia;
check('unsupported display capture', await engine.startInput({ kind: 'loopback' }), 'unsupported');
media.getDisplayMedia = getDisplayMedia;

let resolve;
engine.ctx.state = 'suspended';
media.getUserMedia = () => new Promise((r) => { resolve = r; });
const cancelled = engine.startInput({ kind: 'microphone' });
check('audio context resumes before permission resolves', engine.ctx.state, 'running');
engine.stopInput();
const lateStream = new Stream();
resolve(lateStream);
check('cancelled pending request finishes quietly', await cancelled, null);
check('late permission grant released', stopped(lateStream), true);
check('late permission grant stays off', engine.inputOn, false);

const oldRequest = engine.startInput({ kind: 'microphone' });
const resolveOld = resolve;
media.getUserMedia = getUserMedia;
nextStream = new Stream();
await engine.startInput({ kind: 'microphone', deviceId: 'other' });
const oldStream = new Stream();
resolveOld(oldStream);
await oldRequest;
check('superseded request released', stopped(oldStream), true);
check('new request remains active', engine.inputOn && !stopped(nextStream), true);
engine.stopInput();

nextStream = new Stream([new Track('audio'), new Track('video')]);
engine.ctx.state = 'suspended';
engine.ctx.resume = async () => { throw new Error('resume failed'); };
check('resume failure reported', await engine.startInput({ kind: 'loopback' }), 'failed');
check('resume failure releases all tracks', stopped(nextStream), true);
check('resume failure disconnects graph', engine.ctx.sources.at(-1).disconnected, true);
check('resume failure stays off', engine.inputOn, false);

done('audio');
