# Task: Voice PWA Components

## Context
Building a mobile-first voice interface PWA for GLaDOS. React + TypeScript + Vite.

## Requirements

### 1. src/hooks/useVoiceRecorder.ts
Custom hook for audio recording:
- Uses MediaRecorder API
- Returns: { isRecording, startRecording, stopRecording, audioBlob }
- Supports webm/opus format
- Handles permissions

### 2. src/hooks/useAudioPlayer.ts  
Custom hook for audio playback:
- Plays audio from URL or Blob
- Returns: { isPlaying, play, stop, currentUrl }
- Uses HTML5 Audio

### 3. src/components/PushToTalkButton.tsx
Large, thumb-friendly button:
- Hold to record (touch/mouse)
- Visual feedback (pulsing animation when recording)
- Disabled state while processing
- Props: onRecordingComplete(blob: Blob), disabled: boolean

### 4. src/api/voiceApi.ts
API client for voice server:
```typescript
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8100';

export async function chatWithText(text: string): Promise<{text: string, audio_url: string}>
export async function chatWithAudio(audioBlob: Blob): Promise<{text: string, audio_url: string}>
export function getAudioUrl(path: string): string
```

### 5. src/App.tsx
Main app layout:
- Header with title
- Chat history (scrollable)
- Push-to-talk button (large, centered at bottom)
- Text input fallback (small, below button)
- Settings gear icon (placeholder)

## Style Guidelines
- Mobile-first (works well on iPhone)
- Dark theme
- Large touch targets (min 48px)
- Simple, clean UI

## Do NOT include
- Complex state management (useState is fine)
- Routing
- Backend code
