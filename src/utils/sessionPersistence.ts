/**
 * Session persistence utility for the Voice PWA.
 * Saves/restores WebSocket session state to localStorage
 * to survive app switches on mobile.
 */

const STORAGE_KEY = 'glados-voice-session';
const DEFAULT_MAX_AGE_MS = 3600000; // 1 hour

export interface PersistedSession {
  /** Server-assigned session ID */
  sessionId: string;
  /** Unix timestamp (ms) of last activity */
  lastActivity: number;
  /** Current session state */
  state: 'idle' | 'recording' | 'transcribing' | 'processing';
  /** User's message if mid-send */
  pendingUserMessage?: string;
  /** Partial transcription in progress */
  partialTranscript?: string;
  /** Partial response being received */
  partialResponse?: string;
  /** Audio URLs pending playback */
  audioQueueUrls?: string[];
}

/**
 * Check if localStorage is available.
 * Returns false in private browsing mode on some browsers.
 */
function isStorageAvailable(): boolean {
  try {
    const test = '__storage_test__';
    localStorage.setItem(test, test);
    localStorage.removeItem(test);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save current session state to localStorage.
 * Automatically updates lastActivity to current time.
 * 
 * @param state - Session state to persist
 */
export function saveSessionState(state: PersistedSession): void {
  if (!isStorageAvailable()) {
    console.warn('localStorage not available, session state will not persist');
    return;
  }

  try {
    const toStore: PersistedSession = {
      ...state,
      lastActivity: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.error('Failed to save session state:', e);
  }
}

/**
 * Load saved session state from localStorage.
 * Returns null if no session exists, session is expired, or parse fails.
 * 
 * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 * @returns Persisted session or null
 */
export function loadSessionState(maxAgeMs: number = DEFAULT_MAX_AGE_MS): PersistedSession | null {
  if (!isStorageAvailable()) {
    return null;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return null;
    }

    const session: PersistedSession = JSON.parse(stored);
    
    // Check if expired
    const age = Date.now() - session.lastActivity;
    if (age > maxAgeMs) {
      console.log(`Session expired (age=${Math.round(age / 1000)}s)`);
      clearSessionState();
      return null;
    }

    return session;
  } catch (e) {
    console.error('Failed to load session state:', e);
    clearSessionState();
    return null;
  }
}

/**
 * Clear saved session state from localStorage.
 */
export function clearSessionState(): void {
  if (!isStorageAvailable()) {
    return;
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear session state:', e);
  }
}

/**
 * Check if a valid (non-expired) saved session exists.
 * 
 * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
 * @returns true if a valid session exists
 */
export function hasSavedSession(maxAgeMs: number = DEFAULT_MAX_AGE_MS): boolean {
  return loadSessionState(maxAgeMs) !== null;
}

/**
 * Get just the session ID if one exists (without loading full state).
 * Returns null if no valid session.
 * 
 * @returns Session ID or null
 */
export function getSavedSessionId(): string | null {
  const session = loadSessionState();
  return session?.sessionId ?? null;
}

/**
 * Update specific fields in the persisted session without replacing everything.
 * Useful for incremental updates during streaming.
 * 
 * @param updates - Partial session state to merge
 */
export function updateSessionState(updates: Partial<PersistedSession>): void {
  const existing = loadSessionState();
  if (existing) {
    saveSessionState({ ...existing, ...updates });
  }
}
