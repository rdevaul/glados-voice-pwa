"""
Minimal Voxtral transcription server using voxmlx.
Loads the model ONCE at startup, then serves subsequent requests fast.
OpenAI-compatible POST /v1/audio/transcriptions endpoint (returns JSON).

Run: python3 voxtral_server.py
Env: VOXTRAL_MODEL, VOXTRAL_PORT (default 8301)
"""

import asyncio
import logging
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
logger = logging.getLogger(__name__)

MODEL_PATH = os.environ.get("VOXTRAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-6bit")
PORT = int(os.environ.get("VOXTRAL_PORT", "8301"))

# ── Load model once at startup ─────────────────────────────────────────────────
logger.info(f"Loading Voxtral model: {MODEL_PATH}")
try:
    from voxmlx import load_model, generate, _build_prompt_tokens, SpecialTokenPolicy
    _model, _sp, _config = load_model(MODEL_PATH)
    _prompt_tokens, _n_delay_tokens = _build_prompt_tokens(_sp)
    _eos_id = _sp.eos_id
    logger.info("Voxtral model loaded and ready ✓")
    _ready = True
except Exception as _load_err:
    logger.error(f"Failed to load Voxtral model: {_load_err}")
    _ready = False


def _convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert audio to 16kHz mono WAV via ffmpeg."""
    r = subprocess.run(
        ["ffmpeg", "-y", "-i", input_path,
         "-ar", "16000", "-ac", "1", "-f", "wav", output_path],
        capture_output=True,
    )
    return r.returncode == 0 and Path(output_path).stat().st_size > 0


def _run_transcription(wav_path: str) -> str:
    """Synchronous transcription — called in executor to avoid blocking."""
    output_tokens = generate(
        _model, wav_path, _prompt_tokens,
        n_delay_tokens=_n_delay_tokens,
        eos_token_id=_eos_id,
    )
    return _sp.decode(output_tokens, special_token_policy=SpecialTokenPolicy.IGNORE)


app = FastAPI(title="Voxtral STT Server", version="0.1.0")


@app.get("/")
async def root():
    return {"status": "ok", "model": MODEL_PATH, "ready": _ready}


@app.get("/health")
async def health():
    return {"status": "ok" if _ready else "model_not_loaded"}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=None),
    language: str = Form(default="en"),
):
    """OpenAI-compatible transcription endpoint (returns JSON {text: ...})."""
    if not _ready:
        return JSONResponse(status_code=503, content={"error": "Model not loaded"})

    tmp_id = uuid.uuid4().hex
    tmp_dir = Path(tempfile.gettempdir())
    ext = Path(file.filename or "audio.webm").suffix or ".webm"
    input_path = tmp_dir / f"{tmp_id}{ext}"
    wav_path = tmp_dir / f"{tmp_id}.wav"

    try:
        content = await file.read()
        input_path.write_bytes(content)

        if not _convert_to_wav(str(input_path), str(wav_path)):
            return JSONResponse(status_code=400, content={"error": "Audio conversion failed"})

        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(None, _run_transcription, str(wav_path))
        text = text.strip()

        logger.info(f"Transcribed {len(content)} bytes → {text[:80]!r}")
        return JSONResponse({"text": text})

    except Exception as e:
        logger.error(f"Transcription error: {e}", exc_info=True)
        return JSONResponse(status_code=500, content={"error": str(e)})

    finally:
        input_path.unlink(missing_ok=True)
        wav_path.unlink(missing_ok=True)


if __name__ == "__main__":
    uvicorn.run(app, host="localhost", port=PORT, log_level="info")
