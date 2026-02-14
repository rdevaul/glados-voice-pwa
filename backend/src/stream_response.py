"""
Stream chat responses from OpenClaw CLI.
"""

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import AsyncIterator, Optional, Callable, Awaitable

logger = logging.getLogger(__name__)

# Progress messages shown while waiting for long responses
PROGRESS_MESSAGES = [
    "Working on that...",
    "Still processing...",
    "This is taking a moment, but I'm on it...",
    "Hang tight, almost there...",
    "Still working on your request...",
]

# OpenClaw session store location
OPENCLAW_SESSIONS_FILE = Path.home() / ".openclaw" / "agents" / "main" / "sessions" / "sessions.json"
MAIN_SESSION_KEY = "agent:main:main"


def get_main_session_id() -> str:
    """
    Look up the actual UUID for the main session from OpenClaw's sessions.json.
    Falls back to the key name if lookup fails (will create new session).
    """
    try:
        if OPENCLAW_SESSIONS_FILE.exists():
            with open(OPENCLAW_SESSIONS_FILE) as f:
                sessions = json.load(f)
            
            if MAIN_SESSION_KEY in sessions:
                session_id = sessions[MAIN_SESSION_KEY].get("sessionId")
                if session_id:
                    logger.info(f"Resolved main session UUID: {session_id}")
                    return session_id
        
        logger.warning(f"Could not find main session, using key: {MAIN_SESSION_KEY}")
        return MAIN_SESSION_KEY
        
    except Exception as e:
        logger.error(f"Error reading sessions.json: {e}")
        return MAIN_SESSION_KEY


# Retry configuration for transient failures (e.g., gateway restarts)
RETRY_MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 2.0

# Patterns in stderr that are warnings, not errors
IGNORABLE_STDERR_PATTERNS = [
    "DeprecationWarning",
    "ExperimentalWarning", 
    "punycode",
    "--trace-deprecation",
]


def _is_transient_error(stderr_text: str, returncode: int) -> bool:
    """
    Check if an error is likely transient and worth retrying.
    
    Returns True for:
    - Gateway restart (connection refused, ECONNRESET)
    - Temporary unavailability
    - Node.js deprecation warnings treated as errors
    """
    if returncode == 0:
        return False
    
    stderr_lower = stderr_text.lower() if stderr_text else ""
    
    # Check if stderr only contains ignorable warnings
    if stderr_text:
        lines = [l.strip() for l in stderr_text.split('\n') if l.strip()]
        non_warning_lines = []
        for line in lines:
            is_warning = any(pattern.lower() in line.lower() for pattern in IGNORABLE_STDERR_PATTERNS)
            if not is_warning:
                non_warning_lines.append(line)
        
        # If all lines were warnings, this is a false positive error
        if not non_warning_lines:
            return True
    
    # Transient network/connection errors
    transient_patterns = [
        "econnrefused",
        "econnreset", 
        "connection refused",
        "connection reset",
        "gateway",
        "temporarily unavailable",
        "service unavailable",
    ]
    
    return any(pattern in stderr_lower for pattern in transient_patterns)


def _filter_stderr(stderr_text: str) -> str:
    """
    Filter out harmless warnings from stderr, returning only real errors.
    """
    if not stderr_text:
        return ""
    
    lines = stderr_text.split('\n')
    error_lines = []
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
        
        # Skip lines that are just warnings
        is_warning = any(pattern.lower() in line.lower() for pattern in IGNORABLE_STDERR_PATTERNS)
        if not is_warning:
            error_lines.append(line)
    
    return '\n'.join(error_lines)


