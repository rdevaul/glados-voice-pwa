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
  reason: 'follow_up' | 'correction' | 'proactive' | 'continuation';
}

export interface UseVoiceStreamReturn {
  status: 'disconnected' | 'connecting' | 'ready' | 'recording' | 'processing' | 'reconnecting';
  sessionId: string | null;
  partialTranscript: string;
  finalTranscript: string;
  responseText: string;
  responseComplete: boolean;
  audioQueue: string[];
  serverMessages: ServerMessage[];
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
  const [audioQueue, setAudioQueue] = useState<string[]>([]);
  const [serverMessages, setServerMessages] = useState<ServerMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const reconnectDelayIndexRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const isReconnectingRef = useRef(false);

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
  const buildWsUrl = useCallback((sid?: string | null) => {
    const url = new URL(wsUrl);
    if (sid) {
      url.searchParams.set('session_id', sid);
    }
    return url.toString();
  }, [wsUrl]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    
    shouldReconnectRef.current = true;
    
    // Check for existing session to restore
    const savedSessionId = getSavedSessionId();
    if (savedSessionId && !isReconnectingRef.current) {
      isReconnectingRef.current = true;
      setStatus('reconnecting');
    } else {
      setStatus('connecting');
    }
    setError(null);

    const connectUrl = buildWsUrl(savedSessionId);
    console.log('Connecting to:', connectUrl);
    
    const ws = new WebSocket(connectUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelayIndexRef.current = 0;
      // Don't set ready here - wait for 'ready' or 'session_restored' message
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'ready':
            setSessionId(data.session_id);
            sessionIdRef.current = data.session_id;
            setStatus('ready');
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
            if (data.audio_url) {
              setAudioQueue(prev => [...prev, data.audio_url]);
            }
            setStatus('ready');
            break;
            
          case 'server_message':
            // Server-initiated message (follow-up, correction, proactive)
            setServerMessages(prev => [...prev, {
              message_id: data.message_id,
              text: data.text,
              audio_url: data.audio_url,
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
      console.error('WebSocket error:', event);
      setError('WebSocket connection error');
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
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket not connected');
      return;
    }
    
    if (status !== 'ready') return;

    try {
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      
      // Clear previous response
      setResponseText('');
      setResponseComplete(false);
      setPartialTranscript('');
      setFinalTranscript('');

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start recording';
      setError(message);
      console.error('Recording error:', err);
    }
  }, [status]);

  const stopRecording = useCallback(() => {
    if (!mediaRecorderRef.current) return;

    if (mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    // Stop all tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Send audio_end message
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'audio_end' }));
    }

    mediaRecorderRef.current = null;
    setStatus('processing');
  }, []);

  const sendText = useCallback((text: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError('WebSocket not connected');
      return;
    }
    
    if (status !== 'ready') return;

    wsRef.current.send(JSON.stringify({ type: 'text', content: text }));
    setStatus('processing');
    
    // Clear previous response
    setResponseText('');
    setResponseComplete(false);
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
    setStatus('ready');
  }, []);

  const clearResponse = useCallback(() => {
    setResponseText('');
    setResponseComplete(false);
    setAudioQueue([]);
  }, []);

  const clearServerMessages = useCallback(() => {
    setServerMessages([]);
  }, []);

  // Handle visibility changes (app switch on mobile)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // App going to background - save state
        console.log('App hidden, saving session state');
        saveState();
      } else {
        // App returning to foreground
        console.log('App visible, checking connection');
        if (wsRef.current?.readyState !== WebSocket.OPEN && shouldReconnectRef.current) {
          // Connection lost while in background, reconnect
          console.log('Connection lost, reconnecting...');
          setStatus('reconnecting');
          connect();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [saveState, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      
      // Save state before unmount
      if (sessionIdRef.current) {
        saveState();
      }
      
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
  }, [saveState]);

  return {
    status,
    sessionId,
    partialTranscript,
    finalTranscript,
    responseText,
    responseComplete,
    audioQueue,
    serverMessages,
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
