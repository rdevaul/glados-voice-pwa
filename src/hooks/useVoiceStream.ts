/**
 * WebSocket-based voice streaming hook.
 * Supports session persistence and reconnection across app switches.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  saveSessionState,
  getSavedSessionId,
} from '../utils/sessionPersistence';
import type { PersistedSession } from '../utils/sessionPersistence';

export interface ServerMessage {
  message_id: string;
  text: string;
  audio_url?: string;
  media_url?: string;
  reason: 'follow_up' | 'correction' | 'proactive' | 'continuation';
}

export interface ProcessingStatus {
  message: string;
  elapsedSeconds: number;
}

export interface UseVoiceStreamReturn {
  status: 'disconnected' | 'connecting' | 'ready' | 'recording' | 'processing' | 'reconnecting';
  sessionId: string | null;
  partialTranscript: string;
  finalTranscript: string;
  responseText: string;
  responseComplete: boolean;
  responseMediaUrl: string | null;
  audioQueue: string[];
  serverMessages: ServerMessage[];
  processingStatus: ProcessingStatus | null;
  error: string | null;
  connect: () => void;
  disconnect: () => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  sendText: (text: string) => void;
  cancel: () => void;
  clearResponse: () => void;
  clearServerMessages: () => void;
}

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];

export function useVoiceStream(wsUrl: string): UseVoiceStreamReturn {
  const [status, setStatus] = useState<UseVoiceStreamReturn['status']>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [partialTranscript, setPartialTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [responseText, setResponseText] = useState('');
  const [responseComplete, setResponseComplete] = useState(false);
  const [responseMediaUrl, setResponseMediaUrl] = useState<string | null>(null);
  const [audioQueue, setAudioQueue] = useState<string[]>([]);
  const [serverMessages, setServerMessages] = useState<ServerMessage[]>([]);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isRecordingRef = useRef(false);
  const reconnectDelayIndexRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const isReconnectingRef = useRef(false);
  const pongReceivedRef = useRef(false);
  const pingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save session state for persistence
  const saveState = useCallback(() => {
    if (!sessionIdRef.current) return;
    
    const state: PersistedSession = {
      sessionId: sessionIdRef.current,
      lastActivity: Date.now(),
      state: status === 'recording' ? 'recording' : 
             status === 'processing' ? 'processing' : 'idle',
      partialTranscript,
      partialResponse: responseText,
      audioQueueUrls: audioQueue,
    };
    saveSessionState(state);
  }, [status, partialTranscript, responseText, audioQueue]);

  // Build WebSocket URL with session ID for reconnection
  // Safari-compatible: avoid URL constructor issues
  const buildWsUrl = useCallback((sid?: string | null) => {
    try {
      const url = new URL(wsUrl);
      if (sid) {
        url.searchParams.set('session_id', sid);
      }
      return url.toString();
    } catch (e) {
      // Fallback for Safari URL parsing issues
      console.warn('URL parsing failed, using fallback:', e);
      if (sid) {
        const separator = wsUrl.includes('?') ? '&' : '?';
        return `${wsUrl}${separator}session_id=${encodeURIComponent(sid)}`;
      }
      return wsUrl;
    }
  }, [wsUrl]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    shouldReconnectRef.current = true;
    setError(null);

    // Check for existing session to restore
    const savedSessionId = getSavedSessionId();
    if (savedSessionId && !isReconnectingRef.current) {
      isReconnectingRef.current = true;
      setStatus('reconnecting');
    } else {
      setStatus('connecting');
    }
    
    const connectUrl = buildWsUrl(savedSessionId);
    console.log('Connecting to:', connectUrl);
    
    // Safari detection for debugging
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      console.log('Safari detected - using compatibility mode');
    }
    
    let ws: WebSocket;
    try {
      ws = new WebSocket(connectUrl);
    } catch (e) {
      console.error('WebSocket constructor failed:', e);
      setError(`Failed to create WebSocket: ${e instanceof Error ? e.message : 'Unknown error'}`);
      setStatus('disconnected');
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected successfully');
      reconnectDelayIndexRef.current = 0;
      // Don't set ready here - wait for 'ready' or 'session_restored' message
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'pong':
            // Connection verified after visibility change
            console.log('Pong received, connection verified');
            pongReceivedRef.current = true;
            if (pingTimeoutRef.current) {
              clearTimeout(pingTimeoutRef.current);
              pingTimeoutRef.current = null;
            }
            break;
            
          case 'ready':
            setSessionId(data.session_id);
            sessionIdRef.current = data.session_id;
            setStatus('ready');
            setError(null);  // Clear any previous connection errors
            isReconnectingRef.current = false;
            // Save initial session state
            saveSessionState({
              sessionId: data.session_id,
              lastActivity: Date.now(),
              state: 'idle',
            });
            break;
            
          case 'session_restored':
            // Session successfully restored after reconnect
            setSessionId(data.session_id);
            sessionIdRef.current = data.session_id;
            setStatus(data.state === 'processing' ? 'processing' : 'ready');
            setError(null);  // Clear any previous connection errors
            isReconnectingRef.current = false;
            
            // Restore partial state
            if (data.partial_transcript) {
              setPartialTranscript(data.partial_transcript);
            }
            if (data.partial_response) {
              setResponseText(data.partial_response);
            }
            
            // Process any pending messages
            if (data.pending_messages && data.pending_messages.length > 0) {
              console.log('Processing pending messages:', data.pending_messages.length);
              data.pending_messages.forEach((msg: any) => {
                handleIncomingMessage(msg);
              });
            }
            break;
            
          case 'partial_transcript':
            setPartialTranscript(data.text);
            break;
            
          case 'final_transcript':
            setFinalTranscript(data.text);
            setPartialTranscript('');
            break;
            
          case 'response_chunk':
            setResponseText(data.accumulated || data.text);
            setStatus('processing');
            break;
            
          case 'response_complete':
            setResponseText(data.text);
            setResponseComplete(true);
            setResponseMediaUrl(data.media_url || null);
            setProcessingStatus(null);  // Clear processing status on completion
            if (data.audio_url) {
              setAudioQueue(prev => [...prev, data.audio_url]);
            }
            setStatus('ready');
            break;
            
          case 'processing_status':
            // Progress update for long-running requests
            setProcessingStatus({
              message: data.message,
              elapsedSeconds: data.elapsed_seconds,
            });
            break;
            
          case 'server_message':
            // Server-initiated message (follow-up, correction, proactive)
            setServerMessages(prev => [...prev, {
              message_id: data.message_id,
              text: data.text,
              audio_url: data.audio_url,
              media_url: data.media_url,
              reason: data.reason || 'follow_up',
            }]);
            if (data.audio_url) {
              setAudioQueue(prev => [...prev, data.audio_url]);
            }
            break;
            
          case 'error':
            setError(data.message || 'Unknown error');
            setStatus('ready');
            break;
            
          default:
            console.log('Unknown message type:', data.type);
        }
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      
      // Save state before attempting reconnect
      saveState();
      
      if (shouldReconnectRef.current) {
        const delay = RECONNECT_DELAYS[Math.min(reconnectDelayIndexRef.current, RECONNECT_DELAYS.length - 1)];
        reconnectDelayIndexRef.current++;
        
        setStatus('reconnecting');
        
        setTimeout(() => {
          if (shouldReconnectRef.current) {
            connect();
          }
        }, delay);
      } else {
        setStatus('disconnected');
      }
    };

    ws.onerror = (event) => {
      // Safari often gives minimal error info - log everything available
      console.error('WebSocket error:', event);
      console.error('WebSocket readyState:', ws.readyState);
      console.error('WebSocket url:', ws.url);
      
      // More descriptive error for Safari
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      if (isSafari) {
        setError('WebSocket connection error (Safari). Try using Chrome for better compatibility.');
      } else {
        setError('WebSocket connection error');
      }
    };
  }, [wsUrl, buildWsUrl, saveState]);

  // Helper to process incoming messages (used for pending messages on restore)
  const handleIncomingMessage = useCallback((msg: any) => {
    switch (msg.type) {
      case 'response_chunk':
        setResponseText(msg.accumulated || msg.text);
        break;
      case 'response_complete':
        setResponseText(msg.text);
        setResponseComplete(true);
        if (msg.audio_url) {
          setAudioQueue(prev => [...prev, msg.audio_url]);
        }
        setStatus('ready');
        break;
      case 'server_message':
        setServerMessages(prev => [...prev, {
          message_id: msg.message_id,
          text: msg.text,
          audio_url: msg.audio_url,
          reason: msg.reason || 'follow_up',
        }]);
        if (msg.audio_url) {
          setAudioQueue(prev => [...prev, msg.audio_url]);
        }
        break;
    }
  }, []);

  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    
    // Save state before disconnect
    saveState();
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    setStatus('disconnected');
  }, [saveState]);

  const startRecording = useCallback(async () => {
    // Prevent overlapping recordings with ref (avoids stale closure)
    if (isRecordingRef.current) {
      console.warn('Recording already in progress, ignoring start request');
      return;
    }

    // Clean up any stale recorder before starting
    if (mediaRecorderRef.current) {
      try {
        if (mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
      } catch (e) {
        console.warn('Error stopping stale recorder:', e);
      }
      mediaRecorderRef.current = null;
    }

    // Clean up any stale stream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Set recording lock immediately
    isRecordingRef.current = true;

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket not connected');
      isRecordingRef.current = false;
      return;
    }
    
    // Allow recording anytime except when already recording
    // (async model: don't block on processing/waiting for response)
    if (status === 'recording') {
      isRecordingRef.current = false;
      return;
    }

    try {
      // Get microphone access
      // Enable browser-level audio processing for better quality
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      streamRef.current = stream;

      // Determine best supported format
      let mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4'; // Safari fallback
      }

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;

      // Send audio_start message
      wsRef.current.send(JSON.stringify({ 
        type: 'audio_start', 
        format: mimeType.split('/')[1].split(';')[0] // 'webm' or 'mp4'
      }));

      // Stream audio chunks to server
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      mediaRecorder.onerror = (e) => {
        console.error('MediaRecorder error:', e);
        setError('Recording failed');
        setStatus('ready');
      };

      // Start recording with 250ms chunks
      mediaRecorder.start(250);
      setStatus('recording');
      
      // Async model: don't clear previous responses - let them accumulate
      // Only clear transcript state for the new recording
      setPartialTranscript('');
      setFinalTranscript('');

    } catch (err) {
      isRecordingRef.current = false;
      const message = err instanceof Error ? err.message : 'Failed to start recording';
      setError(message);
      console.error('Recording error:', err);
    }
  }, [status]);

  const stopRecording = useCallback(() => {
    if (!isRecordingRef.current && !mediaRecorderRef.current) return;

    // Release lock immediately to allow new recordings
    // (cleanup code handles any stale recorders)
    isRecordingRef.current = false;

    if (!mediaRecorderRef.current) return;

    const recorder = mediaRecorderRef.current;
    const ws = wsRef.current;

    if (recorder.state !== 'inactive') {
      // Request any pending data before stopping
      recorder.requestData();
      
      // Wait for final chunks to be sent, then signal end
      setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
        
        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }

        // Send audio_end message after final chunks have been sent
        setTimeout(() => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio_end' }));
          }
        }, 100);
      }, 150);
    } else {
      // Already inactive, just cleanup
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio_end' }));
      }
    }

    mediaRecorderRef.current = null;
    // Async model: return to ready immediately so user can record again
    // Don't wait for response - it will arrive and display asynchronously
    setStatus('ready');
  }, []);

  const sendText = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket not connected');
      return;
    }
    
    // Allow sending text anytime (except while recording)
    if (status === 'recording') return;

    wsRef.current.send(JSON.stringify({ type: 'text', content: text }));
    // Async model: stay ready, don't block on response
    // Response will arrive asynchronously
  }, [status]);

  const cancel = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'cancel' }));
    }

    // Stop recording if active
    if (mediaRecorderRef.current?.state !== 'inactive') {
      mediaRecorderRef.current?.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setPartialTranscript('');
    setFinalTranscript('');
    setResponseText('');
    setResponseComplete(false);
    setProcessingStatus(null);
    setStatus('ready');
  }, []);

  const clearResponse = useCallback(() => {
    setResponseText('');
    setResponseComplete(false);
    setResponseMediaUrl(null);
    setAudioQueue([]);
  }, []);

  const clearServerMessages = useCallback(() => {
    setServerMessages([]);
  }, []);

  // Handle visibility changes (app switch on mobile)
  // Mobile browsers often keep WebSocket "OPEN" even when connection is dead
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // App going to background - save state
        console.log('App hidden, saving session state');
        saveState();
        
        // Clear any pending ping timeout
        if (pingTimeoutRef.current) {
          clearTimeout(pingTimeoutRef.current);
          pingTimeoutRef.current = null;
        }
      } else {
        // App returning to foreground - always verify connection is alive
        console.log('App visible, verifying connection...');
        
        if (!shouldReconnectRef.current) return;
        
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          // Connection obviously dead, reconnect immediately
          console.log('Connection closed, reconnecting...');
          setStatus('reconnecting');
          connect();
          return;
        }
        
        // Connection appears open - send ping to verify it's alive
        // Mobile browsers often show OPEN for stale connections
        pongReceivedRef.current = false;
        
        try {
          wsRef.current.send(JSON.stringify({ type: 'ping' }));
          console.log('Sent ping to verify connection');
        } catch (e) {
          // Send failed, connection is dead
          console.log('Ping send failed, reconnecting...');
          setStatus('reconnecting');
          connect();
          return;
        }
        
        // Wait for pong - if no response in 3s, force reconnect
        pingTimeoutRef.current = setTimeout(() => {
          if (!pongReceivedRef.current && shouldReconnectRef.current) {
            console.log('No pong received, connection stale - reconnecting...');
            // Force close the stale connection
            if (wsRef.current) {
              wsRef.current.close();
              wsRef.current = null;
            }
            setStatus('reconnecting');
            connect();
          }
        }, 3000);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (pingTimeoutRef.current) {
        clearTimeout(pingTimeoutRef.current);
      }
    };
  }, [saveState, connect]);

  // Cleanup on unmount ONLY - empty deps array means this only runs on unmount
  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      isRecordingRef.current = false;
      
      if (wsRef.current) {
        wsRef.current.close();
      }
      
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stop();
      }
      
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);  // Empty array = only on unmount, not on state changes

  return {
    status,
    sessionId,
    partialTranscript,
    finalTranscript,
    responseText,
    responseComplete,
    responseMediaUrl,
    audioQueue,
    serverMessages,
    processingStatus,
    error,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    sendText,
    cancel,
    clearResponse,
    clearServerMessages,
  };
}
