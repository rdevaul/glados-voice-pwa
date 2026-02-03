# Task: Generate FastAPI Voice Server

## Context
Building a voice API server for a mobile voice assistant. The server handles:
- Speech-to-text (STT) via Whisper CLI
- Text-to-speech (TTS) via Piper CLI  
- Chat integration with OpenClaw (via CLI)

## Requirements

Create `src/main.py` with these endpoints:

### POST /voice/transcribe
- Accepts: multipart/form-data with audio file (field name: "audio")
- Supported formats: wav, webm, mp3, m4a
- Saves to temp file, runs Whisper, returns transcription
- Response: `{"text": "transcribed text"}`

### POST /voice/speak  
- Accepts: JSON `{"text": "text to speak"}`
- Runs Piper TTS, saves WAV to audio_cache/
- Response: `{"audio_url": "/voice/audio/{id}.wav"}`

### POST /voice/chat
- Accepts: JSON `{"text": "user message"}` OR multipart audio
- If audio: transcribe first
- Sends message to OpenClaw via: `openclaw gateway wake --text "MESSAGE" --mode now`
- For MVP: return placeholder response (real integration later)
- Generates TTS for response
- Response: `{"text": "response", "audio_url": "/voice/audio/{id}.wav"}`

### GET /voice/audio/{filename}
- Serves WAV files from audio_cache/
- Returns audio/wav content-type

## External Commands

Whisper (STT):
```bash
whisper {input_file} --model base --output_format txt --output_dir {tmp_dir}
```

Piper (TTS):
```bash
eval "$(pyenv init -)" && echo "{text}" | piper -m /Users/rich/Projects/piper-models/en_US-lessac-medium.onnx -f {output_file}
```

## Code Style
- Use async/await throughout
- Type hints on all functions
- Use pathlib for file paths
- Use uuid4 for audio file IDs
- Create audio_cache directory on startup if missing
- Clean error handling with HTTPException

## Do NOT include
- Authentication (Tailscale handles this)
- Streaming/WebSocket (future version)
- Database (not needed for MVP)
