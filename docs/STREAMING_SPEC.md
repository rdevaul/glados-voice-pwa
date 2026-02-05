# Streaming Voice Interface Specification

**Version:** 0.2.0-streaming  
**Author:** GLaDOS  
**Date:** 2026-02-05  
**Branch:** `streaming`

---

## Executive Summary

This document specifies the architecture for upgrading the GLaDOS Voice PWA from batch processing to real-time streaming. The goal is to reduce perceived latency by streaming audio, transcription, and responses incrementally rather than waiting for complete processing.

### Current Batch Flow (v0.1.0)
```
User speaks (3s) → Upload (1s) → Transcribe (2s) → OpenClaw (5-30s) → TTS (1s) → Download (1s)
Total: 13-38 seconds before user hears anything
```

### Target Streaming Flow (v0.2.0)
```
User speaks → Audio streams up → Partial transcription shows → 
Response streams in real-time → Audio plays as chunks arrive
Total: ~1-2s to first visible feedback, audio begins as soon as first chunk ready
```

---

## Architecture Overview

### Transport: WebSocket

We'll use WebSocket for full-duplex communication:
- **Upstream:** Audio chunks (binary frames)
- **Downstream:** JSON messages (transcription, response text, audio URLs/chunks)

SSE was considered but rejected because:
1. Can't send binary audio upstream
2. Would require separate upload endpoint + SSE response stream
3. WebSocket provides cleaner bidirectional model

### Protocol

```
┌─────────────┐                         ┌─────────────────────────────┐
│  PWA Client │◄═══════ WebSocket ═════►│  Voice API Server           │
│             │                         │                             │
│  Audio In ──┼── binary frames ───────►│── Whisper (streaming) ──┐   │
│             │                         │                         │   │
│  UI Update ◄┼── {"type":"partial_    │◄─────────────────────────┘   │
│             │    transcript",...}     │                             │
│             │                         │── OpenClaw (stream) ────┐   │
│  UI Update ◄┼── {"type":"response_   │◄─────────────────────────┘   │
│             │    chunk",...}          │                             │
│             │                         │── Piper TTS ────────────┐   │
│  Audio Out ◄┼── {"type":"audio_      │◄─────────────────────────┘   │
│             │    ready",...}          │                             │
└─────────────┘                         └─────────────────────────────┘
```

---

## Backend Specification

### 1. WebSocket Endpoint

**Path:** `ws://host:port/voice/stream`

**Connection lifecycle:**
1. Client connects
2. Server sends `{"type": "ready"}`
3. Client can send audio or text
4. Server streams responses
5. Either side can close

### 2. Client → Server Messages

#### Audio Start
```json
{
  "type": "audio_start",
  "format": "webm",          // "webm" | "wav" | "mp4"
  "sampleRate": 48000,       // optional, for wav
  "channels": 1              // optional
}
```

#### Audio Chunk (Binary)
Raw binary frame containing audio data. Sent after `audio_start`.

#### Audio End
```json
{
  "type": "audio_end"
}
```

#### Text Input
```json
{
  "type": "text",
  "content": "user message here"
}
```

#### Cancel
```json
{
  "type": "cancel"
}
```

### 3. Server → Client Messages

#### Ready
```json
{
  "type": "ready",
  "session_id": "voice"
}
```

#### Partial Transcript
Sent as Whisper processes audio chunks:
```json
{
  "type": "partial_transcript",
  "text": "Hello, how are",
  "is_final": false
}
```

#### Final Transcript
```json
{
  "type": "final_transcript", 
  "text": "Hello, how are you today?"
}
```

#### Response Chunk
Streamed as OpenClaw generates response:
```json
{
  "type": "response_chunk",
  "text": "I'm doing",
  "accumulated": "I'm doing"      // full text so far
}
```

#### Response Complete
```json
{
  "type": "response_complete",
  "text": "I'm doing well, thank you for asking!",
  "audio_url": "/voice/audio/abc123.wav"
}
```

#### Audio Ready
For chunked audio streaming (optional, for true streaming TTS):
```json
{
  "type": "audio_chunk",
  "index": 0,
  "url": "/voice/audio/abc123_chunk0.wav",
  "is_final": false
}
```

#### Error
```json
{
  "type": "error",
  "code": "TRANSCRIPTION_FAILED",
  "message": "Whisper encountered an error"
}
```

### 4. Streaming Transcription Strategy

**Challenge:** OpenAI Whisper doesn't natively support streaming.

**Solution Options (in order of preference):**

#### Option A: whisper.cpp with stream mode
```bash
# whisper.cpp supports real-time transcription
./stream -m models/base.en.bin --step 500 --length 5000
```
- Requires building whisper.cpp with stream support
- Best latency (~500ms to first partial)
- Install: `brew install whisper-cpp` or build from source

