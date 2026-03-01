/**
 * useThinkingTone — Ambient audio feedback during processing.
 *
 * iOS Safari requires OscillatorNode.start() to happen within a user gesture,
 * not just AudioContext.resume(). This hook pre-starts the oscillator silently
 * during warmUp() (which is called from the button-press gesture), then
 * start()/stop() simply ramp the gain up and down.
 *
 * Tone design:
 *   - 180 Hz sine wave, LFO-pulsed at 0.4 Hz (gentle breathing rhythm)
 *   - Volume: ~22% of full scale — background, not foreground
 *   - Smooth fade-in (0.4s) and fade-out (0.6s) to avoid clicks
 */

import { useRef, useCallback, useEffect } from 'react';

interface ThinkingToneOptions {
  frequency?: number;   // Hz, default 180
  pulseRate?: number;   // LFO Hz, default 0.4
  volume?: number;      // 0-1, default 0.22
  fadeIn?: number;      // seconds, default 0.4
  fadeOut?: number;     // seconds, default 0.6
}

export function useThinkingTone(options: ThinkingToneOptions = {}) {
  const {
    frequency = 180,
    pulseRate = 0.4,
    volume    = 0.22,
    fadeIn    = 0.4,
    fadeOut   = 0.6,
  } = options;

  const ctxRef     = useRef<AudioContext | null>(null);
  const gainRef    = useRef<GainNode | null>(null);
  const readyRef   = useRef(false);   // true once graph is built + osc started
  const activeRef  = useRef(false);   // true while tone should be audible

  /**
   * warmUp — call inside a user gesture (button press).
   * Builds the entire Web Audio graph and starts oscillators at gain=0.
   * Safe to call multiple times; no-ops after the first successful call.
   */
  const warmUp = useCallback(() => {
    if (readyRef.current) return;

    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;

      // Resume immediately — we're inside a gesture
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const now = ctx.currentTime;

      // Main oscillator
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency, now);

      // LFO for amplitude modulation
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.setValueAtTime(pulseRate, now);

      // LFO gain (scales modulation depth)
      const lfoGain = ctx.createGain();
      lfoGain.gain.setValueAtTime(volume * 0.4, now);

      // Master gain — starts at 0 (silent), ramped by start()/stop()
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(0, now);

      // Graph: osc → masterGain → destination
      //        lfo → lfoGain → masterGain.gain (AM)
      osc.connect(masterGain);
      lfo.connect(lfoGain);
      lfoGain.connect(masterGain.gain);
      masterGain.connect(ctx.destination);

      // Start oscillators NOW, inside the gesture — gain is 0 so silent
      osc.start(now);
      lfo.start(now);

      gainRef.current = masterGain;
      readyRef.current = true;
    } catch (e) {
      console.warn('useThinkingTone: Web Audio API unavailable', e);
    }
  }, [frequency, pulseRate, volume]);

  /** Fade the tone in. Call when processing starts. */
  const start = useCallback(() => {
    if (!readyRef.current || activeRef.current) return;
    activeRef.current = true;

    const ctx  = ctxRef.current!;
    const gain = gainRef.current!;
    const now  = ctx.currentTime;

    // Resume context if it got suspended (e.g. tab backgrounded)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
  }, [volume, fadeIn]);

  /** Fade the tone out. Call when processing ends. */
  const stop = useCallback(() => {
    if (!readyRef.current || !activeRef.current) return;
    activeRef.current = false;

    const ctx  = ctxRef.current!;
    const gain = gainRef.current!;
    const now  = ctx.currentTime;

    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeOut);
  }, [fadeOut]);

  // Close AudioContext on unmount
  useEffect(() => {
    return () => {
      ctxRef.current?.close().catch(() => {});
      readyRef.current = false;
      activeRef.current = false;
    };
  }, []);

  return { warmUp, start, stop };
}
