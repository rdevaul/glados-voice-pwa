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
   * Call from a user gesture to unlock audio for the session.
   * Creates an AudioContext, plays a silent buffer to unlock it, and
   * connects the HTMLAudioElement to the context graph.
   * Once unlocked, audio can play at any future time.
   */
  public warmUp(): void {
    if (this.unlocked) {
      if (this.queue.length > 0 && !this._isPlaying && !this._isPaused) {
        this.playNext();
      }
      return;
    }

    try {
      // Create AudioContext within the gesture
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = new AudioContext();
      }
      const ctx = this.ctx;

      // Resume if suspended
      const resumePromise = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();

      resumePromise.then(() => {
        // Play a silent 1-frame buffer — this is the key unlock step for Chrome
        const buf = ctx.createBuffer(1, 1, ctx.sampleRate);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);

        // Connect the HTMLAudioElement to the AudioContext graph.
        // createMediaElementSource can only be called once per element.
        if (!this.mediaSource) {
          this.mediaSource = ctx.createMediaElementSource(this.audio);
          this.mediaSource.connect(ctx.destination);
        }

        this.unlocked = true;
        console.log('[AudioQueue] unlocked via AudioContext');

        // Play anything that was queued while waiting for unlock
        if (this.queue.length > 0 && !this._isPlaying) {
          this.playNext();
        }
      }).catch(err => {
        console.warn('[AudioQueue] warmUp failed:', err);
      });

    } catch (err) {
      console.warn('[AudioQueue] AudioContext creation failed, falling back:', err);
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
      this.onQueueEmpty?.();
      return;
    }

    const url = this.queue.shift()!;
    this.currentUrl = url;
    this.audio.src = url;

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
          } else if (this.onError) {
            this.onError(err, url);
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
