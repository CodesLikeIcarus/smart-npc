import type { ProximityAudioManager } from '../audio/ProximityAudioManager.js';
import { AudioFrameCapture } from '../audio/AudioFrameCapture.js';
import { ProximityAvatarList } from './ProximityAvatarList.js';
import type { AvatarInfo } from './ProximityAvatarList.js';

/** Options for configuring the AudioVisualizer. */
export interface VisualizerOptions {
  /** Background colour of the canvas. Default: 'rgba(0,0,0,0.45)'. */
  backgroundColor?: string;
  /** Bar colour for the left channel. Default: '#00eaff' (cyan). */
  colorLeft?: string;
  /** Bar colour for the right channel. Default: '#ff00cc' (magenta). */
  colorRight?: string;
}

/**
 * AudioVisualizer – renders a real-time dual-channel (L/R) looping time-series
 * waveform on an HTML5 canvas element placed inside the supplied container.
 *
 * The canvas is 280 × 240 px: the top 120 px show the left-channel waveform
 * (cyan) and the bottom 120 px show the right-channel waveform (magenta).
 * Each horizontal pixel corresponds to one amplitude sample stored in a
 * 280-sample circular buffer, producing a continuously scrolling display
 * similar to an oscilloscope or Audacity waveform view.
 *
 * Lifecycle
 * ─────────
 *   const vis = new AudioVisualizer(containerEl);
 *   vis.attachAudioSource(proximityAudioManager);   // begins animation loop
 *   …avatar is active…
 *   vis.dispose();                                  // stops loop, removes canvas
 *
 * Audio levels are sampled each animation frame by reading PCM data from an
 * {@link AudioFrameCapture} that taps the MVRP audio stream.  The first
 * {@link FRAME_SKIP_THRESHOLD} frames are discarded to allow the capture buffer
 * to fill with real audio before samples are fed to `updateFromPcm()`.
 * When no audio source is attached, `update()` can be called directly with
 * normalised L/R amplitude values for testing.
 */
export class AudioVisualizer {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly opts: Required<VisualizerOptions>;

  // MVRP audio manager reference (set in attachAudioSource)
  private audioManager: ProximityAudioManager | null = null;

  // AudioFrameCapture tap used to read decoded PCM from the MVRP stream
  private audioCapture: AudioFrameCapture | null = null;

  // ProximityAvatarList tracks nearby avatars and updates the proximity panel
  private proximityList: ProximityAvatarList | null = null;
  private proximityPanel: HTMLElement | null = null;
  // Scratch buffer for reading PCM samples from the audioCapture ring buffer
  private readonly readBuffer: Float32Array = new Float32Array(960);

  // Frame skip counter – discard the first N frames to let the buffer fill
  private frameSkipCounter: number = 0;
  private readonly FRAME_SKIP_THRESHOLD: number = 5; // Skip first 5 frames

  // Current L/R amplitude levels (0–1) read from MVRP or set via update()
  private levelL: number = 0;
  private levelR: number = 0;

  // Frame counter used for periodic diagnostic logging in drawFrame()
  private frameCount: number = 0;

  // requestAnimationFrame handle
  private animFrameId: number | null = null;

  // ─── Rolling sample buffers ──────────────────────────────────────────────────

  // Number of samples kept (one per canvas pixel width)
  private static readonly BUFFER_SIZE = 280;

  // Circular buffers for L/R channel amplitude samples (values in 0–1)
  private readonly sampleBufferL: Float32Array = new Float32Array(AudioVisualizer.BUFFER_SIZE);
  private readonly sampleBufferR: Float32Array = new Float32Array(AudioVisualizer.BUFFER_SIZE);

  // Write cursor; the oldest sample lives at this index
  private bufferIndex: number = 0;

