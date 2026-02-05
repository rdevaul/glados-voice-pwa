# Streaming Implementation Tasks

**For:** Local model code generation (qwen2.5-coder:32b)  
**Branch:** `streaming`  
**Spec:** See `STREAMING_SPEC.md`

---

## Task Delegation Guide

Each task below is self-contained with:
- Clear inputs/outputs
- File locations
- Test criteria
- Dependencies

Copy the task prompt to `ollama run qwen2.5-coder:32b` for code generation.

---

## Phase 1: WebSocket Infrastructure

### Task 1.1: Backend WebSocket Handler

**File:** `backend/src/websocket.py`

**Prompt for local model:**
```
Create a FastAPI WebSocket handler in Python for a voice streaming API.

Requirements:
1. WebSocket endpoint at /voice/stream
2. Handle these message types from client:
   - {"type": "audio_start", "format": "webm"}
   - Binary audio chunks (raw bytes)
   - {"type": "audio_end"}
   - {"type": "text", "content": "..."}
   - {"type": "cancel"}

3. Send these message types to client:
   - {"type": "ready", "session_id": "voice"}
   - {"type": "partial_transcript", "text": "...", "is_final": false}
   - {"type": "final_transcript", "text": "..."}
   - {"type": "response_chunk", "text": "...", "accumulated": "..."}
   - {"type": "response_complete", "text": "...", "audio_url": "..."}
   - {"type": "error", "code": "...", "message": "..."}

4. Use asyncio for non-blocking operations
5. Include proper connection lifecycle (connect, message loop, disconnect)
6. Add logging for debugging
7. Handle exceptions gracefully

Dependencies: fastapi, websockets, pydantic

Output a complete Python module with:
- Message type definitions (Pydantic models)
- WebSocketManager class for connection handling
- Route registration function
```

**Test:** Connect with `websocat ws://localhost:8100/voice/stream` and verify "ready" message.

---

### Task 1.2: Frontend WebSocket Hook

**File:** `src/hooks/useVoiceStream.ts`

**Prompt for local model:**
```
Create a React hook for WebSocket-based voice streaming in TypeScript.

Requirements:
1. Hook signature:
   function useVoiceStream(wsUrl: string): UseVoiceStreamReturn

2. State to track:
   - status: 'disconnected' | 'connecting' | 'ready' | 'recording' | 'processing'
   - partialTranscript: string
   - finalTranscript: string  
   - responseText: string
   - responseComplete: boolean
   - audioQueue: string[]
   - error: string | null

3. Actions to expose:
   - connect(): void
   - disconnect(): void
   - startRecording(): Promise<void>  
   - stopRecording(): void
   - sendText(text: string): void
   - cancel(): void

4. Handle incoming message types:
   - ready, partial_transcript, final_transcript
   - response_chunk, response_complete
   - audio_chunk, error

5. For recording:
   - Get microphone stream
   - Create MediaRecorder
   - Send binary chunks over WebSocket
   - Send audio_start before, audio_end after

6. Include reconnection logic with exponential backoff

7. Cleanup on unmount (close WebSocket, stop MediaRecorder)

Use modern React patterns (useCallback, useRef, useEffect cleanup).
```

**Test:** Import hook, verify connection state changes, send test text message.

---

### Task 1.3: Audio Queue Utility

**File:** `src/utils/audioQueue.ts`

**Prompt for local model:**
```
Create an AudioQueue class in TypeScript for sequential audio playback.

Requirements:
1. Class interface:
   class AudioQueue {
     enqueue(url: string): void
     clear(): void
     pause(): void
     resume(): void
     get isPlaying(): boolean
     get queueLength(): number
     onPlaybackStart?: (url: string) => void
     onPlaybackEnd?: (url: string) => void
     onQueueEmpty?: () => void
     onError?: (error: Error, url: string) => void
   }

2. Behavior:
   - Play audio URLs in FIFO order
   - Wait for current audio to finish before playing next
   - Handle playback errors gracefully (skip to next)
   - Support pause/resume of current playback
   - Clear queue cancels current and removes pending
   
3. Use HTMLAudioElement for playback

4. Handle Safari autoplay restrictions:
   - First playback may need user gesture
   - Expose method to "warm up" audio context

5. Include TypeScript types for all callbacks
```

**Test:** Queue 3 audio files, verify sequential playback, test pause/resume.

---

## Phase 2: Streaming Transcription

### Task 2.1: Chunked Whisper Transcription

**File:** `backend/src/transcribe.py`

