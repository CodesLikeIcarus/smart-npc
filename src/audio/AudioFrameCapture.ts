import type { ProximityAudioManager } from './ProximityAudioManager.js';
import { AudioFrameBuffer } from './AudioFrameBuffer.js';

/** Options for constructing an AudioFrameCapture instance. */
export interface AudioFrameCaptureOptions {
  /**
   * Ring buffer capacity in total samples (all channels combined).
   * Default: `sampleRate × channelCount × 4` (~4 seconds of stereo audio).
   */
  bufferCapacity?: number;

  /**
   * Expected sample rate of the MVRP audio stream in Hz.
   * Default: 48000.
   */
  sampleRate?: number;

  /**
   * Number of channels expected from MVRP.
   * Default: 2 (stereo).
   */
  channelCount?: number;
}

/** Default capture buffer duration in seconds. */
const DEFAULT_BUFFER_DURATION_SECONDS = 4;

/**
 * AudioFrameCapture – buffers decoded PCM samples in an {@link AudioFrameBuffer}
 * ring buffer for consumption by speech-to-text or other audio processing
 * pipelines.
 *
 * **Primary path – decode interception (preferred)**
 * {@link ProximityAudioManager.registerDecodeCapture} wires this instance into
 * MVRP's decode stage.  When a frame is decoded, the raw stereo PCM samples are
 * interleaved and written directly to {@link buffer} via
 * {@link AudioFrameBuffer.write}.  This path bypasses the Web Audio API graph
 * entirely, so it works even when MVRP routes audio through a native/WASM path
 * that would otherwise silence ScriptProcessorNode taps.
 *
 * **Legacy path – ScriptProcessorNode tap**
 * A {@link ScriptProcessorNode} is inserted into the audio processing pipeline
 * to intercept audio flowing to the speakers.  The node passes audio through
 * unmodified so playback is unaffected, and its `onaudioprocess` callback
 * interleaves the stereo channels and writes them to the ring buffer.
 * Enable this path by calling {@link enable} and then wiring the node in via
 * {@link ProximityAudioManager.connectAudioCapture}.
 *
 * Capture does **not** affect the existing MVRP → AudioContext.destination
 * playback chain.
 *
 * Lifecycle
 * ─────────
 *   const capture = new AudioFrameCapture(proximityAudioManager);
 *   capture.enable();                    // start collecting frames
 *   …
 *   const out = new Float32Array(1920);
 *   const n = capture.buffer.read(out);  // consume buffered PCM
 *   …
 *   capture.disable();                   // stop collecting (playback unaffected)
 *   capture.dispose();                   // release rAF loop
 */
export class AudioFrameCapture {
  private readonly audioManager: ProximityAudioManager;
  private readonly frameBuffer: AudioFrameBuffer;

  private _enabled: boolean = false;
  private pollHandle: ReturnType<typeof requestAnimationFrame> | null = null;

  /** ScriptProcessorNode used to intercept audio flowing to the speakers and write it to the frame buffer. */
  private scriptProcessorNode: ScriptProcessorNode | null = null;
  /** Pre-allocated interleaved scratch buffer sized to the ScriptProcessorNode's buffer size × channel count. */
  private interleavedBuffer: Float32Array | null = null;

