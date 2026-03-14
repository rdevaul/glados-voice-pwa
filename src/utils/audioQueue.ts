/**
 * AudioQueue — Sequential audio playback via Web Audio API.
 *
 * Chrome's autoplay policy blocks HTMLAudioElement.play() if called more
 * than ~1 second after a user gesture — which is always the case for async
 * TTS responses. Fix: route playback through an AudioContext that is
 * explicitly unlocked during the button-press gesture. An unlocked
 * AudioContext can play audio at any future time without restriction.
 *
 * Architecture:
 *   warmUp()  — called on button press (gesture): creates AudioContext,
 *               plays a silent buffer to unlock it, and connects the
 *               HTMLAudioElement to the context graph via createMediaElementSource.
 *   enqueue() — called when TTS URL arrives: fetches audio, plays via
 *               AudioContext source node (not HTMLAudioElement.play() directly).
 */

export type AudioQueueCallback = (url: string) => void;
export type AudioQueueErrorCallback = (error: Error, url: string) => void;
export type AudioQueueEmptyCallback = () => void;

export class AudioQueue {
  private queue: string[] = [];
  private audio: HTMLAudioElement;
  private _isPlaying: boolean = false;
  private _isPaused: boolean = false;
  private currentUrl: string | null = null;

  // Web Audio API — unlocked during warmUp gesture
  private ctx: AudioContext | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private unlocked: boolean = false;

  // Keepalive tone — prevents AudioContext suspension
  private keepaliveOsc: OscillatorNode | null = null;
  private keepaliveGain: GainNode | null = null;
  private keepaliveRunning: boolean = false;

  public onPlaybackStart?: AudioQueueCallback;
  public onPlaybackEnd?: AudioQueueCallback;
  public onQueueEmpty?: AudioQueueEmptyCallback;
  public onError?: AudioQueueErrorCallback;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';

    this.audio.onended = () => {
      if (this.currentUrl && this.onPlaybackEnd) {
        this.onPlaybackEnd(this.currentUrl);
      }
      this.currentUrl = null;
      this._isPlaying = false;

      // Resume keepalive before playing next (if queue empty, onQueueEmpty will handle it)
      this.resumeKeepalive();
      this.playNext();
    };

