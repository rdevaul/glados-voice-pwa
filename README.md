# GLaDOS Voice PWA

A mobile-first Progressive Web App for voice interaction with [OpenClaw](https://github.com/openclaw/openclaw) AI assistants. Features real-time WebSocket streaming, async message queuing, and optional Telegram notifications for mobile alerts.

## Current Status

**Branch:** `streaming` (active development)  
**Last Updated:** 2026-02-14

### Features ✅

- **Async Voice Model** — Record multiple messages without waiting for responses (Telegram-style UX)
- **Real-time WebSocket Streaming** — Low-latency voice conversations
- **Push-to-talk** — Chunked audio upload with live transcription
- **Dual TTS Support** — OpenAI TTS (primary) with Piper fallback
- **Telegram Notifications** — Get notified when responses arrive (even when PWA is backgrounded)
- **Progress Updates** — Visual feedback during long-running requests
- **Media Rendering** — Images, videos, and audio displayed inline in chat
- **Text Input Fallback** — Type when voice isn't convenient
- **Session Persistence** — Conversation survives app switches and reconnects
- **Markdown Support** — Rich text rendering with GFM tables, code blocks, etc.

### Browser Support

| Browser | Status | Notes |
|---------|--------|-------|
| Chrome (Android/iOS) | ✅ Full support | Recommended |
| Safari (iOS) | ⚠️ Limited | WebSocket issues with self-signed certs |
| Firefox | ✅ Works | Not extensively tested |

> **Note:** For best results on mobile, use Chrome. Safari has known issues with WebSocket connections when using mkcert self-signed certificates.

## Architecture

```
┌─────────────────┐    WebSocket     ┌─────────────────────────────┐
│   Voice PWA     │ ◄──────────────► │   Voice API Server          │
│   (React)       │   wss://:8444    │   (FastAPI + Uvicorn)       │
│                 │                  │                             │
│ Async Queue     │                  │   websocket.py              │
│ ┌───┬───┬───┐   │  ←── ready ───   │   - Session management      │
│ │ 1 │ 2 │ 3 │   │  ─── audio ───►  │   - Whisper STT             │
│ └───┴───┴───┘   │  ←── transcript  │   - OpenClaw routing        │
│ (in-flight)     │  ←── response    │   - OpenAI/Piper TTS        │
└─────────────────┘  ←── telegram    └───────────┬─────────────────┘
        │                                        │
        │ HTTPS (:8443)                          │ Telegram Bot API
        ▼                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Caddy Reverse Proxy                         │
│   :8443 → localhost:5173 (Vite PWA)                            │
│   :8444 → localhost:8100 (Voice Backend)                       │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Python 3.12+
- [OpenClaw](https://github.com/openclaw/openclaw) running locally
- Whisper (`openai-whisper` pip package)
- Tailscale (for mobile access)
- mkcert + Caddy (for HTTPS)

Optional:
- OpenAI API key (for high-quality TTS)
- Telegram Bot token (for notification CC)
- [Piper TTS](https://github.com/rhasspy/piper) (fallback TTS)

### 1. Backend Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure environment (see Environment Variables below)
export OPENAI_API_KEY="sk-..."           # Optional: enables OpenAI TTS
export TELEGRAM_BOT_TOKEN="123:ABC..."   # Optional: enables notifications
export TELEGRAM_NOTIFY_CHAT_ID="12345"   # Your Telegram user ID

# Start the server
uvicorn src.main:app --host 0.0.0.0 --port 8100
```

### 2. Frontend Setup

```bash
# Copy example env and customize
cp .env.example .env
# Edit .env with your hostnames

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

## Environment Variables

### Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | No | — | Enables OpenAI TTS (falls back to Piper) |
| `OPENAI_TTS_VOICE` | No | `nova` | Voice: nova, alloy, echo, fable, onyx, shimmer |
| `OPENAI_TTS_MODEL` | No | `tts-1` | Model: tts-1 (fast) or tts-1-hd (quality) |
| `TELEGRAM_BOT_TOKEN` | No | — | Enables Telegram notification CC |
| `TELEGRAM_NOTIFY_CHAT_ID` | No | — | Telegram user/chat ID for notifications |

### Frontend (.env)

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend URL (e.g., `https://host:8444`) |
| `VITE_WS_URL` | WebSocket URL (e.g., `wss://host:8444/voice/stream`) |
| `VITE_STREAMING_ENABLED` | Enable streaming mode (`true`) |

## WebSocket Protocol

### Client → Server

| Message | Description |
|---------|-------------|
| `{"type": "audio_start", "format": "webm"}` | Begin recording |
| `[binary data]` | Audio chunks (250ms intervals) |
| `{"type": "audio_end"}` | End recording, start transcription |
| `{"type": "text", "content": "..."}` | Text input (no STT) |
| `{"type": "cancel"}` | Cancel current operation |
| `{"type": "ping"}` | Keepalive check |

### Server → Client

| Message | Description |
|---------|-------------|
| `{"type": "ready", "session_id": "..."}` | Connection established |
| `{"type": "session_restored", ...}` | Reconnected with state |
| `{"type": "partial_transcript", "text": "..."}` | Live transcription |
| `{"type": "final_transcript", "text": "..."}` | Completed transcription |
| `{"type": "processing_status", "message": "...", "elapsed_seconds": N}` | Progress update |
| `{"type": "response_complete", "text": "...", "audio_url": "...", "media_url": "..."}` | Response + TTS |
| `{"type": "server_message", ...}` | Additional/follow-up message |
| `{"type": "pong"}` | Keepalive response |
| `{"type": "error", "code": "...", "message": "..."}` | Error |

## Repository Structure

```
├── src/                    # React PWA frontend
│   ├── hooks/
│   │   └── useVoiceStream.ts   # WebSocket streaming + async queue
│   ├── components/
│   │   └── PushToTalkButton.tsx
│   └── App.tsx                 # Main app + message rendering
├── backend/                # FastAPI voice server
│   ├── src/
│   │   ├── main.py             # FastAPI app, REST endpoints
│   │   ├── websocket.py        # WebSocket handler, TTS, notifications
│   │   ├── session_store.py    # In-memory session persistence
│   │   ├── transcribe.py       # Whisper STT
│   │   ├── stream_response.py  # OpenClaw integration
│   │   └── utils.py            # Markdown stripping for TTS
│   └── static/
│       └── test.html           # Standalone WebSocket test page
├── docs/                   # Design documents
└── .env.example            # Frontend environment template
```

## Development

### Testing WebSocket

Use the standalone test page to debug WebSocket issues:

```
https://your-hostname:8444/test
```

### Running as a Service (macOS)

Create a launchd plist at `~/Library/LaunchAgents/com.glados.voice-backend.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.glados.voice-backend</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/backend/.venv/bin/uvicorn</string>
        <string>src.main:app</string>
        <string>--host</string>
        <string>0.0.0.0</string>
        <string>--port</string>
        <string>8100</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/glados-voice-pwa/backend</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENAI_API_KEY</key>
        <string>sk-...</string>
        <!-- Add other env vars here -->
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/voice-backend.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/voice-backend.log</string>
</dict>
</plist>
```

Load with: `launchctl load ~/Library/LaunchAgents/com.glados.voice-backend.plist`

### Building for Production

```bash
npm run build
# Output in dist/
```

### Logs

```bash
tail -f /tmp/voice-backend.log  # Backend
```

## Roadmap

- [x] Session persistence & reconnection
- [x] Async message queuing (multiple in-flight)
- [x] OpenAI TTS integration
- [x] Telegram notification CC
- [x] Progress updates for long requests
- [x] Media rendering (images/video)
- [ ] Web Push notifications (full offline support)
- [ ] Barge-in (interrupt response playback)
- [ ] Voice activity detection (VAD)

## License

MIT

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — AI assistant framework
- [Piper](https://github.com/rhasspy/piper) — Fast local TTS
- [Whisper](https://github.com/openai/whisper) — Speech recognition