  constructor(container: HTMLElement, options?: VisualizerOptions) {
    this.container = container;

    this.opts = {
      backgroundColor: options?.backgroundColor ?? 'rgba(0,0,0,0.45)',
      colorLeft: options?.colorLeft ?? '#00eaff',
      colorRight: options?.colorRight ?? '#ff00cc',
    };

    // Create and configure canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'audio-visualizer-canvas';
    // Intrinsic resolution; CSS controls display size
    this.canvas.width = 280;
    this.canvas.height = 240;
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('[AudioVisualizer] Canvas 2D context unavailable');
    this.ctx2d = ctx;

    // Draw an idle state so the canvas is not blank before audio starts
    this.drawFrame();

    // Locate the proximity panel if it exists in the DOM
    this.proximityPanel = document.getElementById('proximity-panel');
  }

  // ─── Integration ────────────────────────────────────────────────────────────

  /**
   * Wire the visualizer into the live audio stream managed by `audioManager`.
   *
   * Creates an {@link AudioFrameCapture} and enables it to tap the MVRP audio
   * stream, buffering decoded PCM samples for each animation frame.
   * The frame skip counter discards the first {@link FRAME_SKIP_THRESHOLD}
   * frames to allow the capture buffer to fill with real audio data before
   * feeding samples to `updateFromPcm()`.
   *
   * Starts the requestAnimationFrame draw loop automatically.
   * Idempotent: subsequent calls have no effect while a source is already
   * attached.
   */
  attachAudioSource(audioManager: ProximityAudioManager): void {
    if (this.audioManager) return; // already attached

    const proximity = audioManager.getProximity();
    if (!proximity) {
      console.warn('[AudioVisualizer] Proximity not ready');
      return;
    }

    this.audioManager = audioManager;

    // Create and enable an AudioFrameCapture tap into the MVRP audio stream
    this.audioCapture = new AudioFrameCapture(audioManager);
    this.audioCapture.enable();

    // Wire the capture into MVRP's decode stage to get raw PCM data
    audioManager.registerDecodeCapture(this.audioCapture);

    console.log('[AudioVisualizer] Capture attached to decode interceptor');

    // Initialize proximity avatar list and attach to Proximity
    this.proximityList = new ProximityAvatarList();
    this.proximityList.init(proximity);  // Attach directly to Proximity instance
    this.proximityList.addObserver((avatars: AvatarInfo[]) => this.updateProximityPanel(avatars));

    this.proximityPanel = document.getElementById('proximity-panel');
    console.log('[AudioVisualizer] Proximity avatar list initialized');

    this.startLoop();
    console.log('[AudioVisualizer] Attached to audio source; visualizer active');
  }

  /**
   * Detach from the current audio source, stop the animation loop, and release
   * the AudioFrameCapture.  The canvas remains in the DOM.
   * Idempotent: calling when no source is attached has no effect.
   */
  detachAudioSource(): void {
    if (this.audioManager) {
      this.audioManager.unregisterDecodeCapture();
      console.log('[AudioVisualizer] Capture detached from decode interceptor');
    }

    if (this.audioCapture) {
      this.audioCapture.disable();
      this.audioCapture.dispose();
      this.audioCapture = null;
    }

    if (this.proximityList) {
      this.proximityList.dispose();
      this.proximityList = null;
    }

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.audioManager = null;
  }

  /**
   * Update the local avatar's persona ID and position in the proximity list.
   * Called from InWorldSession.teleportTo() to keep distance calculations accurate.
   *
   * @param personaID The local persona's numeric ID
   * @param position The Cartesian position {x, y, z} in global coordinates
   */
  updateProximityListPosition(personaID: number, position: { x: number; y: number; z: number }): void {
    if (this.proximityList) {
      this.proximityList.updateLocalPosition(personaID, position);
    }
  }

  /**
   * Push normalised L/R amplitude values directly into the visualizer.
   *
   * Appends one sample to the circular buffers and redraws.
   * Useful for testing.  Values should be in the range 0–1.
   */
  update(levelL: number, levelR: number): void {
    this.levelL = Math.max(0, Math.min(1, levelL));
    this.levelR = Math.max(0, Math.min(1, levelR));
    this.pushSample(this.levelL, this.levelR);
    this.drawFrame();
  }

