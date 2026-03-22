/**
 * useThinkingTone — Ambient audio feedback during processing.
 *
 * Shares the AudioContext unlocked by AudioQueue.warmUp(), so both
 * response audio and the thinking tone use the same unlocked context.
 * This avoids Chrome's autoplay restriction (which only blocks new
 * AudioContexts, not nodes added to an already-running context).
 *
 * The tone graph is built on-demand during the first start() call.
 * start() ramps up from keepalive volume (0.02) to thinking volume (0.45).
 * stop() ramps back down to 0 (keepalive in audioQueue handles the rest).
 */

import { useRef, useCallback, useEffect } from 'react';
import { getAudioQueue } from '../utils/audioQueue';

interface ThinkingToneOptions {
  frequency?: number;
  pulseRate?: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export function useThinkingTone(options: ThinkingToneOptions = {}) {
  const {
    frequency = 440,
    pulseRate = 0.5,
    volume    = 0.45,
    fadeIn    = 0.3,
    fadeOut   = 0.5,
  } = options;

  const gainRef   = useRef<GainNode | null>(null);
  const readyRef  = useRef(false);
  const activeRef = useRef(false);

  /**
   * Build the tone graph on first start() call.
   */
  const buildToneGraph = useCallback(() => {
    if (readyRef.current) return;

    const ctx = getAudioQueue().getContext();
    if (!ctx) {
      console.warn('[ThinkingTone] AudioContext not available');
      return;
    }

    console.log('[ThinkingTone] building tone graph on shared AudioContext');

    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(pulseRate, now);

    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(volume * 0.4, now);

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0, now); // silent until start()

    osc.connect(masterGain);
    lfo.connect(lfoGain);
    lfoGain.connect(masterGain.gain);
    masterGain.connect(ctx.destination);

    osc.start(now);
    lfo.start(now);

    gainRef.current = masterGain;
    readyRef.current = true;
    console.log('[ThinkingTone] ready');
  }, [frequency, pulseRate, volume]);

  const start = useCallback(() => {
    console.log('[ThinkingTone] start() — ready:', readyRef.current, 'active:', activeRef.current);

    // Build tone graph on first start() call
    if (!readyRef.current) {
      buildToneGraph();
    }

    // If build failed or already active, bail
    if (!readyRef.current || activeRef.current) return;

    const ctx = getAudioQueue().getContext();
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    // Don't start if context is suspended — on iOS the gain ramp would execute
    // silently and then ghost-activate when the context finally runs later.
    if (ctx.state === 'suspended') {
      console.log('[ThinkingTone] start() — context suspended, skipping to avoid ghost-activation');
      return;
    }

    activeRef.current = true;

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
  }, [volume, fadeIn, buildToneGraph]);

  const stop = useCallback(() => {
    if (!readyRef.current || !activeRef.current) return;
    activeRef.current = false;

    const ctx = getAudioQueue().getContext();
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fadeOut);
  }, [fadeOut]);

  /**
   * Instantly silence the thinking tone — no fade ramp.
   * Use this when TTS audio starts playing to avoid overlap.
   * (stop() has a 0.5s fade which causes audible bleed-through into TTS.)
   */
  const kill = useCallback(() => {
    if (!readyRef.current) return;
    activeRef.current = false;

    const ctx = getAudioQueue().getContext();
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0, now);
    console.log('[ThinkingTone] kill() — instant silence');
  }, []);

  useEffect(() => {
    return () => {
      // Don't close the shared AudioContext — AudioQueue owns it
      readyRef.current = false;
      activeRef.current = false;
      gainRef.current = null;
    };
  }, []);

  return { start, stop, kill };
}
