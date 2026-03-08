// MV is a global namespace populated by side-effect imports in LnG.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const MV: any;

import { AVStreamAudioPlayer } from './AVStreamAudioPlayer.js';
import type { AudioFrameCapture } from './AudioFrameCapture.js';

/**
 * ProximityAudioManager – owns the MV.MVRP.Proximity instance and wires it to
 * the Web Audio API for local speaker playback.
 *
 * Lifecycle
 * ─────────
 *   const mgr = new ProximityAudioManager(pLnG);
 *   mgr.start();          // creates Proximity + AudioContext; call once in-world
 *   …avatar is active…
 *   mgr.stop();           // tears down Proximity + AudioContext on exit
 *
 * Audio pipeline
 * ──────────────
 *   Server → MV.MVRP.Proximity.onRecv_Request()
 *          → MV.MVRP.Audio.Output()           [decode codec 0 / codec 1]
 *          → AudioContext.destination          [basic speaker playback]
 *
 *   Additionally, an AVStreamAudioPlayer is created over the same AudioContext,
 *   providing a GainNode → PannerNode → destination chain for spatial audio.
 *   Callers that need per-source volume or 3-D positioning can obtain the player
 *   via getAudioPlayer() and route decoded buffers through it.
 *
 * Decode interception
 * ───────────────────
 *   MVRP routes decoded audio directly to the native/WASM speaker path,
 *   bypassing Web Audio API graph nodes.  To capture the raw PCM samples,
 *   setupDecodeInterception() wraps mvAudio.Decode[0] and mvAudio.Decode[1]
 *   so that whenever a frame is decoded the channelData is forwarded to a
 *   registered AudioFrameCapture instance.  Playback is unaffected.
 *
 *   registerDecodeCapture(capture)  – wire an AudioFrameCapture into the path
 *   unregisterDecodeCapture()       – remove the current capture
 *
 * PCM buffer access
 * ─────────────────
 *   getAudioBuffer()   – returns the live MVRP `m_Buffer` for direct PCM access
 *   getAudioMetadata() – returns sampleRate, samplesPerSlice, bytesPerSample
 *   These are available for advanced callers that need direct access to the
 *   MVRP internal buffer.
 *
 * Mute / deaf controls
 * ─────────────────────
 *   muteLocalMic(true)  – suppress microphone transmission to server
 *   deafOutput(true)    – suppress speaker output locally
 */