**Prompt for local model:**
```
Create a Python module for chunked audio transcription using Whisper.

Requirements:
1. Class: ChunkedTranscriber
   - __init__(chunk_duration_ms=3000, overlap_ms=500)
   - async feed_audio(chunk: bytes) -> Optional[str]  # Returns partial transcript
   - async finalize() -> str  # Returns final transcript
   - reset()

2. Buffer incoming audio chunks
3. When buffer exceeds chunk_duration_ms:
   - Write to temp file
   - Run Whisper CLI on chunk
   - Parse output, yield partial transcript
   - Keep overlap_ms of audio for continuity

4. On finalize:
   - Process remaining buffer
   - Merge all partials, deduplicate overlapping text
   - Return complete transcript

5. Whisper CLI command:
   whisper {input_file} --model base --output_format txt --output_dir {output_dir}

6. Handle formats: webm, wav, mp4 (use ffmpeg to convert if needed)

7. Cleanup temp files after processing

Use asyncio subprocess for non-blocking Whisper calls.
```

**Test:** Feed 10 seconds of audio in 1-second chunks, verify partial transcripts appear.

---

### Task 2.2: Alternative - faster-whisper Integration

**File:** `backend/src/transcribe_fast.py`

**Prompt for local model:**
```
Create a Python module for streaming transcription using faster-whisper.

Requirements:
1. Install: pip install faster-whisper

2. Class: FastWhisperTranscriber
   - __init__(model_size="base", compute_type="int8")
   - async transcribe_stream(audio_chunks: AsyncIterator[bytes]) -> AsyncIterator[str]
   - async transcribe_file(path: str) -> str

3. Use WhisperModel with VAD filter for segment detection

4. Yield text as each segment completes

5. Handle audio format conversion if needed

6. Include model lazy loading (don't load until first use)

7. Add logging for transcription progress

Note: faster-whisper may not support true streaming - if so, fall back to
chunked processing similar to Task 2.1 but using faster-whisper for speed.
```

**Test:** Transcribe a test audio file, compare speed to CLI Whisper.

---

## Phase 3: Response Streaming

### Task 3.1: OpenClaw Response Streamer

**File:** `backend/src/stream_response.py`

**Prompt for local model:**
```
Create a Python module to stream responses from OpenClaw or Anthropic API.

Requirements:
1. async def stream_chat_response(
       user_text: str,
       session_id: str = "voice"
   ) -> AsyncIterator[str]:
   
2. First, try OpenClaw gateway streaming:
   - POST to http://localhost:4747/api/agent/stream
   - Parse SSE/NDJSON response
   - Yield text chunks

3. Fallback to direct Anthropic API:
   - Use anthropic library with streaming
   - Inject system context for voice assistant
   - Yield text from stream.text_stream

4. Handle errors gracefully:
   - Timeout after 120 seconds
   - Yield error message if API fails
   - Log all errors

5. Environment variables:
   - OPENCLAW_GATEWAY_URL (default: http://localhost:4747)
   - ANTHROPIC_API_KEY (for fallback)

Include type hints and docstrings.
```

**Test:** Send test message, verify chunks arrive progressively.

---

### Task 3.2: Streaming Message Component

**File:** `src/components/StreamingMessage.tsx`

**Prompt for local model:**
```
Create a React component for displaying streaming messages.

Requirements:
1. Props:
   interface StreamingMessageProps {
     role: 'user' | 'assistant'
     text: string
     isStreaming: boolean
     audioUrls?: string[]
     onPlayAudio?: (url: string) => void
     partialTranscript?: string  // For user messages during recording
   }

2. Display:
   - User messages: right-aligned, different background
   - Assistant messages: left-aligned, supports markdown
   - Show typing indicator (animated dots) when isStreaming=true
   - Show partial transcript in italics while recording

3. Markdown rendering:
   - Use react-markdown
   - Support code blocks with syntax highlighting
   - Support lists, bold, italic

4. Audio playback button:
   - Show 🔊 button if audioUrls provided
   - Click plays first audio URL
   - Disable during streaming

5. Animations:
   - Fade in when message appears
   - Smooth text expansion as content streams in

6. Accessibility:
   - aria-live for streaming content
   - Proper roles and labels
```

**Test:** Render with streaming=true, verify typing indicator, test markdown.

---

## Phase 4: TTS Streaming

### Task 4.1: Sentence-Chunked TTS

**File:** `backend/src/tts_chunked.py`

**Prompt for local model:**
```
Create a Python module for sentence-level TTS chunking with Piper.

Requirements:
1. async def generate_tts_chunks(
       text: str,
       output_dir: Path
   ) -> AsyncIterator[str]:
   """Yield audio file paths as sentences are synthesized."""

2. Split text into sentences:
   - Split on . ! ? followed by space or end
   - Keep sentences together if under 10 words
   - Handle abbreviations (Mr., Dr., etc.)

3. For each sentence/chunk:
   - Generate unique filename: {uuid}_chunk{n}.wav
   - Run Piper TTS
   - Yield file path immediately when ready

4. Piper command:
   echo "{text}" | piper -m /Users/rich/Projects/piper-models/en_US-lessac-medium.onnx -f {output_file}

5. Handle text escaping for shell

6. Cleanup function to remove generated files

7. Include pyenv init in shell commands

Use asyncio subprocess for parallel generation where possible.
```

