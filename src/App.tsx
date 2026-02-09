import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useVoiceRecorder } from './hooks/useVoiceRecorder';
import { useVoiceStream } from './hooks/useVoiceStream';
import { PushToTalkButton } from './components/PushToTalkButton';
import { chatWithText, chatWithAudio, getAudioUrl } from './api/voiceApi';
import { getAudioQueue } from './utils/audioQueue';
import './App.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  audioBlobUrl?: string;
  mediaUrl?: string;  // Images or video URLs
  timestamp: number;
  pending?: boolean;
  streaming?: boolean;
}

// Helper to detect media type from URL
function getMediaType(url: string): 'image' | 'video' | 'unknown' {
  const lower = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|webm|mov|m4v)(\?|$)/.test(lower)) return 'video';
  // Check for common image/video hosting patterns
  if (lower.includes('imgur.com') || lower.includes('i.redd.it')) return 'image';
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'video';
  return 'unknown';
}

const STORAGE_KEY = 'glados-voice-history';
const MAX_STORED_MESSAGES = 50;

// WebSocket URL for streaming mode
const WS_URL = import.meta.env.VITE_WS_URL || 
  `wss://${window.location.hostname}:8444/voice/stream`;

// Feature flag for streaming mode
const STREAMING_ENABLED = import.meta.env.VITE_STREAMING_ENABLED !== 'false';

function loadMessages(): Message[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored).filter((m: Message) => !m.pending && !m.streaming);
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
  return [];
}