#### Option B: Chunked Whisper with Overlap
- Buffer audio in 3-second chunks with 0.5s overlap
- Run Whisper on each chunk
- Merge results, deduplicate overlapping text
- Latency: ~3s to first partial

#### Option C: faster-whisper with VAD
```python
from faster_whisper import WhisperModel
model = WhisperModel("base", compute_type="int8")
segments, info = model.transcribe(audio, vad_filter=True)
for segment in segments:
    yield segment.text  # Stream segments as they complete
```
- Good balance of speed and accuracy
- Install: `pip install faster-whisper`

**Recommendation:** Start with Option B (simplest), migrate to Option A for production.

### 5. OpenClaw Streaming

OpenClaw CLI doesn't support streaming output, but we can:

#### Option A: HTTP Streaming via Gateway API
```python
async def stream_openclaw(text: str):
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://localhost:4747/api/agent/stream",
            json={"message": text, "sessionId": "voice"}
        ) as resp:
            async for line in resp.content:
                yield json.loads(line)
```

#### Option B: Direct Anthropic API (bypass OpenClaw for streaming)
```python
import anthropic
client = anthropic.Anthropic()
with client.messages.stream(...) as stream:
    for text in stream.text_stream:
        yield text
```

**Recommendation:** Check if OpenClaw gateway exposes streaming endpoint; otherwise use direct API with session context injection.

### 6. TTS Streaming

**Challenge:** Piper generates complete audio files, not streams.

**Solutions:**

#### Option A: Sentence-level chunking
1. Buffer response text until sentence boundary (`.`, `!`, `?`)
2. Generate TTS for each sentence
3. Send audio URL immediately when ready
4. Client queues and plays sequentially

#### Option B: Streaming TTS (requires different engine)
- Coqui TTS with streaming
- ElevenLabs streaming API
- Edge-TTS with chunked output

**Recommendation:** Start with Option A (sentence chunking) - works with existing Piper.

---

## Frontend Specification

### 1. WebSocket Hook

```typescript
// src/hooks/useVoiceStream.ts

interface StreamState {
  status: 'disconnected' | 'connecting' | 'ready' | 'recording' | 'processing';
  partialTranscript: string;
  finalTranscript: string;
  responseText: string;
  audioQueue: string[];
  error: string | null;
}

interface UseVoiceStreamReturn extends StreamState {
  connect: () => void;
  disconnect: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  sendText: (text: string) => void;
  cancel: () => void;
}

export function useVoiceStream(): UseVoiceStreamReturn;
```

### 2. Audio Streaming Upload

```typescript
// During recording, stream chunks to server
mediaRecorder.ondataavailable = (e) => {
  if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(e.data);  // Binary frame
  }
};
```

### 3. Progressive UI Updates

```typescript
// Message component shows partial content
interface StreamingMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isStreaming: boolean;  // Show typing indicator
  audioUrls: string[];   // Queue of audio chunks
}
```

### 4. Audio Queue Playback

```typescript
// Play audio chunks in sequence
class AudioQueue {
  private queue: string[] = [];
  private playing: boolean = false;
  private audio: HTMLAudioElement;

  enqueue(url: string) {
    this.queue.push(url);
    if (!this.playing) this.playNext();
  }

  private playNext() {
    if (this.queue.length === 0) {
      this.playing = false;
      return;
    }
    this.playing = true;
    this.audio.src = this.queue.shift()!;
    this.audio.play();
    this.audio.onended = () => this.playNext();
  }
}
```

### 5. Reconnection Logic

```typescript
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

function useWebSocketWithReconnect(url: string) {
  // Exponential backoff with max retries
  // Reset delay counter on successful message
}
```

---

## Implementation Plan

### Phase 1: WebSocket Infrastructure (Days 1-2)
- [ ] Add `websockets` to backend requirements
- [ ] Create `/voice/stream` WebSocket endpoint  
- [ ] Implement message protocol (parsing, validation)
- [ ] Add `useVoiceStream` hook to frontend
- [ ] Basic connect/disconnect/reconnect logic

### Phase 2: Streaming Transcription (Days 3-4)
- [ ] Implement chunked Whisper (Option B)
- [ ] Send partial transcripts via WebSocket
- [ ] Display partial transcript in UI
- [ ] Handle audio chunk buffering

### Phase 3: Response Streaming (Days 5-6)
- [ ] Research OpenClaw streaming capability
- [ ] Implement response text streaming
- [ ] Progressive response display in UI
- [ ] Typing indicator during streaming

