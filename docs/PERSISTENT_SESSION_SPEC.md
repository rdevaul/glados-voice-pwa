# Persistent Session & Multi-Message Spec

## Overview

Enhance the Voice PWA to support:
1. **Session continuity** — survive app switches without losing state
2. **Multi-message replies** — server can send multiple messages per interaction
3. **Server-initiated messages** — proactive messaging while PWA is open

## Current Architecture

```
User speaks → WebSocket → Transcribe → OpenClaw → TTS → Single response
```

**Limitations:**
- WebSocket disconnects on background (mobile browsers suspend)
- In-progress state lost on disconnect
- Server can only respond once per request
- No way to send follow-ups or corrections

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PWA Client                               │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │ Visibility  │  │ Session      │  │ Message Queue           │ │
│  │ Handler     │──│ Persistence  │──│ (localStorage)          │ │
│  └─────────────┘  └──────────────┘  └─────────────────────────┘ │
│         │                │                      │               │
│         └────────────────┼──────────────────────┘               │
│                          ▼                                      │
│                 ┌─────────────────┐                             │
│                 │ WebSocket       │◄──── reconnect with         │
│                 │ Connection      │      session_id             │
│                 └────────┬────────┘                             │
└──────────────────────────┼──────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                         Backend                                   │
├──────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │ Session Store   │  │ Message Queue   │  │ OpenClaw         │  │
│  │ (Redis/Memory)  │──│ (per session)   │──│ Integration      │  │
│  └─────────────────┘  └─────────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

## Protocol Changes

### New Message Types

**Client → Server:**

```typescript
// Reconnect with existing session
{ type: 'reconnect', session_id: string }

// Acknowledge receipt of server message
{ type: 'ack', message_id: string }
```

**Server → Client:**

```typescript
// Session restored (after reconnect)
{ 
  type: 'session_restored', 
  session_id: string,
  pending_messages: Message[],  // Messages queued while disconnected
  state: 'idle' | 'processing'  // Current session state
}

// Server-initiated message (proactive, follow-up, correction)
{
  type: 'server_message',
  message_id: string,
  text: string,
  audio_url?: string,
  reason: 'follow_up' | 'correction' | 'proactive' | 'continuation'
}

// Indicate more messages coming
{
  type: 'response_chunk',
  text: string,
  accumulated: string,
  final: false  // NEW: signals more chunks/messages may follow
}

// Final message in a sequence
{
  type: 'response_complete',
  text: string,
  audio_url?: string,
  more_coming: boolean  // NEW: true if server may send follow-ups
}
```

## Implementation Tasks

### Phase 1: Session Continuity (~2-3 hrs)

**Backend:**

1. **Session Store** (`backend/src/session_store.py`)
   ```python
   class SessionStore:
       sessions: dict[str, Session]
       
       def create(self) -> str: ...  # Returns session_id
       def get(self, session_id: str) -> Session | None: ...
       def update_state(self, session_id: str, state: dict): ...
       def queue_message(self, session_id: str, msg: dict): ...
       def get_pending(self, session_id: str) -> list[dict]: ...
       def cleanup_stale(self, max_age_seconds: int = 3600): ...
   ```

2. **WebSocket handler changes** (`backend/src/websocket.py`)
   - Generate `session_id` on new connection
   - Handle `reconnect` message type
   - Store in-progress transcription/response state
   - Replay pending messages on reconnect

**Frontend:**

3. **Visibility handling** (`src/hooks/useVoiceStream.ts`)
   ```typescript
   // On visibility hidden
   document.addEventListener('visibilitychange', () => {
     if (document.hidden) {
       // Save state to localStorage
       saveSessionState({ sessionId, pendingTranscript, ... });
       // Keep connection alive if possible, but expect disconnect
     } else {
       // On visible: reconnect if needed, restore state
       if (!isConnected) {
         reconnectWithSession(savedSessionId);
       }
     }
   });
   ```

4. **Session persistence** (`src/utils/sessionPersistence.ts`)
   ```typescript
   interface PersistedSession {
     sessionId: string;
     lastActivity: number;
     pendingUserMessage?: string;
     partialResponse?: string;
   }
   
   function saveSession(state: PersistedSession): void;
   function loadSession(): PersistedSession | null;
   function clearSession(): void;
   ```

### Phase 2: Multi-Message Replies (~2-3 hrs)

**Backend:**

5. **OpenClaw integration update** (`backend/src/stream_response.py`)
   - Detect when response contains multiple logical messages
   - Support `<!-- MORE -->` or similar delimiter in response
   - Send separate `server_message` for each segment
   - Generate TTS for each segment independently

6. **Message queue per session**
   - Queue messages if client temporarily disconnected
   - Deliver on reconnect or next poll
   - TTL of ~5 minutes for queued messages

**Frontend:**

7. **Handle server-initiated messages** (`src/hooks/useVoiceStream.ts`)
   ```typescript
   case 'server_message':
     // Append to message list (not replace)
     addMessage({
       role: 'assistant',
       text: data.text,
       audioUrl: data.audio_url,
       messageType: data.reason
     });
     // Play audio
     if (data.audio_url) {
       audioQueue.enqueue(getAudioUrl(data.audio_url));
     }
     break;
   ```

8. **UI for multi-message** (`src/App.tsx`)
   - Show "typing" indicator if `more_coming: true`
   - Handle rapid sequential messages gracefully
   - Audio queue already supports this!

### Phase 3: Polish & Edge Cases (~1-2 hrs)

9. **Heartbeat/keepalive**
   - Client sends ping every 30s
   - Server responds with pong + session state
   - Detects zombie connections

10. **Graceful degradation**
    - If reconnect fails 3x, start fresh session
    - Show "Reconnecting..." UI state
    - Don't lose user's last message if possible

11. **Session timeout handling**
    - Sessions expire after 1 hour of inactivity
    - Client notified via `session_expired` message
    - Prompt to start new session

## File Changes Summary

| File | Changes |
|------|---------|
| `backend/src/session_store.py` | NEW: Session state management |
| `backend/src/websocket.py` | Add reconnect, session persistence |
| `backend/src/stream_response.py` | Multi-message detection and sending |
| `src/hooks/useVoiceStream.ts` | Visibility API, reconnect logic, server_message handling |
| `src/utils/sessionPersistence.ts` | NEW: localStorage session state |
| `src/App.tsx` | UI for reconnecting state, multi-message display |

## Testing Checklist

- [ ] Connect → switch apps → return → still connected or reconnected
- [ ] Mid-transcription app switch → transcript preserved
- [ ] Mid-response app switch → response completed on return
- [ ] Server sends 2 messages → both displayed, both have audio
- [ ] 5-minute idle → session still valid
- [ ] 1-hour idle → session expired, fresh start
- [ ] Airplane mode → reconnect when back online
- [ ] Force-kill PWA → reopen → reasonable state

## Future: Web Push Notifications

Once persistent WebSocket is solid, we can add Web Push for true proactive messaging (PWA closed):

1. Service worker registration
2. VAPID key generation
3. Push subscription flow
4. Backend notification dispatch
5. Notification → open PWA with context

This is Phase 4, after the core session work is stable.

---

*Estimated total: 5-8 hours across 3 phases*