export class ProximityAudioManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pLnG: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private proximity: any = null;
  private audioPlayer: AVStreamAudioPlayer | null = null;
  private audioContext: AudioContext | null = null;
  private _started: boolean = false;
  private decodeFrameCapture: AudioFrameCapture | null = null;

  /**
   * Whether MVRP decoded audio is mono (one sample per frame) rather than
   * interleaved stereo (L,R pairs).  Detected automatically on the first
   * decode call by comparing channelData.length to wSamples.
   *
   * `null` = not yet detected, `true` = mono, `false` = stereo interleaved.
   */
  private _decodedIsMono: boolean | null = null;

  /**
   * @param pLnG  The active pLnG service client from the MSF fabric
   *              (i.e. `getPFabric().pLnG`).  Its `.pClient` property is the
   *              underlying MVIO service connection that the Proximity instance
   *              registers with to receive audio packets from the server.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(pLnG: any) {
    this.pLnG = pLnG;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Initialise the proximity listener and start the audio engine.
   *
   * Idempotent: calling start() more than once has no effect.
   *
   * The MV.MVRP.Proximity instance registers itself with the service connection
   * to receive proximity packets (avatar positions and audio streams).  Audio
   * playback begins automatically when the server sends encoded audio frames;
   * no additional configuration is required for basic speaker output.
   */
  start(): void {
    if (this._started) return;

    const pClient = this.pLnG?.pClient;
    if (!pClient) {
      console.warn('[ProximityAudioManager] pLnG.pClient not available; audio will not start');
      return;
    }

    try {
      // Create the MV proximity listener. Its internal MV.MVRP.Audio instance
      // handles all decoding (both codec 0 PCM16 and codec 1 delta-compression)
      // and routes decoded samples to AudioContext.destination automatically.
      this.proximity = new MV.MVRP.Proximity(pClient);

      const mvAudio = this.proximity.GetAudio();

      // Start(false) → creates AudioContext without requesting microphone access.
      // Pass true instead if microphone capture is also required.
      mvAudio.Start(false);

      // Build the spatial audio layer on top of the same AudioContext so that
      // all nodes share the same sample clock.
      const ctx: AudioContext = mvAudio.m_pContext;
      if (ctx) {
        this.audioContext = ctx;
        this.audioPlayer = new AVStreamAudioPlayer(ctx);

        // Hook into MVRP decode to capture raw PCM samples
        this.setupDecodeInterception(mvAudio);

        console.log('[ProximityAudioManager] AVStreamAudioPlayer ready (sampleRate:', ctx.sampleRate, 'Hz)');
      }

      this._started = true;
      console.log('[ProximityAudioManager] Proximity audio started');
    } catch (err) {
      console.error('[ProximityAudioManager] Failed to start audio:', err);
    }
  }

  /**
   * Stop the audio engine and release all resources.
   *
   * Idempotent: calling stop() when not started has no effect.
   */
  stop(): void {
    if (!this._started) return;
    this._started = false;

    if (this.audioPlayer) {
      this.audioPlayer.disconnect();
      this.audioPlayer = null;
    }

    this.audioContext = null;

    if (this.proximity) {
      try {
        const mvAudio = this.proximity.GetAudio();
        mvAudio?.Stop();
        this.proximity.destructor();
      } catch (err) {
        console.warn('[ProximityAudioManager] Error during audio teardown:', err);
      }
      this.proximity = null;
    }

    console.log('[ProximityAudioManager] Proximity audio stopped');
  }

  // ─── Audio controls ───────────────────────────────────────────────────────

  /**
   * Mute or unmute local microphone transmission to the server.
   * Has no effect if audio has not been started or if capture was not enabled.
   *
   * @param muted  `true` to mute microphone output; `false` to unmute.
   */
  muteLocalMic(muted: boolean): void {
    this.proximity?.GetAudio()?.Mute(muted);
  }

  /**
   * Enable or disable speaker output (deaf mode).
   * When deafened, incoming audio packets are decoded but not played back.
   *
   * @param deaf  `true` to silence speaker output; `false` to restore it.
   */
  deafOutput(deaf: boolean): void {
    this.proximity?.GetAudio()?.Deaf(deaf);
  }

  // ─── Accessors ────────────────────────────────────────────────────────────

  /**
   * Returns the AudioContext for this session, or `null` if audio has not
   * been started yet.
   */
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  /**
   * Returns the AVStreamAudioPlayer for this session, or `null` if audio has
   * not been started yet.
   *
   * Use the player to route additional decoded buffers through the
   * GainNode → PannerNode → destination spatial audio chain, or to adjust
   * per-stream volume and 3-D position.
   */
  getAudioPlayer(): AVStreamAudioPlayer | null {
    return this.audioPlayer;
  }

  /**
   * Returns the underlying MV.MVRP.Proximity instance, or `null` if audio has
   * not been started.  Exposed for advanced use (e.g. listening to proximity
   * events such as `onAvatarUpdate` or `onControl`).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getProximity(): any {
    return this.proximity;
  }

  /**
   * Connect an AudioFrameCapture instance to the audio stream.
   * Designed to be called after the player is available (i.e. after start()).
   * @param capture The AudioFrameCapture instance to wire in.
   */
  connectAudioCapture(capture: AudioFrameCapture): void {
    if (!this.audioPlayer) return;
    const node = capture.processorNode;
    if (node) {
      this.audioPlayer.connectTap(node);
    }
  }

  /**
   * Disconnect a previously wired AudioFrameCapture.
   * @param capture The AudioFrameCapture instance to disconnect.
   */
  disconnectAudioCapture(capture: AudioFrameCapture): void {
    if (!this.audioPlayer) return;
    const node = capture.processorNode;
    if (node) {
      this.audioPlayer.disconnectTap(node);
    }
  }

  /**
   * Register an AudioFrameCapture instance to receive decoded samples directly
   * from the MVRP decode stage.  MVRP passes `channelData` as a pre-interleaved
   * Float32Array (L0, R0, L1, R1, …), which is written directly to the capture's
   * ring buffer on every decode call.
   *
   * Call this after {@link start} to wire a capture into the decode path.
   * Only one capture may be registered at a time; calling again replaces any
   * previously registered capture.
   *
   * @param capture The AudioFrameCapture instance to wire in.
   */
  registerDecodeCapture(capture: AudioFrameCapture): void {
    this.decodeFrameCapture = capture;
    console.log('[ProximityAudioManager] AudioFrameCapture registered for decode interception');
  }

  /**
   * Unregister the current decode capture.
   * After this call, decoded samples are no longer forwarded to a capture
   * instance.  Playback is unaffected.
   */
  unregisterDecodeCapture(): void {
    this.decodeFrameCapture = null;
    console.log('[ProximityAudioManager] AudioFrameCapture unregistered');
  }

  get decodedIsMono(): boolean | null {
    return this._decodedIsMono;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setupDecodeInterception(mvAudio: any): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalDecode0: any = mvAudio.Decode[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originalDecode1: any = mvAudio.Decode[1];

    const decodeInterceptor = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mvAudioCtx: any,
      channelData: Float32Array,
      wSamples: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byteStream: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      originalFn: any,
      codecLabel: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any => {
      const result = originalFn.call(mvAudioCtx, channelData, wSamples, byteStream);

      if (this.decodeFrameCapture && wSamples > 0) {
        // Auto-detect mono vs stereo on first decode call
        if (this._decodedIsMono === null) {
          const isMono = channelData.length <= wSamples;
          this._decodedIsMono = isMono;
          console.log(
            `[ProximityAudioManager] Decode format detected: ${isMono ? 'MONO' : 'STEREO'} | ` +
            `channelData.length=${channelData.length} wSamples=${wSamples} codec=${codecLabel}`
          );
        }

        const validLength = this._decodedIsMono ? wSamples : wSamples * 2;
        this.writeDecodedSamplesToCapture(channelData, validLength);
      }

      return result;
    };

    mvAudio.Decode[0] = function (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any,
      channelData: Float32Array,
      wSamples: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byteStream: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any {
      return decodeInterceptor(this, channelData, wSamples, byteStream, originalDecode0, 'Decode0');
    };

    mvAudio.Decode[1] = function (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this: any,
      channelData: Float32Array,
      wSamples: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      byteStream: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): any {
      return decodeInterceptor(this, channelData, wSamples, byteStream, originalDecode1, 'Decode1');
    };
  }

  /**
   * Write interleaved audio data directly to the frame capture buffer.
   * The channelData from MVRP's decode is already in interleaved format
   * (L0, R0, L1, R1, …), so no further interleaving is needed.
   *
   * @param channelData  Pre-interleaved Float32Array from the MVRP decoder.
   */
  private writeDecodedSamplesToCapture(channelData: Float32Array, length: number): void {
    if (!this.decodeFrameCapture) return;
    this.decodeFrameCapture.buffer.write(channelData, 0, length);
  }

  /**
   * Returns the live `m_Buffer` object from MVRP's internal audio decoder, or
   * `null` if audio has not been started.
   *
   * The returned object is a **live reference** updated in-place by MVRP as
   * each audio frame is decoded.  Copy data out of it promptly; do not hold
   * long-lived references to individual sub-fields.
   *
   * Buffer structure:
   * ```
   *   pArrayBuffer  – raw binary data          (ArrayBuffer | null)
   *   asSample      – decoded samples (float)  (number[] | null)
   *   nSize         – buffer capacity           (number)
   *   nBytes        – bytes currently used      (number)
   *   nCount        – sample count for slice    (number)
   *   nLength       – current data length       (number)
   *   nHead         – read head position        (number)
   *   nTail         – write tail position       (number)
   *   nSlice        – slice index, increments per decoded frame (number)
   * ```
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAudioBuffer(): any | null {
    if (!this.proximity) return null;
    return this.proximity.GetAudio()?.m_Buffer ?? null;
  }

  /**
   * Returns audio stream metadata from MVRP, or `null` if audio has not been
   * started.
   *
   * @returns Object with:
   *   - `sampleRate`      – sample rate in Hz (typically 48000)
   *   - `samplesPerSlice` – decoded samples per frame slice (~960)
   *   - `bytesPerSample`  – bytes per sample (2 for PCM16, 4 for float32)
   */
  getAudioMetadata(): { sampleRate: number; samplesPerSlice: number; bytesPerSample: number } | null {
    if (!this.proximity) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mvrpAudio: any = this.proximity.GetAudio();
    if (!mvrpAudio) return null;
    return {
      sampleRate: mvrpAudio.m_nSampleRate ?? 48000,
      samplesPerSlice: mvrpAudio.m_nSamples_Slice ?? 960,
      bytesPerSample: mvrpAudio.m_nBytes_Sample ?? 2,
    };
  }

  /** Returns `true` if the audio engine is currently active. */
  get isStarted(): boolean {
    return this._started;
  }
}