  /**
   * Update the visualizer with raw PCM samples from a decoded audio frame.
   *
   * Computes per-channel RMS from the interleaved samples and updates the
   * amplitude bars accordingly.  The animation loop is started automatically
   * if it is not already running.
   *
   * This method provides a direct PCM path and is the preferred route for
   * feeding speech-to-text pipelines that already hold a decoded PCM slice.
   *
   * @param samples       Interleaved PCM samples (numeric array-like).
   * @param channelCount  Channels interleaved in `samples`.  Default: 2.
   * @param normalize     When `true` the values are treated as signed int16
   *                      (range −32 768 … +32 767) and divided by 32 768 to
   *                      produce a 0–1 amplitude.  Set to `false` when samples
   *                      are already normalised.  Default: `true`.
   */
  updateFromPcm(samples: ArrayLike<number>, channelCount = 2, normalize = true): void {
    if (samples.length === 0) return;

    const scale = normalize ? 32768 : 1;
    let sumSqL = 0;
    let sumSqR = 0;
    const frames = Math.floor(samples.length / channelCount);

    if (channelCount >= 2) {
      for (let i = 0; i < frames; i++) {
        const l = (samples[i * 2] as number) / scale;
        const r = (samples[i * 2 + 1] as number) / scale;
        sumSqL += l * l;
        sumSqR += r * r;
      }
      this.levelL = Math.min(Math.sqrt(sumSqL / (frames || 1)), 1);
      this.levelR = Math.min(Math.sqrt(sumSqR / (frames || 1)), 1);
    } else {
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] as number) / scale;
        sumSqL += v * v;
      }
      const rms = Math.min(Math.sqrt(sumSqL / (samples.length || 1)), 1);
      this.levelL = rms;
      this.levelR = rms;
    }

    // Ensure the animation loop is running even when no audio source has been
    // attached via attachAudioSource().
    this.pushSample(this.levelL, this.levelR);
    if (this.animFrameId === null) {
      this.startLoop();
    } else {
      this.drawFrame();
    }
  }

  /**
   * Stop the animation loop and remove the canvas from the DOM.
   * The instance must not be used after calling dispose().
   */
  dispose(): void {
    this.stopLoop();
    this.frameSkipCounter = 0;

    if (this.audioCapture) {
      if (this.audioManager) {
        this.audioManager.unregisterDecodeCapture();
      }
      this.audioCapture.disable();
      this.audioCapture.dispose();
      this.audioCapture = null;
    }

    if (this.proximityList) {
      this.proximityList.dispose();
      this.proximityList = null;
    }

    this.audioManager = null;
    this.proximityPanel = null;

    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    console.log('[AudioVisualizer] Disposed');
  }

  // ─── Animation loop ─────────────────────────────────────────────────────────

  private startLoop(): void {
    if (this.animFrameId !== null) return;

    this.frameSkipCounter = 0; // Reset counter

    const tick = () => {
      this.animFrameId = requestAnimationFrame(tick);

      if (this.audioCapture) {
        // Skip first N frames to allow buffer to fill with real data
        if (this.frameSkipCounter < this.FRAME_SKIP_THRESHOLD) {
          this.frameSkipCounter++;
          // Still consume from buffer to advance pointers
          this.audioCapture.buffer.read(this.readBuffer);
        } else {
          const n = this.audioCapture.buffer.read(this.readBuffer);
          if (n > 0) {
            this.updateFromPcm(this.readBuffer.subarray(0, n), 2, false);
          }
        }
      }

      this.drawFrame();
    };

    this.animFrameId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  /**
   * Write the current L/R levels into the circular sample buffers and advance
   * the write cursor, overwriting the oldest sample when the buffer is full.
   */
  private pushSample(l: number, r: number): void {
    this.sampleBufferL[this.bufferIndex] = l;
    this.sampleBufferR[this.bufferIndex] = r;
    this.bufferIndex = (this.bufferIndex + 1) % AudioVisualizer.BUFFER_SIZE;
  }

  private drawFrame(): void {
    this.frameCount++;

    const { width, height } = this.canvas;
    const c = this.ctx2d;
    const halfH = height / 2;

    // Diagnostic logging: once per second (≈60 frames) when capture is active
    // if (this.audioCapture?.isEnabled) {
    //   const info = this.audioCapture.buffer.info;
    //   if (info.available > 0 && this.frameCount % 60 === 0) {
    //     const out = new Float32Array(100);
    //     const read = this.audioCapture.buffer.read(out);
    //     console.log('[drawFrame] Available:', info.available, 'Read:', read, 'Samples:', Array.from(out.slice(0, 10)));
    //   }
    // }

    // Background
    c.fillStyle = this.opts.backgroundColor;
    c.fillRect(0, 0, width, height);

    // Left channel (top half) and right channel (bottom half)
    this.drawWaveform(this.sampleBufferL, 0, halfH, this.opts.colorLeft);
    this.drawWaveform(this.sampleBufferR, halfH, halfH, this.opts.colorRight);
  }

  /**
   * Render one channel's circular sample buffer as a looping time-series
   * waveform.  For each x-pixel the amplitude is drawn as a vertical line
   * centred in `areaH`, so silence produces a thin centre line and full
   * amplitude spans the entire half-canvas.
   *
   * @param buffer  Circular buffer of amplitude samples (0–1).
   * @param yTop    Top edge of the channel's drawing area (canvas-space).
   * @param areaH   Height of the channel's drawing area in pixels.
   * @param color   Stroke colour.
   */
  private drawWaveform(buffer: Float32Array, yTop: number, areaH: number, color: string): void {
    const c = this.ctx2d;
    const n = AudioVisualizer.BUFFER_SIZE;
    const centerY = yTop + areaH / 2;
    const halfAreaH = areaH / 2;

    c.strokeStyle = color;
    c.lineWidth = 1;

    // Build all line segments in a single path to minimise draw calls.
    c.beginPath();
    for (let x = 0; x < n; x++) {
      // bufferIndex is the oldest sample; walk forward from there so the
      // waveform scrolls left-to-right with the most recent sample on the right.
      const sampleIdx = (this.bufferIndex + x) % n;
      const amp = buffer[sampleIdx] ?? 0;
      const lineH = amp * halfAreaH;

      c.moveTo(x, centerY - lineH);
      c.lineTo(x, centerY + lineH);
    }
    c.stroke();
  }

  /**
   * Update the proximity panel with a table of the 10 closest avatars.
   * DOM nodes are constructed via the DOM API to prevent XSS from avatar names.
   */
  private updateProximityPanel(avatars: AvatarInfo[]): void {
    if (!this.proximityPanel) return;

    // Clear existing content safely
    this.proximityPanel.textContent = '';

    const header = document.createElement('div');
    header.className = 'proximity-header';

    if (avatars.length === 0) {
      header.textContent = 'Nearby Avatars';
      this.proximityPanel.appendChild(header);

      const empty = document.createElement('div');
      empty.className = 'proximity-empty';
      empty.textContent = 'None in range';
      this.proximityPanel.appendChild(empty);
      return;
    }

    header.textContent = `Nearby Avatars (${avatars.length})`;
    this.proximityPanel.appendChild(header);

    // Build table of 10 closest avatars
    const table = document.createElement('table');
    table.className = 'proximity-table';

    // Table header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of ['Avatar ID', 'Name', 'Distance']) {
      const th = document.createElement('th');
      th.textContent = label;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = document.createElement('tbody');
    for (const a of avatars) {
      const tr = document.createElement('tr');

      const idTd = document.createElement('td');
      idTd.className = 'proximity-id';
      idTd.textContent = String(a.personaID);

      const nameTd = document.createElement('td');
      nameTd.className = 'proximity-name';
      nameTd.textContent = a.name;

      const distTd = document.createElement('td');
      distTd.className = 'proximity-distance';
      distTd.textContent = `${a.distance.toFixed(2)}m`;

      tr.appendChild(idTd);
      tr.appendChild(nameTd);
      tr.appendChild(distTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    this.proximityPanel.appendChild(table);
  }
}
