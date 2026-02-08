import { useCallback, useRef, useEffect } from 'react';
import './PushToTalkButton.css';

interface Props {
  isRecording: boolean;
  onStartRecording: () => void;
  onStopRecording: () => void;
  disabled?: boolean;
}

export function PushToTalkButton({
  isRecording,
  onStartRecording,
  onStopRecording,
  disabled = false,
}: Props) {
  const isRecordingRef = useRef(false);

  const handleStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (disabled) return;
    e.preventDefault();
    if (!isRecordingRef.current) {
      isRecordingRef.current = true;
      onStartRecording();
    }
  }, [disabled, onStartRecording]);

  // Use document-level listeners to catch mouseup/touchend anywhere on screen
  // This fixes the bug where moving mouse outside button would stop recording
  useEffect(() => {
    const handleGlobalEnd = () => {
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
