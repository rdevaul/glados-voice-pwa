/**
 * useThinkingTone — Ambient audio feedback during processing.
 *
 * Plays a soft, pulsing synthesized tone while the assistant is thinking,
 * so the user gets audio confirmation that processing is happening without
 * having to look at the screen (useful while driving, etc.).
 *
 * Tone design:
 *   - Base: 180 Hz sine wave (low, unobtrusive)
 *   - Slow LFO pulse: 0.4 Hz AM modulation (gentle breathing rhythm)
 *   - Short fade-in / fade-out to avoid clicks
 *   - Volume: ~25% of full scale (background, not foreground)
 *
 * All synthesis via Web Audio API — no files, no network, no autoplay issues.
 */

import { useRef, useCallback, useEffect } from 'react';

interface ThinkingToneOptions {
  /** Base frequency in Hz. Default 180. */
  frequency?: number;
  /** Pulse rate in Hz (LFO). Default 0.4 (one pulse per ~2.5 seconds). */
  pulseRate?: number;
  /** Volume 0–1. Default 0.22. */
  volume?: number;
  /** Fade-in duration in seconds. Default 0.4. */
  fadeIn?: number;
  /** Fade-out duration in seconds. Default 0.6. */
  fadeOut?: number;
}

export function useThinkingTone(options: ThinkingToneOptions = {}) {
  const {
    frequency = 180,
    pulseRate = 0.4,
    volume = 0.22,
    fadeIn = 0.4,
    fadeOut = 0.6,
  } = options;

  const ctxRef      = useRef<AudioContext | null>(null);
  const oscRef      = useRef<OscillatorNode | null>(null);
  const lfoRef      = useRef<OscillatorNode | null>(null);
  const gainRef     = useRef<GainNode | null>(null);
  const lfoGainRef  = useRef<GainNode | null>(null);
  const activeRef   = useRef(false);

  const getCtx = useCallback((): AudioContext => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      ctxRef.current = new AudioContext();
    }
    return ctxRef.current;
  }, []);

  const warmUp = useCallback(() => {
    // Call during a user gesture to pre-create and unlock the AudioContext.
    // This prevents autoplay policy blocking when processing starts
    // (which may be slightly after the gesture completes).
    const ctx = getCtx();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }, [getCtx]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;

    const ctx = getCtx();

    // Resume if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Main oscillator — sine wave at base frequency
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);

    // Master gain — controls overall volume with fade-in
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeIn);

    // LFO — slow pulse amplitude modulation
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(pulseRate, now);

    // LFO gain — scales LFO output to ±40% of master volume
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(volume * 0.4, now);

    // Graph: osc → gain → destination
    //        lfo → lfoGain → gain.gain (modulates master gain)
    osc.connect(gain);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);  // AM modulation
    gain.connect(ctx.destination);

    osc.start(now);
    lfo.start(now);

    oscRef.current     = osc;
    lfoRef.current     = lfo;
    gainRef.current    = gain;
    lfoGainRef.current = lfoGain;
  }, [frequency, pulseRate, volume, fadeIn, getCtx]);

  const stop = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;

    const ctx = ctxRef.current;
    const gain = gainRef.current;
    const osc = oscRef.current;
    const lfo = lfoRef.current;

    if (!ctx || !gain || !osc || !lfo) return;

    const now = ctx.currentTime;

    // Fade out, then stop nodes
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeOut);

    const stopTime = now + fadeOut + 0.05;
    osc.stop(stopTime);
    lfo.stop(stopTime);

    // Clean up refs after stop
    setTimeout(() => {
      oscRef.current     = null;
      lfoRef.current     = null;
      gainRef.current    = null;
      lfoGainRef.current = null;
    }, (fadeOut + 0.1) * 1000);
  }, [fadeOut]);

  // Clean up AudioContext on unmount
  useEffect(() => {
    return () => {
      if (activeRef.current) {
        oscRef.current?.stop();
        lfoRef.current?.stop();
      }
      ctxRef.current?.close().catch(() => {});
    };
  }, []);

  return { start, stop, warmUp };
}