**Test:** Generate TTS for 3-sentence text, verify 3 audio files, sequential playback.

---

### Task 4.2: TTS Manager with Caching

**File:** `backend/src/tts_manager.py`

**Prompt for local model:**
```
Create a TTS manager with caching and cleanup.

Requirements:
1. class TTSManager:
   - __init__(cache_dir: Path, max_cache_size_mb: int = 100)
   - async synthesize(text: str) -> str  # Returns audio URL path
   - async synthesize_chunked(text: str) -> AsyncIterator[str]  # Yields chunk URLs
   - cleanup_old_files(max_age_hours: int = 24)
   - get_audio_path(url_path: str) -> Path

2. Caching:
   - Hash text content for cache key
   - Return cached file if exists
   - LRU eviction when cache exceeds max size

3. File management:
   - Store in cache_dir/YYYY-MM-DD/ subdirectories
   - Periodic cleanup of old files
   - Track file access times

4. Thread safety:
   - Use asyncio.Lock for cache operations
   - Safe concurrent synthesis requests

5. Expose as singleton or dependency injection pattern
```

**Test:** Synthesize same text twice, verify cache hit on second call.

---

## Phase 5: Integration

### Task 5.1: Update Main Backend

**File:** `backend/src/main.py` (modifications)

**Prompt for local model:**
```
Modify the existing FastAPI main.py to integrate WebSocket streaming.

Current endpoints to keep (batch mode fallback):
- GET /health
- POST /voice/transcribe
- POST /voice/speak  
- POST /voice/chat/text
- POST /voice/chat/audio
- GET /voice/audio/{filename}

Add:
1. Import and register WebSocket routes from websocket.py
2. Add startup event to initialize:
   - TTSManager singleton
   - Whisper model (if using faster-whisper)
3. Add shutdown event for cleanup
4. Add configuration via environment variables:
   - STREAMING_ENABLED (default: true)
   - WHISPER_MODEL (default: base)
   - TTS_CACHE_DIR (default: audio_cache)

Keep existing batch endpoints working for fallback.

Show only the modifications needed, not the full file.
```

---

### Task 5.2: Update Frontend App

**File:** `src/App.tsx` (modifications)

**Prompt for local model:**
```
Modify the existing App.tsx to support both streaming and batch modes.

Current features to keep:
- Message history with localStorage
- Text input form
- Push-to-talk button
- Audio playback

Add:
1. Import useVoiceStream hook
2. Feature flag: const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED === 'true'
3. If streaming enabled:
   - Use WebSocket for recording and responses
   - Show partial transcripts during recording
   - Stream response text progressively
   - Use AudioQueue for TTS playback
4. If streaming disabled or WebSocket fails:
   - Fall back to existing batch implementation
5. Connection status indicator in header
6. Smooth transition between modes

Show the key modifications needed, preserving existing functionality.
```

---

## Dependency Updates

### Task D.1: Backend Requirements

**File:** `backend/requirements.txt`

```
# Existing
fastapi
uvicorn[standard]
python-multipart

# Add for streaming
websockets>=12.0
faster-whisper>=0.10.0  # Optional, for faster transcription
anthropic>=0.18.0       # For direct API fallback
aiofiles>=23.0.0        # Async file operations
```

### Task D.2: Frontend Package.json

Add to devDependencies:
```json
{
  "@types/websocket": "^1.0.0"
}
```

---

## Testing Tasks

### Task T.1: WebSocket Integration Test

**File:** `backend/tests/test_websocket.py`

**Prompt for local model:**
```
Create pytest tests for the WebSocket streaming endpoint.

Tests:
1. test_connection_ready - Connect, receive ready message
2. test_text_message - Send text, receive response chunks
3. test_audio_flow - Send audio_start, chunks, audio_end, verify transcript
4. test_cancel - Send cancel mid-stream, verify cleanup
5. test_reconnection - Disconnect and reconnect
6. test_invalid_message - Send malformed JSON, verify error response

Use pytest-asyncio for async tests.
Use websockets library for client.
```

---

## Commit Checklist

After each phase, commit with:
```bash
git add -A
git commit -m "feat(streaming): Phase N - description"
git push origin streaming
```

Keep commits atomic - one feature per commit.

---

## Notes for Code Generation

When using local models:

1. **Context window:** qwen2.5-coder:32b has 32K context. Include relevant imports and interfaces.

2. **Iteration:** If output is incomplete, ask for continuation with "continue from line X"

3. **Refinement:** Review generated code, ask for fixes: "Fix the error handling in function X"

4. **Testing:** Always test generated code before committing

5. **Style:** Request consistent style: "Use Google docstring format" or "Follow existing code style in {file}"
