#!/bin/bash
# Start the Voice API server

cd "$(dirname "$0")"

# Activate pyenv for piper access
eval "$(pyenv init -)"

# Create venv if needed
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python -m venv .venv
    source .venv/bin/activate
    pip install -r requirements.txt
else
    source .venv/bin/activate
fi

# Run the server
echo "Starting Voice API server on http://0.0.0.0:8100"
uvicorn src.main:app --host 0.0.0.0 --port 8100 --reload