    this.audio.onerror = () => {
      const error = new Error(`Failed to load audio: ${this.currentUrl}`);
      if (this.currentUrl && this.onError) {
        this.onError(error, this.currentUrl);
      }
      console.error('AudioQueue error:', this.currentUrl, this.audio.error);
      this.currentUrl = null;
      this._isPlaying = false;
      this.playNext();
    };
  }

  /**
   * Start the keepalive tone — a continuous very quiet sine wave that prevents
   * AudioContext suspension. Called automatically after warmUp() unlocks the context.
   */
  private startKeepalive(): void {
    const ctx = this.ctx;
    if (!ctx || this.keepaliveRunning) return;

    console.log('[AudioQueue] startKeepalive — ctx.state:', ctx.state);

    const now = ctx.currentTime;

    // Create a continuous quiet sine wave at 220Hz (A3)
    this.keepaliveOsc = ctx.createOscillator();
    this.keepaliveOsc.type = 'sine';
    this.keepaliveOsc.frequency.setValueAtTime(220, now);

    this.keepaliveGain = ctx.createGain();
    this.keepaliveGain.gain.setValueAtTime(0.005, now); // Near-silent — just enough to keep AudioContext alive

    this.keepaliveOsc.connect(this.keepaliveGain);
    this.keepaliveGain.connect(ctx.destination);

    this.keepaliveOsc.start(now);
    this.keepaliveRunning = true;
    console.log('[AudioQueue] keepalive tone started');
  }

  /**
   * Stop the keepalive tone temporarily (e.g., during TTS playback).
   */
  public stopKeepalive(): void {
    if (!this.keepaliveGain || !this.keepaliveRunning) return;

    const ctx = this.ctx;
    if (!ctx) return;

    console.log('[AudioQueue] stopKeepalive — pausing during TTS');
    const now = ctx.currentTime;

    // Ramp down to silence quickly
    this.keepaliveGain.gain.cancelScheduledValues(now);
    this.keepaliveGain.gain.setValueAtTime(this.keepaliveGain.gain.value, now);
    this.keepaliveGain.gain.linearRampToValueAtTime(0, now + 0.05);
  }

  /**
   * Resume the keepalive tone after TTS playback.
   */
  private resumeKeepalive(): void {
    if (!this.keepaliveGain || !this.keepaliveRunning) return;

    const ctx = this.ctx;
    if (!ctx) return;

    console.log('[AudioQueue] resumeKeepalive — restoring after TTS');
    const now = ctx.currentTime;

    // Ramp back up to keepalive volume
    this.keepaliveGain.gain.cancelScheduledValues(now);
    this.keepaliveGain.gain.setValueAtTime(this.keepaliveGain.gain.value, now);
    this.keepaliveGain.gain.linearRampToValueAtTime(0.005, now + 0.1);
  }

  /**
   * Synthesize a short beep using the AudioContext.
   * Safe to call any time after the context is created (even before unlocked=true,
   * since it's called from inside the gesture-driven resumePromise.then()).
   */
  public playBeep(frequency = 880, duration = 0.25, volume = 0.55): void {
    const ctx = this.ctx;
    if (!ctx) return;
    console.log('[AudioQueue] playBeep — ctx.state:', ctx.state, 'currentTime:', ctx.currentTime);
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.008);   // fast attack
    gain.gain.linearRampToValueAtTime(0, now + duration);     // smooth release
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  }

  /**
   * Call from a user gesture to unlock audio for the session.
   * Creates an AudioContext, plays a start beep to unlock it, and
   * connects the HTMLAudioElement to the context graph.
   * Once unlocked, audio can play at any future time.
   * Also plays the start beep on every subsequent call (each button press).
   */
  public warmUp(): void {
    if (this.unlocked) {
      // Already unlocked — play the start beep immediately for this press
      this.playBeep();
      if (this.queue.length > 0 && !this._isPlaying && !this._isPaused) {
        this.playNext();
      }
      return;
    }

    try {
      // Create AudioContext within the gesture.
      // On Chrome/Safari, a context created inside a user gesture starts 'running'
      // immediately — no need to await resume(). Waiting on resume() can stall
      // indefinitely on iOS WebKit inside React synthetic events.
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = new AudioContext();
      }
      const ctx = this.ctx;

      console.log('[AudioQueue] warmUp — ctx.state:', ctx.state);

      // Connect the HTMLAudioElement to the AudioContext graph synchronously.
      // createMediaElementSource can only be called once per element.
      if (!this.mediaSource) {
        this.mediaSource = ctx.createMediaElementSource(this.audio);
        this.mediaSource.connect(ctx.destination);
      }

      // Mark unlocked immediately — don't block on resume() promise.
      this.unlocked = true;
      console.log('[AudioQueue] unlocked (synchronous)');

      // Play the beep once the context is actually running.
      // On iOS the context starts suspended even inside a gesture; we can't schedule
      // oscillators against currentTime=0 and expect them to fire correctly after resume.
      // Strategy: play immediately if already running, otherwise wait for resume()
      // with a 250ms timeout fallback (the nudge above should resolve it in <50ms).
      // iOS/Safari unlock strategy: create all audio nodes synchronously
      // within the user gesture, then resume(). Nodes created during the
      // gesture are allowed to play once the context resumes — but nodes
      // created in an async callback after the gesture may be blocked.
      //
      // So we pre-create the beep oscillator NOW, start it, and it will
      // begin producing sound as soon as ctx.resume() completes.

      const now = ctx.currentTime;
      const beepOsc = ctx.createOscillator();
      const beepGain = ctx.createGain();
      beepOsc.type = 'sine';
      beepOsc.frequency.setValueAtTime(880, now);
      beepGain.gain.setValueAtTime(0, now);
      // Schedule the beep envelope — will fire once context starts running
      beepGain.gain.linearRampToValueAtTime(0.55, now + 0.008);
      beepGain.gain.linearRampToValueAtTime(0, now + 0.25);
      beepOsc.connect(beepGain);
      beepGain.connect(ctx.destination);
      beepOsc.start(now);
      beepOsc.stop(now + 0.26);

      console.log('[AudioQueue] beep pre-scheduled at t=', now, 'ctx.state:', ctx.state);

      if (ctx.state !== 'running') {
        ctx.resume().then(() => {
          console.log('[AudioQueue] resumed — ctx.currentTime:', ctx.currentTime);
          this.startKeepalive();
        }).catch(err => {
          console.log('[AudioQueue] resume failed:', String(err));
        });
      } else {
        this.startKeepalive();
      }

      // Play anything that was queued
      if (this.queue.length > 0 && !this._isPlaying) {
        this.playNext();
      }

    } catch (err) {
      console.log('[AudioQueue] AudioContext creation failed, using fallback:', String(err));
      // Fallback: original silent-audio approach
      const silentAudio = new Audio();
      silentAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      silentAudio.play().then(() => {
        this.unlocked = true;
        silentAudio.pause();
        if (this.queue.length > 0 && !this._isPlaying) this.playNext();
      }).catch(() => {});
    }
  }

  public enqueue(url: string): void {
    this.queue.push(url);
    if (!this._isPlaying && !this._isPaused) {
      this.playNext();
    }
  }

  public clear(): void {
    this.queue = [];
    this.audio.pause();
    this.audio.src = '';
    this.currentUrl = null;
    this._isPlaying = false;
    this._isPaused = false;
  }

  public pause(): void {
    if (this._isPlaying) {
      this.audio.pause();
      this._isPaused = true;
      this._isPlaying = false;
    }
  }

  public resume(): void {
    if (this._isPaused && this.currentUrl) {
      this._isPaused = false;
      this._isPlaying = true;
      this.audio.play().catch(err => {
        console.error('[AudioQueue] resume failed:', err);
        this._isPlaying = false;
      });
    } else if (!this._isPlaying && this.queue.length > 0) {
      this.playNext();
    }
  }

  public skip(): void {
    if (this._isPlaying || this._isPaused) {
      this.audio.pause();
      this._isPlaying = false;
      this._isPaused = false;
      this.playNext();
    }
  }

  /** Returns the unlocked AudioContext, or null if warmUp hasn't been called yet. */
  public getContext(): AudioContext | null { return this.unlocked ? this.ctx : null; }

  public get isPlaying(): boolean { return this._isPlaying; }
  public get isPaused(): boolean { return this._isPaused; }
  public get queueLength(): number { return this.queue.length; }
  public get currentTime(): number { return this.audio.currentTime; }
  public get duration(): number { return this.audio.duration || 0; }

  private playNext(): void {
    if (this.queue.length === 0) {
      this._isPlaying = false;
      // Restore keepalive when queue empties
      this.resumeKeepalive();
      this.onQueueEmpty?.();
      return;
    }

    const url = this.queue.shift()!;
    this.currentUrl = url;
    this.audio.src = url;

    // Pause keepalive during TTS playback
    this.stopKeepalive();

    this.onPlaybackStart?.(url);

    // If AudioContext is unlocked, the media element source will play through it.
    // If not yet unlocked, fall back to direct HTMLAudioElement.play().
    const playPromise = this.audio.play();
    if (playPromise) {
      playPromise
        .then(() => {
          this._isPlaying = true;
          console.log('[AudioQueue] playing:', url);
        })
        .catch(err => {
          console.warn('[AudioQueue] play blocked:', err.name, err.message);
          this._isPlaying = false;

          if (err.name === 'NotAllowedError') {
            // Autoplay blocked — re-queue, will retry on next warmUp
            this.queue.unshift(url);
            this.unlocked = false;
            // Restore keepalive if playback failed
            this.resumeKeepalive();
          } else if (this.onError) {
            this.onError(err, url);
            // Restore keepalive on error
            this.resumeKeepalive();
          }
        });
    }
  }
}

let audioQueueInstance: AudioQueue | null = null;

export function getAudioQueue(): AudioQueue {
  if (!audioQueueInstance) {
    audioQueueInstance = new AudioQueue();
  }
  return audioQueueInstance;
}
