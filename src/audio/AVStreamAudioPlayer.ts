/**
 * AVStreamAudioPlayer – spatial audio output stage for decoded audio buffers.
 *
 * Creates a GainNode → PannerNode → AudioContext.destination signal chain.
 * Callers decode audio data into an AudioBuffer and hand it to `playBuffer()`;
 * the player schedules playback through the spatial nodes so that volume and
 * 3-D position can be controlled independently per stream.
 *
 * This class intentionally has no dependency on the MV vendor scripts; it
 * works purely with the standard Web Audio API and can therefore be unit-tested
 * in isolation or reused for any decoded audio source.
 */
export class AVStreamAudioPlayer {
  private readonly audioContext: AudioContext;
  private readonly gainNode: GainNode;
  private readonly pannerNode: PannerNode;
  private _connected: boolean = false;

  /**
   * @param audioContext  Shared AudioContext created by ProximityAudioManager.
   *                      All nodes are attached to this context so they share
   *                      the same sample clock as the MVRP audio pipeline.
   */
  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;

    this.gainNode   = audioContext.createGain();
    this.pannerNode = audioContext.createPanner();

    // Configure PannerNode for distance-based spatial audio.
    this.pannerNode.panningModel    = 'HRTF' as PanningModelType;
    this.pannerNode.distanceModel   = 'inverse' as DistanceModelType;
    this.pannerNode.refDistance     = 1;
    this.pannerNode.maxDistance     = 10000;
    this.pannerNode.rolloffFactor   = 1;
    this.pannerNode.coneInnerAngle  = 360;
    this.pannerNode.coneOuterAngle  = 0;
    this.pannerNode.coneOuterGain   = 0;

    // Wire up: gain → panner → speakers.
    this.gainNode.connect(this.pannerNode);
    this.pannerNode.connect(audioContext.destination);
    this._connected = true;
  }

  // ─── Playback ─────────────────────────────────────────────────────────────

  /**
   * Schedule an AudioBuffer for playback through the gain/panner chain.
   *
   * @param buffer    Decoded AudioBuffer (e.g. from MV.MVRP.Audio.Decode).
   * @param startTime Optional AudioContext time in seconds.  Defaults to
   *                  `audioContext.currentTime` (play immediately).
   */
  playBuffer(buffer: AudioBuffer, startTime?: number): void {
    if (!this._connected) return;

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start(startTime ?? this.audioContext.currentTime);
  }

  // ─── Spatial controls ─────────────────────────────────────────────────────

  /**
   * Set the 3-D position of this audio source in world space.
   * Uses the AudioContext coordinate system (right-hand, Y-up).
   */
  setPosition(x: number, y: number, z: number): void {
    if (typeof this.pannerNode.positionX !== 'undefined') {
      this.pannerNode.positionX.value = x;
      this.pannerNode.positionY.value = y;
      this.pannerNode.positionZ.value = z;
    } else {
      // Fallback for older browsers that only have setPosition().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.pannerNode as any).setPosition(x, y, z);
    }
  }

  // ─── Volume control ───────────────────────────────────────────────────────

  /**
   * Set the output gain (volume) for this stream.
   * @param volume  Linear gain value: 0.0 (silent) … 1.0 (unity) … >1.0 (boost).
   */
  setVolume(volume: number): void {
    this.gainNode.gain.value = volume;
  }

  /** Returns the current linear gain value. */
  get volume(): number {
    return this.gainNode.gain.value;
  }

  // ─── Analysis tap ─────────────────────────────────────────────────────────

  /**
   * Connect an additional output node (e.g. an AnalyserNode or
   * ChannelSplitterNode) to the gain node for monitoring purposes.
   *
   * The tap runs in parallel with the existing gain → panner → destination
   * chain and does not affect playback.
   *
   * @param destination  The Web Audio node to receive the tapped signal.
   */
  connectTap(destination: AudioNode): void {
    if (!this._connected) return;
    this.gainNode.connect(destination);
  }

  /**
   * Remove a previously connected tap node.
   *
   * @param destination  The node originally passed to `connectTap()`.
   */
  disconnectTap(destination: AudioNode): void {
    try {
      this.gainNode.disconnect(destination);
    } catch { /* ignore: node may already be disconnected */ }
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Disconnect all nodes and release Web Audio API resources.
   * After calling `disconnect()` the player must not be used again.
   */
  disconnect(): void {
    if (!this._connected) return;
    this._connected = false;

    try {
      this.gainNode.disconnect();
      this.pannerNode.disconnect();
    } catch {
      // Nodes may already be disconnected if the AudioContext was closed.
    }
  }

  /** Returns the underlying AudioContext. */
  get context(): AudioContext {
    return this.audioContext;
  }
}
