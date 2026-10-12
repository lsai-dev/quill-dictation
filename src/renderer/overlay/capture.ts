/**
 * Microphone capture at 16 kHz mono, done in an AudioWorklet so the main
 * thread (and the ribbon's animation) never stalls audio. Emits a level
 * reading every ~16 ms for the ribbon and accumulates PCM for transcription.
 */

const WORKLET = `
class QuillCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunk = new Float32Array(2048);
    this.n = 0;
    this.sum = 0;
    this.count = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.recording = true; this.n = 0; }
      else if (e.data === 'pause') { this.recording = false; this.n = 0; }
      else if (e.data === 'flush') {
        if (this.n > 0) this.port.postMessage({ type: 'pcm', data: this.chunk.slice(0, this.n) });
        this.n = 0;
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    const levelEvery = Math.round(sampleRate / 60);
    for (let i = 0; i < ch.length; i++) {
      let x = ch[i];
      if (input.length > 1) x = (x + input[1][i]) * 0.5;
      this.sum += x * x;
      if (++this.count >= levelEvery) {
        this.port.postMessage({ type: 'level', ms: this.sum / this.count });
        this.sum = 0; this.count = 0;
      }
      if (this.recording) {
        this.chunk[this.n++] = x;
        if (this.n === this.chunk.length) {
          this.port.postMessage({ type: 'pcm', data: this.chunk }, [this.chunk.buffer]);
          this.chunk = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('quill-capture', QuillCapture);
`;

const TARGET_RATE = 16000;
const KEEP_WARM_MS = 8000;

export class MicCapture {
  onLevel?: (db: number) => void;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private deviceId = '';
  private chunks: Float32Array[] = [];
  private flushed: (() => void) | null = null;
  private coolDown: number | null = null;
  private workletUrl: string | null = null;

  /** Open the microphone (or reuse a warm one) and begin recording. */
  async start(deviceId: string) {
    if (this.coolDown) clearTimeout(this.coolDown);
    this.coolDown = null;
    if (!this.ctx || !this.stream || this.deviceId !== deviceId || this.stream.getAudioTracks().every((t) => t.readyState === 'ended')) {
      await this.close();
      await this.open(deviceId);
    }
    this.chunks = [];
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    this.node!.port.postMessage('start');
  }

  private async open(deviceId: string) {
    this.deviceId = deviceId;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        channelCount: 1,
        // Whisper does better with the natural signal than with aggressive DSP.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    if (!this.workletUrl) this.workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(this.workletUrl);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'quill-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'level') this.onLevel?.(10 * Math.log10(m.ms + 1e-12));
      else if (m.type === 'pcm') this.chunks.push(m.data as Float32Array);
      else if (m.type === 'flushed') this.flushed?.();
    };
    src.connect(this.node);
  }

  /** Stop recording and return everything captured, resampled to 16 kHz. */
  async stop(): Promise<Float32Array> {
    if (!this.node || !this.ctx) return new Float32Array(0);
    await new Promise<void>((resolve) => {
      this.flushed = resolve;
      this.node!.port.postMessage('flush');
      setTimeout(resolve, 250);
    });
    this.flushed = null;
    this.node.port.postMessage('pause');
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    this.chunks = [];
    this.scheduleClose();
    return this.ctx.sampleRate === TARGET_RATE ? pcm : resample(pcm, this.ctx.sampleRate, TARGET_RATE);
  }

  /** Discard the recording. */
  abort() {
    this.node?.port.postMessage('pause');
    this.chunks = [];
    this.scheduleClose();
  }

  // Keep the device open briefly so a quick follow-up dictation starts instantly,
  // then release it so the system's microphone indicator turns off.
  private scheduleClose() {
    if (this.coolDown) clearTimeout(this.coolDown);
    this.coolDown = window.setTimeout(() => void this.close(), KEEP_WARM_MS);
  }

  async close() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.ctx) await this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}

/** Windowed-sinc resampler for the rare device that refuses a 16 kHz context. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  const cutoff = Math.min(1, to / from) * 0.95;
  const half = 16;
  for (let i = 0; i < out.length; i++) {
    const center = i * ratio;
    const start = Math.ceil(center - half);
    const end = Math.floor(center + half);
    let acc = 0;
    let norm = 0;
    for (let j = start; j <= end; j++) {
      if (j < 0 || j >= input.length) continue;
      const x = j - center;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (half + 1));
      const k = sinc * w;
      acc += input[j] * k;
      norm += k;
    }
    out[i] = norm ? acc / norm : 0;
  }
  return out;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is turned off in Windows privacy settings';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found';
  if (name === 'NotReadableError') return 'The microphone is in use by another app';
  return 'Couldn’t start the microphone';
}