function saveMessages(messages: Message[]) {
  try {
    const toStore = messages
      .filter(m => !m.pending && !m.streaming)
      .slice(-MAX_STORED_MESSAGES)
      .map(({ audioBlobUrl, streaming, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
  } catch (e) {
    console.error('Failed to save messages:', e);
  }
}

function App() {
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [textInput, setTextInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [micPermission, setMicPermission] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  const [useStreaming, setUseStreaming] = useState(STREAMING_ENABLED);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processedBlobRef = useRef<Blob | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentAssistantMsgRef = useRef<string | null>(null);
  
  // Batch mode hooks
  const { isRecording: batchIsRecording, startRecording: batchStartRecording, 
          stopRecording: batchStopRecording, audioBlob, error: batchError } = useVoiceRecorder();
  
  // Streaming mode hooks
  const stream = useVoiceStream(WS_URL);
  const audioQueue = useRef(getAudioQueue());

  // Determine which mode we're using
  const isRecording = useStreaming ? stream.status === 'recording' : batchIsRecording;
  const error = useStreaming ? stream.error : batchError;
  const isConnected = stream.status !== 'disconnected' && stream.status !== 'reconnecting';
  const isReconnecting = stream.status === 'reconnecting';
  const isStreamProcessing = stream.status === 'processing';

  // Track if we've initiated connection to avoid loops
  const connectionInitiated = useRef(false);
  
  // Connect to WebSocket on mount if streaming enabled
  useEffect(() => {
    if (useStreaming && !connectionInitiated.current) {
      connectionInitiated.current = true;
      console.log('Initiating WebSocket connection...');
      stream.connect();
    }
    // No cleanup - let the hook handle its own WebSocket lifecycle
  }, [useStreaming, stream.connect]);

  // Save messages whenever they change
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  // Check mic permission on mount
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then(result => {
        setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
        result.onchange = () => setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
      })
      .catch(() => setMicPermission('prompt'));
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle streaming transcript updates
  useEffect(() => {
    if (!useStreaming) return;
    
    if (stream.finalTranscript) {
      // Update user message with final transcript
      setMessages(prev => prev.map(m => 
        m.pending && m.role === 'user' 
          ? { ...m, text: stream.finalTranscript, pending: false }
          : m
      ));
    } else if (stream.partialTranscript) {
      // Update user message with partial transcript
      setMessages(prev => prev.map(m => 
        m.pending && m.role === 'user' 
          ? { ...m, text: `🎤 ${stream.partialTranscript}` }
          : m
      ));
    }
  }, [stream.partialTranscript, stream.finalTranscript, useStreaming]);

  // Handle streaming response updates (including processing status)
  useEffect(() => {
    if (!useStreaming) return;
    
    const msgId = currentAssistantMsgRef.current;
    
    // Show processing status while waiting for response
    if (stream.processingStatus && msgId && !stream.responseText) {
      setMessages(prev => prev.map(m => 
        m.id === msgId
          ? { 
              ...m, 
              text: `⏳ ${stream.processingStatus?.message ?? 'Processing...'}`,
              streaming: true,
            }
          : m
      ));
    }
    
    if (stream.responseText) {
      const latestAudioUrl = stream.audioQueue.length > 0 
        ? getAudioUrl(stream.audioQueue[stream.audioQueue.length - 1])
        : undefined;
      
      if (msgId) {
        // Update existing assistant message with streaming text
        setMessages(prev => prev.map(m => 
          m.id === msgId
            ? { 
                ...m, 
                text: stream.responseText, 
                streaming: !stream.responseComplete,
                audioUrl: stream.responseComplete ? latestAudioUrl : m.audioUrl,
                mediaUrl: stream.responseComplete ? (stream.responseMediaUrl || m.mediaUrl) : m.mediaUrl
              }
            : m
        ));
      } else if (stream.responseComplete) {
        // No existing message (e.g., restored session) - create a new one
        const newId = `${Date.now()}-${Math.random()}`;
        setMessages(prev => [...prev, {
          id: newId,
          role: 'assistant',
          text: stream.responseText,
          audioUrl: latestAudioUrl,
          mediaUrl: stream.responseMediaUrl || undefined,
          timestamp: Date.now(),
          pending: false,
          streaming: false,
        }]);
      }
      
      // Clear state when complete
      if (stream.responseComplete) {
        setIsProcessing(false);
        currentAssistantMsgRef.current = null;
      }
    }
  }, [stream.responseText, stream.responseComplete, stream.responseMediaUrl, stream.audioQueue, stream.processingStatus, useStreaming]);

  // Handle server messages (additional messages from agent)
  const lastServerMsgCountRef = useRef(0);
  
  useEffect(() => {
    if (!useStreaming) return;
    
    // Only process new server messages
    const newMessages = stream.serverMessages.slice(lastServerMsgCountRef.current);
    lastServerMsgCountRef.current = stream.serverMessages.length;
    
    if (newMessages.length === 0) return;
    
    // Add each new server message as an assistant message
    newMessages.forEach(serverMsg => {
      const audioUrl = serverMsg.audio_url ? getAudioUrl(serverMsg.audio_url) : undefined;
      
      setMessages(prev => [...prev, {
        id: serverMsg.message_id,
        role: 'assistant',
        text: serverMsg.text,
        audioUrl,
        mediaUrl: serverMsg.media_url,
        timestamp: Date.now(),
        pending: false,
        streaming: false,
      }]);
      
      console.log('Added server message:', serverMsg.message_id, serverMsg.reason);
    });
    
  }, [stream.serverMessages, useStreaming]);

  // Handle audio queue for streaming responses
  const lastAudioIndexRef = useRef(0);
  const lastAudioQueueLengthRef = useRef(0);
  
  useEffect(() => {
    if (!useStreaming) return;
    
    // Detect if queue was cleared (length went to 0 or decreased significantly)
    if (stream.audioQueue.length === 0 || stream.audioQueue.length < lastAudioQueueLengthRef.current) {
      lastAudioIndexRef.current = 0;
    }
    lastAudioQueueLengthRef.current = stream.audioQueue.length;
    
    // Only process new audio URLs (avoid re-adding on every render)
    const newUrls = stream.audioQueue.slice(lastAudioIndexRef.current);
    newUrls.forEach(url => {
      const fullUrl = getAudioUrl(url);
      console.log('Enqueueing audio:', fullUrl);
      audioQueue.current.enqueue(fullUrl);
    });
    lastAudioIndexRef.current = stream.audioQueue.length;
  }, [stream.audioQueue, useStreaming]);

  // Handle batch mode audio blob
  useEffect(() => {
    if (!useStreaming && audioBlob && !batchIsRecording && audioBlob !== processedBlobRef.current) {
      processedBlobRef.current = audioBlob;
      handleBatchAudioSubmit(audioBlob);
    }
  }, [audioBlob, batchIsRecording, useStreaming]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }, []);

  const addMessage = useCallback((role: 'user' | 'assistant', text: string, extras?: Partial<Message>): string => {
    const id = `${Date.now()}-${Math.random()}`;
    setMessages(prev => [...prev, {
      id,
      role,
      text,
      timestamp: Date.now(),
      ...extras,
    }]);
    return id;
  }, []);

  const playAudio = useCallback((url: string) => {
    if (!url) return;
    
    // Warm up audio queue on first interaction
    audioQueue.current.warmUp();
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = url;
    } else {
      audioRef.current = new Audio(url);
    }
    
    audioRef.current.play().catch(err => console.log('Autoplay blocked:', err));
  }, []);

  // Streaming mode handlers
  const handleStreamingStart = async () => {
    if (stream.status !== 'ready') return;
    
    setIsProcessing(true);
    stream.clearResponse();
    
    // Add pending user message
    addMessage('user', '🎤 Recording...', { pending: true });
    
    // Add placeholder assistant message for streaming
    const assistantId = addMessage('assistant', '...', { streaming: true });
    currentAssistantMsgRef.current = assistantId;
    
    await stream.startRecording();
  };

  const handleStreamingStop = () => {
    stream.stopRecording();
  };

  const handleStreamingTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || stream.status !== 'ready') return;

    const text = textInput.trim();
    setTextInput('');
    setIsProcessing(true);
    stream.clearResponse();
    
    // Add user message
    addMessage('user', text);
    
    // Add placeholder assistant message
    const assistantId = addMessage('assistant', '...', { streaming: true });
    currentAssistantMsgRef.current = assistantId;
    
    stream.sendText(text);
  };

  // Batch mode handlers (existing logic)
  const handleBatchAudioSubmit = async (blob: Blob) => {
    if (isProcessing) return;
    
    setIsProcessing(true);
    const userAudioUrl = URL.createObjectURL(blob);
    const userMsgId = addMessage('user', '🎤 Transcribing...', {
      audioBlobUrl: userAudioUrl,
      pending: true,
    });
    
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    
    try {
      const response = await chatWithAudio(blob);
      const audioUrl = getAudioUrl(response.audio_url);
      
      updateMessage(userMsgId, { 
        text: response.user_text || '🎤 [Voice message]', 
        pending: false 
      });
      
      addMessage('assistant', response.text, { audioUrl });
      playAudio(audioUrl);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      
      updateMessage(userMsgId, { 
        text: '🎤 [Voice message - transcript unavailable]', 
        pending: false 
      });
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const handleBatchTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessing) return;

    const text = textInput.trim();
    setTextInput('');
    setIsProcessing(true);
    
    const userMsgId = addMessage('user', text, { pending: true });
    
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    try {
      const response = await chatWithText(text);
      const audioUrl = getAudioUrl(response.audio_url);
      
      updateMessage(userMsgId, { pending: false });
      addMessage('assistant', response.text, { audioUrl });
      playAudio(audioUrl);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      
      updateMessage(userMsgId, { pending: false });
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const requestMicPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      setMicPermission('granted');
    } catch {
      setMicPermission('denied');
    }
  };

  const handleStartRecording = () => {
    // Warm up audio on user gesture
    audioQueue.current.warmUp();
    
    if (micPermission === 'prompt') {
      requestMicPermission();
    } else if (micPermission === 'granted') {
      if (useStreaming) {
        handleStreamingStart();
      } else {
        batchStartRecording();
      }
    }
  };

  const handleStopRecording = () => {
    if (useStreaming) {
      handleStreamingStop();
    } else {
      batchStopRecording();
    }
  };

  const handleTextSubmit = useStreaming ? handleStreamingTextSubmit : handleBatchTextSubmit;

  const clearHistory = () => {
    if (confirm('Clear conversation history?')) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  const toggleStreamingMode = () => {
    if (useStreaming) {
      stream.disconnect();
    }
    setUseStreaming(!useStreaming);
  };

  // Connection status indicator
  const getStatusIcon = () => {
    if (!useStreaming) return '📡'; // Batch mode
    switch (stream.status) {
      case 'disconnected': return '🔴';
      case 'connecting': return '🟡';
      case 'reconnecting': return '🟠'; // Reconnecting after app switch
      case 'ready': return '🟢';
      case 'recording': return '🔴';
      case 'processing': return '🔵';
      default: return '⚪';
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🎂 GLaDOS</h1>
        <div className="header-controls">
          <button 
            className="status-button" 
            onClick={toggleStreamingMode}
            title={useStreaming ? `Streaming: ${stream.status}` : 'Batch mode'}
          >
            {getStatusIcon()}
          </button>
          {messages.length > 0 && (
            <button className="clear-button" onClick={clearHistory} title="Clear history">
              🗑️
            </button>
          )}
        </div>
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            {!useStreaming ? (
              <>Batch mode. Tap status icon to switch to streaming.</>
            ) : isReconnecting ? (
              <>🔄 Reconnecting...</>
            ) : !isConnected ? (
              <>Connecting to voice server...</>
            ) : micPermission === 'prompt' ? (
              <>Tap the mic button to enable voice, or type below.</>
            ) : micPermission === 'denied' ? (
              <>Mic access denied. Use text input below.</>
            ) : (
              <>Hold the button to talk, or type below.</>
            )}
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role} ${msg.pending ? 'pending' : ''} ${msg.streaming ? 'streaming' : ''}`}>
            <div className="message-text">
              {msg.role === 'assistant' ? (
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              ) : (
                msg.text
              )}
              {msg.streaming && <span className="typing-indicator">▋</span>}
            </div>
            {msg.mediaUrl && (
              <div className="message-media">
                {getMediaType(msg.mediaUrl) === 'image' ? (
                  <img 
                    src={msg.mediaUrl} 
                    alt="Response media" 
                    className="media-image"
                    loading="lazy"
                    onClick={() => window.open(msg.mediaUrl, '_blank')}
                  />
                ) : getMediaType(msg.mediaUrl) === 'video' ? (
                  <video 
                    src={msg.mediaUrl} 
                    className="media-video"
                    controls
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <a href={msg.mediaUrl} target="_blank" rel="noopener noreferrer" className="media-link">
                    📎 View attachment
                  </a>
                )}
              </div>
            )}
            <div className="message-actions">
              {msg.audioBlobUrl && (
                <button 
                  className="play-button"
                  onClick={() => playAudio(msg.audioBlobUrl!)}
                  aria-label="Play your recording"
                >
                  🎤
                </button>
              )}
              {msg.audioUrl && (
                <button 
                  className="play-button"
                  onClick={() => playAudio(msg.audioUrl!)}
                  aria-label="Play response"
                >
                  🔊
                </button>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </main>

      {error && <div className="error">{error}</div>}

      <footer className="controls">
        <PushToTalkButton
          isRecording={isRecording}
          onStartRecording={handleStartRecording}
          onStopRecording={handleStopRecording}
          disabled={isProcessing || isStreamProcessing || micPermission === 'denied' || (useStreaming && !isConnected)}
        />
        
        <form className="text-input-form" onSubmit={handleTextSubmit}>
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Or type here..."
            disabled={isProcessing || (useStreaming && !isConnected)}
          />
          <button 
            type="submit" 
            disabled={isProcessing || !textInput.trim() || (useStreaming && !isConnected)}
          >
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}

export default App;