### Phase 4: TTS Streaming (Days 7-8)
- [ ] Implement sentence-level TTS chunking
- [ ] Audio queue in frontend
- [ ] Seamless chunk playback
- [ ] Handle playback errors gracefully

### Phase 5: Polish & Testing (Days 9-10)
- [ ] Error handling & recovery
- [ ] Connection state indicators
- [ ] Mobile testing (iOS Safari, Android Chrome)
- [ ] Performance profiling
- [ ] Documentation update

---

## File Structure

```
streaming branch additions:

backend/
├── src/
│   ├── main.py              # Add WebSocket routes
│   ├── websocket.py         # NEW: WebSocket handler
│   ├── transcribe.py        # NEW: Streaming transcription
│   ├── stream_response.py   # NEW: OpenClaw streaming
│   └── tts_chunked.py       # NEW: Sentence-level TTS
└── requirements.txt         # Add: websockets, faster-whisper

src/
├── hooks/
│   ├── useVoiceRecorder.ts  # Keep for fallback
│   └── useVoiceStream.ts    # NEW: WebSocket streaming
├── components/
│   ├── StreamingMessage.tsx # NEW: Progressive render
│   └── ConnectionStatus.tsx # NEW: WS state indicator
├── utils/
│   └── audioQueue.ts        # NEW: Chunked playback
└── App.tsx                  # Integrate streaming mode
```

---

## Configuration

### Environment Variables

```env
# .env.streaming
VITE_API_URL=https://glados.tailad67af.ts.net:8444
VITE_WS_URL=wss://glados.tailad67af.ts.net:8444
VITE_STREAMING_ENABLED=true
VITE_FALLBACK_TO_BATCH=true
```

### Feature Flags

```typescript
const config = {
  streaming: {
    enabled: import.meta.env.VITE_STREAMING_ENABLED === 'true',
    fallbackToBatch: import.meta.env.VITE_FALLBACK_TO_BATCH === 'true',
    transcriptionChunkMs: 3000,
    ttsChunkBySentence: true,
  }
};
```

---

## Fallback Strategy

Streaming should degrade gracefully to batch mode:

1. **WebSocket unavailable:** Fall back to HTTP endpoints
2. **Streaming transcription fails:** Buffer full audio, batch transcribe
3. **Response streaming unavailable:** Wait for complete response
4. **TTS chunking fails:** Generate single audio file

```typescript
// Automatic fallback
if (!streamingAvailable || wsError) {
  return useBatchMode();  // Existing implementation
}
```

---

## Testing Plan

### Unit Tests
- WebSocket message parsing
- Audio chunk buffering
- Transcript merging (overlap dedup)
- Audio queue sequencing

### Integration Tests
- Full streaming flow (record → transcribe → respond → play)
- Reconnection after disconnect
- Fallback to batch mode
- Cancel mid-stream

### Manual Testing Matrix

| Platform | Browser | Mic | WS | Streaming | Batch Fallback |
|----------|---------|-----|-------|-----------|----------------|
| macOS    | Chrome  | ✓   | ✓     | ✓         | ✓              |
| macOS    | Safari  | ✓   | ✓     | ✓         | ✓              |
| iOS      | Safari  | ✓   | ✓     | ✓         | ✓              |
| Android  | Chrome  | ✓   | ✓     | ✓         | ✓              |

---

## Security Considerations

1. **WebSocket Authentication:** Consider adding token-based auth for WS connections
2. **Rate Limiting:** Limit audio upload rate to prevent abuse
3. **Input Validation:** Sanitize all JSON messages
4. **Audio Size Limits:** Cap total audio duration per request

---

## Performance Targets

| Metric | Batch (Current) | Streaming (Target) |
|--------|-----------------|-------------------|
| Time to first transcript | 3-5s | <1s |
| Time to first response char | 8-35s | 2-5s |
| Time to first audio | 10-38s | 3-8s |
| Total perceived latency | 15-40s | 5-15s |

---

## Open Questions

1. **OpenClaw Streaming:** Does the gateway API support streaming responses? Need to investigate `/api/agent/stream` or similar.

2. **whisper.cpp Integration:** Is it worth building whisper.cpp for true streaming, or is chunked Whisper good enough for v1?

3. **TTS Alternatives:** Should we consider ElevenLabs streaming for lower latency, despite API costs?

4. **Session Persistence:** How to maintain conversation context across WebSocket reconnections?

---

## References

- [FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)
- [whisper.cpp streaming](https://github.com/ggerganov/whisper.cpp/tree/master/examples/stream)
- [faster-whisper](https://github.com/guillaumekln/faster-whisper)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [MediaRecorder API](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
