"""
Voice API Server for GLaDOS Mobile Voice Interface
FastAPI server providing STT (Whisper) and TTS (Piper) endpoints.
"""

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import subprocess
import os
import uuid
from pathlib import Path
from typing import Optional

from .utils import strip_markdown

app = FastAPI(title="GLaDOS Voice API", version="0.2.0-streaming")

# Register WebSocket routes for streaming
from .websocket import register_websocket_routes
register_websocket_routes(app)

# Enable CORS for PWA access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for Tailscale access
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Directory setup
AUDIO_CACHE_DIR = Path("audio_cache")
AUDIO_CACHE_DIR.mkdir(exist_ok=True)

# Static files directory (for test page)
STATIC_DIR = Path(__file__).parent.parent / "static"
STATIC_DIR.mkdir(exist_ok=True)


@app.get("/test", response_class=HTMLResponse)
async def test_page():
    """Serve the WebSocket test page."""
    test_file = STATIC_DIR / "test.html"
    if test_file.exists():
        return HTMLResponse(content=test_file.read_text())
    return HTMLResponse(content="<h1>Test page not found</h1>", status_code=404)

# External command templates
WHISPER_CMD = "whisper {input_file} --model base --output_format txt --output_dir {output_dir}"
PIPER_CMD = 'eval "$(pyenv init -)" && echo "{text}" | piper -m /Users/rich/Projects/piper-models/en_US-lessac-medium.onnx -f {output_file}'


class SpeakRequest(BaseModel):
    text: str


class ChatRequest(BaseModel):
    text: str


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/voice/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    """
    Transcribe audio file to text using Whisper.
    Accepts: wav, webm, mp3, m4a
    """
    # Validate file extension
    filename = file.filename or "audio.wav"
    file_ext = filename.split('.')[-1].lower()
    if file_ext not in ['wav', 'webm', 'mp3', 'm4a']:
        raise HTTPException(status_code=400, detail=f"Unsupported audio format: {file_ext}")

    # Save uploaded file to temp location
    tmp_id = uuid.uuid4().hex
    tmp_file_path = Path(f"/tmp/{tmp_id}.{file_ext}")
    output_dir = Path("/tmp")
    
    try:
        content = await file.read()
        tmp_file_path.write_bytes(content)

        # Run Whisper
        whisper_command = WHISPER_CMD.format(
            input_file=tmp_file_path,
            output_dir=output_dir
        )
        result = subprocess.run(whisper_command, shell=True, capture_output=True, text=True)

        if result.returncode != 0:
            raise HTTPException(
                status_code=500, 
                detail=f"Transcription failed: {result.stderr}"
            )

        # Whisper writes output to {input_filename}.txt
        output_file = output_dir / f"{tmp_id}.txt"
        if not output_file.exists():
            raise HTTPException(
                status_code=500,
                detail="Whisper did not produce output file"
            )
        
        transcription = output_file.read_text().strip()
        
        # Cleanup
        tmp_file_path.unlink(missing_ok=True)
        output_file.unlink(missing_ok=True)
        
        return JSONResponse(content={"text": transcription})
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/voice/speak")
async def speak(request: SpeakRequest):
    """
    Convert text to speech using Piper.
    Returns URL to download generated audio.
    """
    audio_id = uuid.uuid4().hex
    output_file_path = AUDIO_CACHE_DIR / f"{audio_id}.wav"
    
    # Strip markdown and escape for shell (double-quoted context)
    clean_text = strip_markdown(request.text)
    # In double quotes, only need to escape: backslashes, double quotes, backticks, and $
    safe_text = clean_text.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
    
    piper_command = PIPER_CMD.format(
        text=safe_text,
        output_file=output_file_path
    )
    
    result = subprocess.run(piper_command, shell=True, capture_output=True, text=True)

    if result.returncode != 0:
        raise HTTPException(
            status_code=500, 
            detail=f"Text-to-speech failed: {result.stderr}"
        )

    if not output_file_path.exists():
        raise HTTPException(
            status_code=500,
            detail="Piper did not produce output file"
        )

    return JSONResponse(content={"audio_url": f"/voice/audio/{audio_id}.wav"})


@app.post("/voice/chat/text")
async def chat_text(request: ChatRequest):
    """
    Chat with text input. Returns text response with audio URL.
    """
    return await _process_chat(request.text)


