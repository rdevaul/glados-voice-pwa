"""
Session store for persistent WebSocket sessions.
Enables reconnection and state recovery after app switches.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Session:
    """Represents a voice session with its state."""
    session_id: str
    created_at: float = field(default_factory=time.time)
    last_activity: float = field(default_factory=time.time)
    state: str = 'idle'  # idle, recording, transcribing, processing
    pending_messages: List[Dict[str, Any]] = field(default_factory=list)
    partial_transcript: str = ''
    partial_response: str = ''
    audio_buffer: bytes = b''
    audio_format: str = 'webm'
    metadata: Dict[str, Any] = field(default_factory=dict)


class SessionStore:
    """
    In-memory session store with TTL-based expiration.
    Thread-safe using asyncio locks.
    """

    def __init__(self, default_ttl_seconds: int = 3600):
        self._sessions: Dict[str, Session] = {}
        self._lock = asyncio.Lock()
        self._default_ttl = default_ttl_seconds

    async def create_session(self) -> str:
        """Create a new session and return its ID."""
        session_id = uuid.uuid4().hex
        session = Session(session_id=session_id)
        
        async with self._lock:
            self._sessions[session_id] = session
        
        logger.info(f"Created session: {session_id}")
        return session_id

    async def get_session(self, session_id: str) -> Optional[Session]:
        """Get a session by ID, or None if not found/expired."""
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                # Check if expired
                age = time.time() - session.last_activity
                if age > self._default_ttl:
                    del self._sessions[session_id]
                    logger.info(f"Session expired: {session_id} (age={age:.0f}s)")
                    return None
            return session

    async def update_session(self, session_id: str, **updates) -> bool:
        """
        Update session fields. Also touches last_activity.
        Returns True if session exists and was updated.
        """
        async with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return False
            
            for key, value in updates.items():
                if hasattr(session, key):
                    setattr(session, key, value)
            
            session.last_activity = time.time()
            return True

    async def touch_session(self, session_id: str) -> bool:
        """Update last_activity timestamp. Returns True if session exists."""
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.last_activity = time.time()
                return True
            return False

    async def delete_session(self, session_id: str) -> bool:
        """Delete a session. Returns True if it existed."""
        async with self._lock:
            if session_id in self._sessions:
                del self._sessions[session_id]
                logger.info(f"Deleted session: {session_id}")
                return True
            return False

    async def queue_message(self, session_id: str, message: Dict[str, Any]) -> bool:
        """
        Queue a message for delivery when client reconnects.
        Returns True if session exists.
        """
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.pending_messages.append(message)
                session.last_activity = time.time()
                logger.debug(f"Queued message for {session_id}: {message.get('type', 'unknown')}")
                return True
            return False

    async def get_pending_messages(self, session_id: str) -> List[Dict[str, Any]]:
        """Get all pending messages for a session (does not clear them)."""
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                return list(session.pending_messages)
            return []

    async def clear_pending_messages(self, session_id: str) -> bool:
        """Clear pending messages after successful delivery. Returns True if session exists."""
        async with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.pending_messages = []
                return True
            return False

    async def cleanup_stale_sessions(self, max_age_seconds: Optional[int] = None) -> int:
        """
        Remove sessions that haven't been active within max_age_seconds.
        Returns count of sessions removed.
        """
        max_age = max_age_seconds or self._default_ttl
        cutoff = time.time() - max_age
        removed = 0
        
        async with self._lock:
            stale_ids = [
                sid for sid, session in self._sessions.items()
                if session.last_activity < cutoff
            ]
            for sid in stale_ids:
                del self._sessions[sid]
                removed += 1
        
        if removed > 0:
            logger.info(f"Cleaned up {removed} stale session(s)")
        
        return removed

    async def get_active_session_count(self) -> int:
        """Return count of active sessions."""
        async with self._lock:
            return len(self._sessions)

    async def get_session_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Get session state for client reconnection.
        Returns dict with state info, or None if session doesn't exist.
        """
        session = await self.get_session(session_id)
        if not session:
            return None
        
        return {
            'session_id': session.session_id,
            'state': session.state,
            'partial_transcript': session.partial_transcript,
            'partial_response': session.partial_response,
            'pending_message_count': len(session.pending_messages),
        }


# Singleton instance
session_store = SessionStore()


async def start_cleanup_task(store: SessionStore, interval_seconds: int = 300):
    """
    Background task that periodically cleans up stale sessions.
    Run this with asyncio.create_task() on startup.
    """
    logger.info(f"Starting session cleanup task (interval={interval_seconds}s)")
    while True:
        await asyncio.sleep(interval_seconds)
        try:
            removed = await store.cleanup_stale_sessions()
            active = await store.get_active_session_count()
            if removed > 0 or active > 0:
                logger.debug(f"Session cleanup: removed={removed}, active={active}")
        except Exception as e:
            logger.exception(f"Session cleanup error: {e}")
