# GLaDOS Voice PWA

A mobile-first Progressive Web App for voice interaction with [OpenClaw](https://github.com/openclaw/openclaw) AI assistants.

## Features

- 🎤 **Push-to-talk voice input** — Hold to record, release to send
- 🔊 **Text-to-speech responses** — Hear responses via Piper TTS
- ⌨️ **Text input fallback** — Type when voice isn't available
- 📝 **Markdown rendering** — Formatted responses with code blocks, lists, etc.
- 💾 **Conversation persistence** — History survives page reloads
- 📱 **Mobile-first design** — Optimized for iPhone/Android

## Architecture

```
┌─────────────────┐         ┌─────────────────────────────┐
│   Voice PWA     │ ◄─────► │   Voice API Server          │
│   (React)       │  HTTPS  │   (FastAPI)                 │
│                 │         │                             │
│   - Record      │         │   - Whisper STT             │
│   - Playback    │         │   - Piper TTS               │
│   - Chat UI     │         │   - OpenClaw integration    │
└─────────────────┘         └─────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- Voice API server running (see `voice-api/` in workspace)

### Development

```bash
npm install
npm run dev
```

### Configuration

Create `.env` file:

```env
VITE_API_URL=https://your-server:8444
```

### Production Build

```bash
npm run build
npm run preview
```

## HTTPS Setup

Voice recording requires HTTPS. Options:

1. **Tailscale + mkcert** — Generate local certs, proxy with Caddy
2. **Cloudflare Tunnel** — Public HTTPS without port forwarding
3. **Let's Encrypt** — For public domains

See the main OpenClaw docs for detailed setup.

## Browser Support

- ✅ Chrome (desktop & mobile)
- ✅ Safari (iOS 15+)
- ✅ Firefox
- ⚠️ Safari may block autoplay — tap 🔊 to play responses

## Related

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI assistant framework
- Voice API server (companion backend)

## License

MIT
