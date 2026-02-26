#!/usr/bin/env python3
"""
Standalone Voxtral transcription script.
Called as a subprocess by the voice backend (Python 3.14 venv can't run MLX directly).

Usage: python3 voxtral_transcribe.py <audio_file> [model_path]
Output: transcript text on stdout, errors on stderr, exit code 0 on success.
"""

import sys
import os

if len(sys.argv) < 2:
    print("Usage: voxtral_transcribe.py <audio_file> [model_path]", file=sys.stderr)
    sys.exit(1)

audio_file = sys.argv[1]
model_path = sys.argv[2] if len(sys.argv) > 2 else "mlx-community/Voxtral-Mini-4B-Realtime-6bit"

if not os.path.exists(audio_file):
    print(f"File not found: {audio_file}", file=sys.stderr)
    sys.exit(1)

try:
    from voxmlx import transcribe
    result = transcribe(audio_file, model_path=model_path)
    # voxmlx returns a string or object with .text
    if hasattr(result, "text"):
        print(result.text, end="")
    else:
        print(str(result), end="")
    sys.exit(0)
except Exception as e:
    print(f"Voxtral error: {e}", file=sys.stderr)
    sys.exit(1)
