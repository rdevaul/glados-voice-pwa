# Project Status

**Last Updated:** 2026-02-07  
**Branch:** `streaming`

## Overview

The GLaDOS Voice PWA provides a mobile-first voice interface for OpenClaw. It uses WebSocket streaming for real-time voice conversations with low latency.

## Completed Work

### Phase 1-3: Core Streaming (Complete ✅)

- **WebSocket Infrastructure** (`backend/src/websocket.py`)
  - Full-duplex WebSocket communication
  - Binary audio chunk streaming
  - JSON message protocol for control messages
  
- **Chunked Transcription** (`backend/src/transcribe.py`)
  - Whisper-based speech-to-text
  - Handles webm/mp4 audio formats
  
- **Response Streaming** (`backend/src/stream_response.py`)
  - OpenClaw integration via CLI
  - Chunk-by-chunk response delivery
  
- **TTS Integration** (`backend/src/main.py`)
  - Piper TTS for response audio
  - Audio file caching and serving

- **Frontend Hook** (`src/hooks/useVoiceStream.ts`)
  - React hook for WebSocket management
  - MediaRecorder integration for voice capture
  - State management for transcripts/responses

- **PWA Integration** (`src/App.tsx`)
  - Push-to-talk UI
  - Streaming response display
  - Audio playback queue

### Phase 4: Session Persistence (Complete ✅)

- **Backend Session Store** (`backend/src/session_store.py`)
  - In-memory session storage with TTL
  - Pending message queue for disconnected clients
  - Automatic stale session cleanup

- **Session Restoration** (`backend/src/websocket.py`)
  - `?session_id=xxx` query param for reconnection
  - `session_restored` message with pending messages
  - Seamless handoff when client returns

- **Frontend Persistence** (`src/utils/sessionPersistence.ts`)
  - localStorage session state
  - Visibility API handling for app switches
  - Automatic reconnection on return

## Bug Fixes (2026-02-07)

| Issue | Root Cause | Fix |
|-------|------------|-----|
| WebSocket instant disconnect | Cleanup effect had `[saveState]` dependency, ran on every state change | Empty deps array `[]` |
| Restored messages not displaying | No assistant message placeholder on restore | Create message if none exists |
| Error banner persisting | Error state not cleared on successful connect | Added `setError(null)` in ready/session_restored handlers |
| React double-render | StrictMode double-invokes effects | Disabled StrictMode in dev |

## Remaining Work

### Phase 5: Multi-Message Replies (Not Started)

Allow server to send multiple messages per interaction (follow-ups, corrections):

- [ ] `server_message` type handling in frontend
- [ ] UI for displaying follow-up messages
- [ ] TTS queuing for multiple audio responses

### Phase 6: Heartbeat/Keepalive (Not Started)

Detect and handle zombie connections:

- [ ] Client ping every 30s
- [ ] Server pong with session state
- [ ] Reconnect on missed pongs

### Phase 7: Web Push Notifications (Not Started)

Proactive messaging when PWA is closed:

- [ ] Service worker registration
- [ ] VAPID key generation
- [ ] Push subscription flow
- [ ] Backend notification dispatch

## Known Issues

1. **React StrictMode disabled** — Causes double WebSocket connections in dev. Can be re-enabled once effect dependencies are properly managed.

2. **Session ID in URL** — Currently uses query params for session restoration. Could leak session ID in logs/referrer headers.

3. **No offline support** — PWA requires network connection. Could add service worker for offline queue.

## File Reference

### Backend (`backend/src/`)

| File | Purpose |
|------|---------|
| `main.py` | FastAPI app, REST endpoints, TTS |
| `websocket.py` | WebSocket handler, session management |
| `session_store.py` | In-memory session persistence |
| `transcribe.py` | Whisper STT integration |
| `stream_response.py` | OpenClaw CLI integration |

### Frontend (`src/`)

| File | Purpose |
|------|---------|
| `App.tsx` | Main component, message display |
| `hooks/useVoiceStream.ts` | WebSocket streaming hook |
| `hooks/useVoiceRecorder.ts` | Batch mode recording (legacy) |
| `utils/audioQueue.ts` | Sequential audio playback |
| `utils/sessionPersistence.ts` | localStorage session state |
| `components/PushToTalkButton.tsx` | Voice input button |

### Configuration

| File | Purpose |
|------|---------|
| `~/.openclaw/certs/Caddyfile` | HTTPS proxy config |
| `backend/requirements.txt` | Python dependencies |
| `package.json` | Node dependencies |
| `vite.config.ts` | Vite build config |

## Service Startup

```bash
# Backend
cd ~/Projects/glados-voice-pwa/backend
source .venv/bin/activate
uvicorn src.main:app --host 0.0.0.0 --port 8100

# Frontend (dev)
cd ~/Projects/glados-voice-pwa
npm run dev

# Caddy proxy
caddy run --config ~/.openclaw/certs/Caddyfile
```

## Testing

- **Test page:** `https://glados.tailad67af.ts.net:8444/test`
- **PWA:** `https://glados.tailad67af.ts.net:8443`
- **Health check:** `curl http://localhost:8100/health`
