/**
 * useThinkingTone — Ambient audio feedback during processing.
 *
 * Shares the AudioContext unlocked by AudioQueue.warmUp(), so both
 * response audio and the thinking tone use the same unlocked context.
 * This avoids Chrome's autoplay restriction (which only blocks new
 * AudioContexts, not nodes added to an already-running context).
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
    frequency = 180,
    pulseRate = 0.4,
    volume    = 0.22,
    fadeIn    = 0.4,
    fadeOut   = 0.6,
  } = options;

  const gainRef   = useRef<GainNode | null>(null);
  const readyRef  = useRef(false);
  const activeRef = useRef(false);

  /**
   * warmUp — call on button press. Builds the tone graph using the
   * AudioContext that AudioQueue just unlocked in the same gesture.
   */
  const warmUp = useCallback(() => {
    if (readyRef.current) return;

    // Give AudioQueue's warmUp a moment to unlock the context
    // (both are called synchronously in handleStartRecording, but
    // AudioQueue's unlock is async internally via resumePromise)
    const tryBuild = (attempt: number) => {
      const ctx = getAudioQueue().getContext();
      if (!ctx) {
        if (attempt < 10) {
          setTimeout(() => tryBuild(attempt + 1), 100);
        } else {
          console.warn('[ThinkingTone] AudioContext never became available');
        }
        return;
      }

      if (readyRef.current) return; // already built by a parallel attempt
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
    };

    tryBuild(0);
  }, [frequency, pulseRate, volume]);

  const start = useCallback(() => {
    console.log('[ThinkingTone] start() — ready:', readyRef.current, 'active:', activeRef.current);
    if (!readyRef.current || activeRef.current) return;
    activeRef.current = true;

    const ctx = getAudioQueue().getContext();
    const gain = gainRef.current;
    if (!ctx || !gain) return;

    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
  }, [volume, fadeIn]);

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

  useEffect(() => {
    return () => {
      // Don't close the shared AudioContext — AudioQueue owns it
      readyRef.current = false;
      activeRef.current = false;
      gainRef.current = null;
    };
  }, []);

  return { warmUp, start, stop };
}
