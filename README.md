# GLaDOS Voice PWA

A mobile-first Progressive Web App for voice interaction with [OpenClaw](https://github.com/openclaw/openclaw) AI assistants. Features real-time WebSocket streaming for low-latency voice conversations.

## Current Status

**Branch:** `streaming` (active development)  
**Last Updated:** 2026-02-07

### Working Features ✅
- Real-time WebSocket voice streaming
- Push-to-talk voice input with chunked audio upload
- Whisper STT (speech-to-text) transcription
- Piper TTS (text-to-speech) response playback
- Text input fallback
- Markdown response rendering
- Conversation history persistence (localStorage)
- Session restoration after app switch/disconnect
- Automatic reconnection with pending message delivery

### Known Limitations ⚠️
- React StrictMode disabled (causes double WebSocket connections in dev)
- Session restoration UI could be smoother
- No Web Push notifications yet (responses require app to be open)

## Repository Structure

```
├── src/                    # React PWA frontend
│   ├── hooks/
│   │   └── useVoiceStream.ts   # WebSocket streaming hook
│   ├── utils/
│   │   ├── audioQueue.ts       # Sequential audio playback
│   │   └── sessionPersistence.ts # localStorage session state
│   ├── components/
│   │   └── PushToTalkButton.tsx
│   └── App.tsx
├── backend/                # FastAPI voice server
│   ├── src/
│   │   ├── main.py             # FastAPI app, REST endpoints
│   │   ├── websocket.py        # WebSocket streaming handler
│   │   ├── session_store.py    # In-memory session persistence
│   │   ├── transcribe.py       # Whisper STT
│   │   └── stream_response.py  # OpenClaw integration
│   └── static/
│       └── test.html           # Standalone WebSocket test page
├── docs/
│   ├── STREAMING_SPEC.md       # Original streaming architecture
│   ├── IMPLEMENTATION_TASKS.md # Task breakdown for local LLM
│   └── PERSISTENT_SESSION_SPEC.md # Session restoration spec
└── README.md
```

## Architecture

```
┌─────────────────┐    WebSocket     ┌─────────────────────────────┐
│   Voice PWA     │ ◄──────────────► │   Voice API Server          │
│   (React)       │   wss://:8444    │   (FastAPI + Uvicorn)       │
│                 │                  │                             │
│ useVoiceStream  │                  │   websocket.py              │
│   - Connect     │  ←── ready ───   │   - Session management      │
│   - Record      │  ─── audio ───►  │   - Chunked transcription   │
│   - Display     │  ←── transcript  │   - OpenClaw streaming      │
│   - Playback    │  ←── response    │   - Piper TTS               │
└─────────────────┘                  └─────────────────────────────┘
        │                                       │
        │ HTTPS (:8443)                        │ HTTP (:8100)
        ▼                                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Caddy Reverse Proxy                         │
│   :8443 → localhost:5173 (Vite)                                │
│   :8444 → localhost:8100 (Backend)                             │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.12+
- [OpenClaw](https://github.com/openclaw/openclaw) running
- [Piper TTS](https://github.com/rhasspy/piper) installed
- Whisper (via `openai-whisper` pip package)
- Tailscale (for mobile access)
- mkcert + Caddy (for HTTPS)

### 1. Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Start the server
uvicorn src.main:app --host 0.0.0.0 --port 8100
```

### 2. Frontend Setup

```bash
npm install
npm run dev  # Development server on port 5173
```

### 3. HTTPS Proxy (Caddy)

Voice recording requires HTTPS. Example Caddyfile:

```caddyfile
https://your-hostname:8443 {
    tls /path/to/cert.pem /path/to/key.pem
    reverse_proxy localhost:5173
}

https://your-hostname:8444 {
    tls /path/to/cert.pem /path/to/key.pem
    reverse_proxy localhost:8100
}
```

### 4. Access

- **PWA:** `https://your-hostname:8443`
- **API:** `https://your-hostname:8444`
- **Test page:** `https://your-hostname:8444/test`

## WebSocket Protocol

### Client → Server

| Message | Description |
|---------|-------------|
| `{"type": "audio_start", "format": "webm"}` | Begin recording |
| `[binary data]` | Audio chunks (250ms intervals) |
| `{"type": "audio_end"}` | End recording, start transcription |
| `{"type": "text", "content": "..."}` | Text input |
| `{"type": "cancel"}` | Cancel current operation |

### Server → Client

| Message | Description |
|---------|-------------|
| `{"type": "ready", "session_id": "..."}` | Connection established |
| `{"type": "session_restored", "pending_messages": [...]}` | Reconnected with queued messages |
| `{"type": "partial_transcript", "text": "..."}` | Live transcription |
| `{"type": "final_transcript", "text": "..."}` | Completed transcription |
| `{"type": "response_chunk", "text": "...", "accumulated": "..."}` | Streaming response |
| `{"type": "response_complete", "text": "...", "audio_url": "..."}` | Final response + TTS |
| `{"type": "error", "code": "...", "message": "..."}` | Error occurred |

## Development

### Testing WebSocket

Use the standalone test page at `/test` to debug WebSocket issues independently of React:

```
https://your-hostname:8444/test
```

### Building for Production

```bash
npm run build
# Output in dist/
```

### Logs

```bash
tail -f /tmp/voice-backend.log  # Backend
tail -f /tmp/vite-pwa.log       # Frontend
tail -f /tmp/caddy.log          # Proxy
```

## Roadmap

See `docs/PERSISTENT_SESSION_SPEC.md` for planned features:

- [x] **Phase 1:** Session persistence & reconnection
- [ ] **Phase 2:** Multi-message replies (server can send follow-ups)
- [ ] **Phase 3:** Heartbeat/keepalive
- [ ] **Phase 4:** Web Push notifications (responses when app is closed)

## License

MIT

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — AI assistant framework
- [Piper](https://github.com/rhasspy/piper) — Fast local TTS
- [Whisper](https://github.com/openai/whisper) — Speech recognition
