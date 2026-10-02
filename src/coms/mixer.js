import { performance } from 'node:perf_hooks';

/**
 * Audio plumbing for the coms bridge. Everything is 48 kHz, 16-bit,
 * interleaved stereo — what Discord's Opus decoder gives and what the
 * LiveKit side is asked for — so nothing needs resampling.
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE / 1000) * FRAME_MS; // per channel
export const FRAME_VALUES = FRAME_SAMPLES * CHANNELS; // interleaved Int16 values per frame

// A source waits until it has this much buffered before it's mixed in (and
// again after running dry), smoothing out network jitter.
const PRIME_VALUES = FRAME_VALUES * 2; // 40 ms
// Beyond this a source is falling behind — drop its oldest audio rather than let latency grow.
const MAX_BUFFERED_VALUES = FRAME_VALUES * 15; // 300 ms

/** Copies to an aligned Int16Array when needed (a Buffer can sit at an odd offset in a shared pool). */
export function toInt16(buf) {
  if (buf instanceof Int16Array) return buf;
  if (buf.byteOffset % 2 === 0) return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const copy = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < copy.length; i++) copy[i] = buf.readInt16LE(i * 2);
  return copy;
}

/**
 * Mixes any number of live PCM sources (one per speaker) into frames. Each
 * source is a queue of sample chunks; every `readFrame()` takes one frame's
 * worth from each primed source and sums them, clipping to 16 bits.
 */
export class PcmMixer {
  constructor() {
    this.sources = new Map(); // key -> { chunks: Int16Array[], offset, buffered, primed }
  }

  push(key, samples) {
    const data = toInt16(samples);
    if (data.length === 0) return;
    let src = this.sources.get(key);
    if (!src) {
      src = { chunks: [], offset: 0, buffered: 0, primed: false };
      this.sources.set(key, src);
    }
    src.chunks.push(data);
    src.buffered += data.length;
    while (src.buffered - src.offset > MAX_BUFFERED_VALUES && src.chunks.length > 1) {
      const dropped = src.chunks.shift();
      src.buffered -= dropped.length;
      src.offset = Math.max(0, src.offset - dropped.length);
    }
    if (src.buffered - src.offset >= PRIME_VALUES) src.primed = true;
  }

  remove(key) {
    this.sources.delete(key);
  }

  clear() {
    this.sources.clear();
  }

  /** One frame of mixed audio, or null when nobody is audible (so callers can skip or send silence). */
  readFrame() {
    let acc = null;
    for (const src of this.sources.values()) {
      if (!src.primed) continue;
      acc ??= new Int32Array(FRAME_VALUES);
      let written = 0;
      while (written < FRAME_VALUES && src.chunks.length) {
        const chunk = src.chunks[0];
        const n = Math.min(FRAME_VALUES - written, chunk.length - src.offset);
        for (let i = 0; i < n; i++) acc[written + i] += chunk[src.offset + i];
        written += n;
        src.offset += n;
        if (src.offset >= chunk.length) {
          src.chunks.shift();
          src.buffered -= chunk.length;
          src.offset = 0;
        }
      }
      if (src.buffered - src.offset <= 0) src.primed = false; // ran dry: re-prime before mixing again
    }
    if (!acc) return null;
    const out = new Int16Array(FRAME_VALUES);
    for (let i = 0; i < FRAME_VALUES; i++) out[i] = acc[i] > 32767 ? 32767 : acc[i] < -32768 ? -32768 : acc[i];
    return out;
  }
}

/**
 * Calls `onFrame` every FRAME_MS on a drift-corrected schedule (setInterval
 * drifts; audio can't). After a stall it catches up a few frames, then
 * skips ahead rather than bursting.
 */
export class FrameClock {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    let next = performance.now();
    const tick = () => {
      const now = performance.now();
      if (now - next > FRAME_MS * 5) next = now - FRAME_MS * 5;
      while (next <= now) {
        try {
          this.onFrame();
        } catch (err) {
          console.error('[coms] audio frame error:', err);
        }
        next += FRAME_MS;
      }
      this.timer = setTimeout(tick, Math.max(1, next - performance.now()));
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}