  /**
   * @param audioManager  The active ProximityAudioManager whose
   *                      {@link AudioContext} destination will be tapped via a
   *                      ScriptProcessorNode for decoded audio frames.
   * @param options       Optional buffer / stream configuration.
   */
  constructor(audioManager: ProximityAudioManager, options?: AudioFrameCaptureOptions) {
    const sampleRate   = options?.sampleRate   ?? 48000;
    const channelCount = options?.channelCount ?? 2;
    const bufferCapacity = options?.bufferCapacity ?? (sampleRate * channelCount * DEFAULT_BUFFER_DURATION_SECONDS);

    this.audioManager = audioManager;
    this.frameBuffer  = new AudioFrameBuffer(bufferCapacity, sampleRate, channelCount);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start capturing decoded audio frames.
   * Idempotent: calling while already enabled has no effect.
   *
   * Creates a ScriptProcessorNode to intercept audio flowing to the speakers
   * and capture the actual spatial audio output from MVRP.  The node passes
   * audio through unmodified so playback is unaffected.
   */
  enable(): void {
    if (this._enabled) return;

    const ctx: AudioContext | null = this.audioManager.getAudioContext();

    if (ctx) {
      // Create ScriptProcessorNode to intercept audio flowing to speakers.
      // Use 4096 buffer size for reasonable balance between latency and processing.
      this.scriptProcessorNode = ctx.createScriptProcessor(4096, 2, 2);
      // Pre-allocate the interleaved scratch buffer to avoid per-callback allocations.
      this.interleavedBuffer = new Float32Array(4096 * 2);

      this.scriptProcessorNode.onaudioprocess = (event: AudioProcessingEvent) => {
        // Read the input buffer (audio received from connected source nodes)
        const inputData = event.inputBuffer;
        const channelCount = inputData.numberOfChannels;
        const sampleCount = inputData.length;

        // Interleave channels and write to frame buffer
        if (channelCount === 2 && this.interleavedBuffer) {
          const leftData = inputData.getChannelData(0);
          const rightData = inputData.getChannelData(1);

          for (let i = 0; i < sampleCount; i++) {
            this.interleavedBuffer[i * 2] = leftData[i];
            this.interleavedBuffer[i * 2 + 1] = rightData[i];
          }

          this.frameBuffer.write(this.interleavedBuffer, 0, sampleCount * 2);
        }

        // Pass through to destination (don't break playback)
        for (let ch = 0; ch < channelCount; ch++) {
          event.outputBuffer.getChannelData(ch).set(event.inputBuffer.getChannelData(ch));
        }
      };

      // Connect to destination so it processes audio flowing through
      this.scriptProcessorNode.connect(ctx.destination);
    }

    this._enabled = true;
    this.schedulePoll();
    console.log('[AudioFrameCapture] Capture enabled with ScriptProcessorNode');
  }

  /**
   * Stop capturing audio frames.  Any samples already in the ring buffer are
   * preserved and can still be read.  Playback is unaffected.
   * Idempotent: calling while already disabled has no effect.
   */
  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;

    if (this.pollHandle !== null) {
      cancelAnimationFrame(this.pollHandle);
      this.pollHandle = null;
    }

    if (this.scriptProcessorNode) {
      this.scriptProcessorNode.disconnect();
      this.scriptProcessorNode = null;
      this.interleavedBuffer = null;
    }

    console.log('[AudioFrameCapture] Capture disabled');
  }

  /**
   * Disable capture and release all resources.
   * The instance must not be used after calling `dispose()`.
   */
  dispose(): void {
    this.disable();
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /**
   * The underlying ring buffer.  Read from it to consume captured PCM samples.
   *
   * The buffer stores interleaved samples in the order they were decoded by
   * MVRP (typically L, R, L, R … for stereo streams).
   */
  get buffer(): AudioFrameBuffer {
    return this.frameBuffer;
  }

  /** Sample rate of the captured audio (Hz). */
  get sampleRate(): number {
    return this.frameBuffer.sampleRate;
  }

  /** Number of interleaved channels stored in the ring buffer. */
  get channelCount(): number {
    return this.frameBuffer.channelCount;
  }

  /** `true` while the capture loop is running. */
  get isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Returns an AudioNode suitable for connecting to a tap or analysis chain.
   * Used by ProximityAudioManager to wire the ScriptProcessorNode into the
   * audio graph via AVStreamAudioPlayer.connectTap().
   */
  get processorNode(): AudioNode | null {
    return this.scriptProcessorNode;
  }

  /**
   * Convenience helper: discard all samples currently in the ring buffer.
   * Useful before starting a new utterance for speech-to-text.
   */
  clearBuffer(): void {
    this.frameBuffer.clear();
  }

  // ─── Poll loop ────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    const poll = () => {
      if (!this._enabled) return;
      this.pollHandle = requestAnimationFrame(poll);
      this.captureFrame();
    };
    this.pollHandle = requestAnimationFrame(poll);
  }

  /**
   * No-op: the ScriptProcessorNode's `onaudioprocess` callback handles all
   * capturing directly in the audio processing pipeline.  This method exists
   * only to keep the poll loop intact for consistency.
   */
  private captureFrame(): void {
    // ScriptProcessorNode's onaudioprocess handles all the capturing now.
  }
}
