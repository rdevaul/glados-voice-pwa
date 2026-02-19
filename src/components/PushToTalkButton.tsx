import { useCallback, useRef, useEffect } from 'react';
import './PushToTalkButton.css';

interface Props {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  disabled?: boolean;
}

// Debounce time to prevent rapid re-triggering (ms)
const DEBOUNCE_MS = 300;

export function PushToTalkButton({
  isRecording,
  onStartRecording,
  onStopRecording,
  disabled = false,
}: Props) {
  const isRecordingRef = useRef(false);
  const lastStartTimeRef = useRef(0);
  const isTouchDeviceRef = useRef(false);

  const handleStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (disabled) return;
    e.preventDefault();
    
    // Track if this is a touch device to prevent mouse events from also firing
    if (e.type === 'touchstart') {
      isTouchDeviceRef.current = true;
    } else if (e.type === 'mousedown' && isTouchDeviceRef.current) {
      // Ignore mousedown on touch devices (touchstart already handled it)
      return;
    }
    
    // Debounce rapid taps
    const now = Date.now();
    if (now - lastStartTimeRef.current < DEBOUNCE_MS) {
      console.warn('Recording start debounced');
      return;
    }
    
    if (!isRecordingRef.current) {
      isRecordingRef.current = true;
      lastStartTimeRef.current = now;
      onStartRecording();
    }
  }, [disabled, onStartRecording]);

  // Use document-level listeners to catch mouseup/touchend anywhere on screen
  // This fixes the bug where moving mouse outside button would stop recording
  useEffect(() => {
    const handleGlobalEnd = (e: MouseEvent | TouchEvent) => {
      // On touch devices, ignore mouseup (touchend handles it)
      if (e.type === 'mouseup' && isTouchDeviceRef.current) {
        return;
      }
      
      if (isRecordingRef.current) {
        isRecordingRef.current = false;
        onStopRecording();
      }
    };

    document.addEventListener('mouseup', handleGlobalEnd);
    document.addEventListener('touchend', handleGlobalEnd);

    return () => {
      document.removeEventListener('mouseup', handleGlobalEnd);
      document.removeEventListener('touchend', handleGlobalEnd);
    };
  }, [onStopRecording]);
  
  // Reset touch device detection on component unmount (edge case)
  useEffect(() => {
    return () => {
      isTouchDeviceRef.current = false;
    };
  }, []);

  return (
    <button
      className={`ptt-button ${isRecording ? 'recording' : ''} ${disabled ? 'disabled' : ''}`}
      onMouseDown={handleStart}
      onTouchStart={handleStart}
      disabled={disabled}
    >
      <div className="ptt-icon">🎤</div>
      <div className="ptt-label">
        {disabled ? 'Processing...' : isRecording ? 'Release to send' : 'Hold to talk'}
      </div>
    </button>
  );
}