async def _run_openclaw_with_retry(
    cmd: list[str],
    timeout: float = 130,
    max_attempts: int = RETRY_MAX_ATTEMPTS,
    retry_delay: float = RETRY_DELAY_SECONDS,
) -> tuple[bytes, bytes, int]:
    """
    Run OpenClaw CLI with retry logic for transient failures.
    
    Returns:
        Tuple of (stdout, stderr, returncode)
    """
    last_exception = None
    last_stderr = b""
    last_returncode = -1
    
    for attempt in range(1, max_attempts + 1):
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout
            )
            
            returncode = process.returncode
            stderr_text = stderr.decode() if stderr else ""
            
            # Success - return immediately
            if returncode == 0:
                # Log any warnings that were in stderr
                filtered = _filter_stderr(stderr_text)
                if filtered:
                    logger.warning(f"OpenClaw warnings (ignored): {filtered[:200]}")
                return stdout, stderr, returncode
            
            # Check if this is a transient error worth retrying
            if attempt < max_attempts and _is_transient_error(stderr_text, returncode):
                logger.warning(
                    f"OpenClaw transient error (attempt {attempt}/{max_attempts}), "
                    f"retrying in {retry_delay}s: {stderr_text[:100]}"
                )
                await asyncio.sleep(retry_delay)
                continue
            
            # Non-transient error or last attempt - return as-is
            return stdout, stderr, returncode
            
        except asyncio.TimeoutError:
            last_exception = asyncio.TimeoutError()
            if attempt < max_attempts:
                logger.warning(f"OpenClaw timeout (attempt {attempt}/{max_attempts}), retrying...")
                await asyncio.sleep(retry_delay)
                continue
            raise
            
        except Exception as e:
            last_exception = e
            if attempt < max_attempts:
                logger.warning(f"OpenClaw error (attempt {attempt}/{max_attempts}): {e}, retrying...")
                await asyncio.sleep(retry_delay)
                continue
            raise
    
    # Should not reach here, but just in case
    return b"", last_stderr, last_returncode


