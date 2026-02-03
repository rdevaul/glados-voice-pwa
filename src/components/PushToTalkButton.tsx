import { useCallback, useRef } from 'react';
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
  const wasRecordingRef = useRef(false);

  const handleStart = useCallback(() => {
    if (disabled) return;
    wasRecordingRef.current = true;
    onStartRecording();
  }, [disabled, onStartRecording]);

  const handleEnd = useCallback(() => {
    if (wasRecordingRef.current) {
      wasRecordingRef.current = false;
      onStopRecording();
    }
  }, [onStopRecording]);

  return (
    <button
      className={`ptt-button ${isRecording ? 'recording' : ''} ${disabled ? 'disabled' : ''}`}
      onMouseDown={handleStart}
      onMouseUp={handleEnd}
      onMouseLeave={handleEnd}
      onTouchStart={handleStart}
      onTouchEnd={handleEnd}
      disabled={disabled}
    >
      <div className="ptt-icon">🎤</div>
      <div className="ptt-label">
        {disabled ? 'Processing...' : isRecording ? 'Release to send' : 'Hold to talk'}
      </div>
    </button>
  );
}
