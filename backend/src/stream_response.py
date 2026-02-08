"""
Stream chat responses from OpenClaw CLI.
"""

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import AsyncIterator, Optional

logger = logging.getLogger(__name__)

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
        # Run OpenClaw CLI
        cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", "120"
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=130
        )
        
        if process.returncode == 0:
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
            error_msg = stderr.decode()[:200] if stderr else "Unknown error"
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
        # Run OpenClaw CLI
        cmd = [
            "openclaw", "agent",
            "--message", user_text,
            "--session-id", session_id,
            "--json",
            "--timeout", "120"
        ]
        
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=130
        )
        
        if process.returncode == 0:
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
            error_msg = stderr.decode()[:200] if stderr else "Unknown error"
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