@app.post("/voice/chat/audio")
async def chat_audio(file: UploadFile = File(...)):
    """
    Chat with audio input. Transcribes first, then processes.
    """
    # Transcribe audio first
    filename = file.filename or "audio.wav"
    file_ext = filename.split('.')[-1].lower()
    
    # Handle various audio formats
    if file_ext not in ['wav', 'webm', 'mp3', 'm4a', 'mp4', 'ogg', 'oga']:
        print(f"[VOICE] Unsupported format: {file_ext}, filename: {filename}")
        raise HTTPException(status_code=400, detail=f"Unsupported audio format: {file_ext}")

    tmp_id = uuid.uuid4().hex
    tmp_file_path = Path(f"/tmp/{tmp_id}.{file_ext}")
    output_dir = Path("/tmp")
    
    content = await file.read()
    print(f"[VOICE] Received audio: {len(content)} bytes, format: {file_ext}")
    tmp_file_path.write_bytes(content)

    whisper_command = WHISPER_CMD.format(
        input_file=tmp_file_path,
        output_dir=output_dir
    )
    print(f"[VOICE] Running Whisper...")
    result = subprocess.run(whisper_command, shell=True, capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"[VOICE] Whisper failed: {result.stderr}")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {result.stderr}")

    output_file = output_dir / f"{tmp_id}.txt"
    if output_file.exists():
        user_text = output_file.read_text().strip()
        print(f"[VOICE] Transcribed: {user_text[:100]}...")
        output_file.unlink(missing_ok=True)
    else:
        print(f"[VOICE] No output file from Whisper")
        raise HTTPException(status_code=500, detail="Transcription produced no output")
    
    tmp_file_path.unlink(missing_ok=True)
    
    return await _process_chat(user_text)


async def _process_chat(user_text: str):
    """
    Internal function to process chat and generate response.
    """
    if not user_text:
        raise HTTPException(status_code=400, detail="No text provided")

    # Log the input
    print(f"[VOICE] Processing: {user_text[:100]}...")

    # Send to OpenClaw via CLI and get response
    try:
        import json as json_module
        openclaw_cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", "voice",
            "--json",
            "--timeout", "120"
        ]
        result = subprocess.run(
            openclaw_cmd,
            capture_output=True,
            text=True,
            timeout=130
        )
        
        print(f"[VOICE] OpenClaw returned code {result.returncode}")
        
        if result.returncode == 0:
            try:
                response_data = json_module.loads(result.stdout)
                # OpenClaw returns: result.payloads[0].text
                payloads = response_data.get("result", {}).get("payloads", [])
                if payloads and payloads[0].get("text"):
                    response_text = payloads[0]["text"]
                    print(f"[VOICE] Response: {response_text[:100]}...")
                else:
                    print(f"[VOICE] No payloads found. Keys: {list(response_data.keys())}")
                    response_text = "I processed your message."
            except json_module.JSONDecodeError as e:
                print(f"[VOICE] JSON decode error: {e}")
                print(f"[VOICE] Raw output: {result.stdout[:200]}")
                response_text = result.stdout.strip() or "I received your message."
        else:
            print(f"[VOICE] OpenClaw error: {result.stderr[:300] if result.stderr else 'no stderr'}")
            response_text = f"I heard: {user_text}. Processing encountered an issue."
    except subprocess.TimeoutExpired:
        print(f"[VOICE] Timeout!")
        response_text = f"I heard: {user_text}. Response timed out."
    except Exception as e:
        print(f"[VOICE] Exception: {e}")
        response_text = f"I heard: {user_text}. Error: {str(e)}"
    
    # Generate TTS for response - strip markdown for cleaner speech
    audio_id = uuid.uuid4().hex
    output_file_path = AUDIO_CACHE_DIR / f"{audio_id}.wav"
    
    clean_text = strip_markdown(response_text)
    # In double quotes, only need to escape: backslashes, double quotes, backticks, and $
    safe_text = clean_text.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$')
    piper_command = PIPER_CMD.format(
        text=safe_text,
        output_file=output_file_path
    )
    subprocess.run(piper_command, shell=True, capture_output=True)

    return JSONResponse(content={
        "user_text": user_text,
        "text": response_text,
        "audio_url": f"/voice/audio/{audio_id}.wav"
    })


@app.get("/voice/audio/{filename}")
async def serve_audio(filename: str):
    """Serve generated audio files."""
    # Sanitize filename to prevent directory traversal
    safe_filename = Path(filename).name
    file_path = AUDIO_CACHE_DIR / safe_filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Detect media type from extension
    ext = file_path.suffix.lower()
    media_type = MEDIA_TYPES.get(ext, "audio/wav")
    
    return FileResponse(file_path, media_type=media_type)


# Media type mapping for serving images/videos
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
}


@app.get("/voice/media/{filename}")
async def serve_media(filename: str):
    """Serve media files (images, videos, audio) with correct MIME types."""
    # Sanitize filename to prevent directory traversal
    safe_filename = Path(filename).name
    file_path = AUDIO_CACHE_DIR / safe_filename
    
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    
    # Detect media type from extension
    ext = file_path.suffix.lower()
    media_type = MEDIA_TYPES.get(ext, "application/octet-stream")
    
    return FileResponse(file_path, media_type=media_type)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8100)