async def stream_chat_response(
    user_text: str,
    session_id: str | None = None
) -> AsyncIterator[str]:
    """
    Stream response chunks from OpenClaw.
    
    Currently uses batch mode (OpenClaw CLI doesn't support streaming),
    but yields the response in chunks to simulate streaming.
    
    Args:
        user_text: The user's message
        session_id: OpenClaw session ID
        
    Yields:
        Response text chunks
    """
    if not user_text or not user_text.strip():
        yield "I didn't catch that. Could you please repeat?"
        return
    
    # Resolve session ID to the main session's UUID if not provided
    if session_id is None:
        session_id = get_main_session_id()
    
    logger.info(f"Sending to OpenClaw (session {session_id[:20]}...): {user_text[:50]}...")
    
    try:
        # Run OpenClaw CLI with retry logic
        cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", "120"
        ]
        
        stdout, stderr, returncode = await _run_openclaw_with_retry(cmd, timeout=130)
        
        if returncode == 0:
            try:
                response_data = json.loads(stdout.decode())
                payloads = response_data.get("result", {}).get("payloads", [])
                
                if payloads and payloads[0].get("text"):
                    response_text = payloads[0]["text"]
                    logger.info(f"OpenClaw response: {response_text[:100]}...")
                    
                    # Simulate streaming by yielding in chunks
                    # Split on sentence boundaries for natural chunking
                    sentences = _split_sentences(response_text)
                    
                    for sentence in sentences:
                        yield sentence
                        # Small delay between chunks to simulate streaming
                        await asyncio.sleep(0.05)
                else:
                    logger.warning(f"No payloads in response: {list(response_data.keys())}")
                    yield "I processed your message but got an unexpected response format."
                    
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error: {e}")
                # Try to use raw output
                raw = stdout.decode().strip()
                if raw:
                    yield raw
                else:
                    yield "I received your message."
        else:
            error_msg = _filter_stderr(stderr.decode()) if stderr else "Unknown error"
            error_msg = error_msg[:200] if error_msg else "Unknown error"
            logger.error(f"OpenClaw error: {error_msg}")
            yield f"Sorry, I encountered an error processing your request."
            
    except asyncio.TimeoutError:
        logger.error("OpenClaw timeout")
        yield "Sorry, the response took too long. Please try again."
        
    except FileNotFoundError:
        logger.error("OpenClaw CLI not found")
        yield "The chat service is not available right now."
        
    except Exception as e:
        logger.exception(f"Error in stream_chat_response: {e}")
        yield f"Sorry, something went wrong: {str(e)}"


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences for chunked delivery."""
    import re
    
    # Split on sentence boundaries but keep the punctuation
    sentences = re.split(r'(?<=[.!?])\s+', text)
    
    # Filter empty strings and strip whitespace
    return [s.strip() for s in sentences if s.strip()]


async def get_full_response(user_text: str, session_id: str | None = None) -> str:
    """Get complete response (non-streaming convenience function)."""
    chunks = []
    async for chunk in stream_chat_response(user_text, session_id):
        chunks.append(chunk)
    return " ".join(chunks)


async def get_all_responses(user_text: str, session_id: str | None = None) -> list[dict]:
    """
    Get all response payloads from OpenClaw.
    
    Returns a list of payload dicts, each with 'text' and optionally 'mediaUrl'.
    This supports multi-message responses where the agent sends multiple replies.
    
    Args:
        user_text: The user's message
        session_id: OpenClaw session ID (defaults to main session)
        
    Returns:
        List of payload dicts: [{"text": "...", "mediaUrl": None}, ...]
    """
    if not user_text or not user_text.strip():
        return [{"text": "I didn't catch that. Could you please repeat?", "mediaUrl": None}]
    
    # Resolve session ID to the main session's UUID if not provided
    if session_id is None:
        session_id = get_main_session_id()
    
    logger.info(f"Sending to OpenClaw (session {session_id[:20]}...): {user_text[:50]}...")
    
    try:
        # Run OpenClaw CLI with retry logic
        cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", "120"
        ]
        
        stdout, stderr, returncode = await _run_openclaw_with_retry(cmd, timeout=130)
        
        if returncode == 0:
            try:
                response_data = json.loads(stdout.decode())
                payloads = response_data.get("result", {}).get("payloads", [])
                
                if payloads:
                    # Return all payloads that have text
                    results = []
                    for i, payload in enumerate(payloads):
                        text = payload.get("text")
                        if text:
                            logger.info(f"OpenClaw payload {i+1}/{len(payloads)}: {text[:100]}...")
                            results.append({
                                "text": text,
                                "mediaUrl": payload.get("mediaUrl")
                            })
                    
                    if results:
                        return results
                    
                logger.warning(f"No text payloads in response: {list(response_data.keys())}")
                return [{"text": "I processed your message but got an unexpected response format.", "mediaUrl": None}]
                    
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error: {e}")
                raw = stdout.decode().strip()
                if raw:
                    return [{"text": raw, "mediaUrl": None}]
                return [{"text": "I received your message.", "mediaUrl": None}]
        else:
            error_msg = _filter_stderr(stderr.decode()) if stderr else "Unknown error"
            error_msg = error_msg[:200] if error_msg else "Unknown error"
            logger.error(f"OpenClaw error: {error_msg}")
            return [{"text": "Sorry, I encountered an error processing your request.", "mediaUrl": None}]
            
    except asyncio.TimeoutError:
        logger.error("OpenClaw timeout")
        return [{"text": "Sorry, the response took too long. Please try again.", "mediaUrl": None}]
        
    except FileNotFoundError:
        logger.error("OpenClaw CLI not found")
        return [{"text": "The chat service is not available right now.", "mediaUrl": None}]
        
    except Exception as e:
        logger.exception(f"Error in get_all_responses: {e}")
        return [{"text": f"Sorry, something went wrong: {str(e)}", "mediaUrl": None}]


async def get_all_responses_with_progress(
    user_text: str,
    session_id: str | None = None,
    progress_callback: Callable[[str, int], Awaitable[None]] | None = None,
    progress_interval: int = 10,
    max_timeout: int = 300,
) -> list[dict]:
    """
    Get all response payloads from OpenClaw with progress updates.
    
    Sends progress updates via callback while waiting for long responses.
    This prevents client timeouts and provides user feedback.
    
    Args:
        user_text: The user's message
        session_id: OpenClaw session ID (defaults to main session)
        progress_callback: Async function called with (message, elapsed_seconds)
        progress_interval: Seconds between progress updates (default 10)
        max_timeout: Maximum time to wait for response (default 300s)
        
    Returns:
        List of payload dicts: [{"text": "...", "mediaUrl": None}, ...]
    """
    if not user_text or not user_text.strip():
        return [{"text": "I didn't catch that. Could you please repeat?", "mediaUrl": None}]
    
    # Resolve session ID to the main session's UUID if not provided
    if session_id is None:
        session_id = get_main_session_id()
    
    logger.info(f"Sending to OpenClaw with progress (session {session_id[:20]}...): {user_text[:50]}...")
    
    # Progress heartbeat task
    progress_task: Optional[asyncio.Task] = None
    
    async def send_progress():
        """Send periodic progress updates."""
        elapsed = 0
        try:
            while True:
                await asyncio.sleep(progress_interval)
                elapsed += progress_interval
                if progress_callback:
                    # Cycle through progress messages
                    msg_idx = (elapsed // progress_interval - 1) % len(PROGRESS_MESSAGES)
                    msg = PROGRESS_MESSAGES[msg_idx]
                    try:
                        await progress_callback(msg, elapsed)
                        logger.debug(f"Sent progress update: {msg} ({elapsed}s)")
                    except Exception as e:
                        logger.warning(f"Progress callback failed: {e}")
        except asyncio.CancelledError:
            logger.debug(f"Progress task cancelled after {elapsed}s")
            raise
    
    try:
        # Run OpenClaw CLI with retry logic
        cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", str(max_timeout - 10)  # Leave buffer for subprocess timeout
        ]
        
        # Start progress heartbeat
        if progress_callback:
            progress_task = asyncio.create_task(send_progress())
        
        try:
            stdout, stderr, returncode = await _run_openclaw_with_retry(
                cmd, 
                timeout=max_timeout,
                max_attempts=RETRY_MAX_ATTEMPTS,
                retry_delay=RETRY_DELAY_SECONDS
            )
        finally:
            # Always cancel progress task when done
            if progress_task:
                progress_task.cancel()
                try:
                    await progress_task
                except asyncio.CancelledError:
                    pass
        
        if returncode == 0:
            try:
                response_data = json.loads(stdout.decode())
                payloads = response_data.get("result", {}).get("payloads", [])
                
                if payloads:
                    # Return all payloads that have text
                    results = []
                    for i, payload in enumerate(payloads):
                        text = payload.get("text")
                        if text:
                            logger.info(f"OpenClaw payload {i+1}/{len(payloads)}: {text[:100]}...")
                            results.append({
                                "text": text,
                                "mediaUrl": payload.get("mediaUrl")
                            })
                    
                    if results:
                        return results
                    
                logger.warning(f"No text payloads in response: {list(response_data.keys())}")
                return [{"text": "I processed your message but got an unexpected response format.", "mediaUrl": None}]
                    
            except json.JSONDecodeError as e:
                logger.error(f"JSON decode error: {e}")
                raw = stdout.decode().strip()
                if raw:
                    return [{"text": raw, "mediaUrl": None}]
                return [{"text": "I received your message.", "mediaUrl": None}]
        else:
            error_msg = _filter_stderr(stderr.decode()) if stderr else "Unknown error"
            error_msg = error_msg[:200] if error_msg else "Unknown error"
            logger.error(f"OpenClaw error: {error_msg}")
            return [{"text": "Sorry, I encountered an error processing your request.", "mediaUrl": None}]
            
    except asyncio.TimeoutError:
        logger.error(f"OpenClaw timeout after {max_timeout}s")
        return [{"text": f"Sorry, the response took too long (>{max_timeout}s). Please try again with a simpler request.", "mediaUrl": None}]
        
    except FileNotFoundError:
        logger.error("OpenClaw CLI not found")
        return [{"text": "The chat service is not available right now.", "mediaUrl": None}]
        
    except Exception as e:
        logger.exception(f"Error in get_all_responses_with_progress: {e}")
        return [{"text": f"Sorry, something went wrong: {str(e)}", "mediaUrl": None}]
