# GLaDOS Voice API

FastAPI server providing voice endpoints for the mobile voice interface.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/voice/transcribe` | POST | Upload audio, get text (Whisper STT) |
| `/voice/speak` | POST | Send text, get audio URL (Piper TTS) |
| `/voice/chat` | POST | Chat with text or audio, get response + audio |
| `/voice/audio/{filename}` | GET | Download generated audio files |

## Quick Start

```bash
./run.sh
```

Server runs on `http://0.0.0.0:8100`

## API Examples

### Transcribe Audio
```bash
curl -X POST http://localhost:8100/voice/transcribe \
  -F "file=@recording.wav"
```

### Text to Speech
```bash
curl -X POST http://localhost:8100/voice/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, this is GLaDOS speaking."}'
```

### Chat
```bash
# With text
curl -X POST http://localhost:8100/voice/chat \
  -H "Content-Type: application/json" \
  -d '{"text": "What is on my calendar today?"}'

# With audio
curl -X POST http://localhost:8100/voice/chat \
  -F "file=@question.wav"
```

### Download Audio
```bash
curl http://localhost:8100/voice/audio/{audio_id}.wav -o response.wav
```

## Configuration

- **Port:** 8100
- **Whisper model:** base (can change in main.py)
- **Piper voice:** en_US-lessac-medium

## Dependencies

- Python 3.12+ (via pyenv)
- Whisper CLI
- Piper TTS
- FastAPI + Uvicorn

## Status

MVP - Basic endpoints working. OpenClaw integration pending.
