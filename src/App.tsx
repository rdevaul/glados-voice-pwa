import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useVoiceRecorder } from './hooks/useVoiceRecorder';
import { PushToTalkButton } from './components/PushToTalkButton';
import { chatWithText, chatWithAudio, getAudioUrl } from './api/voiceApi';
import './App.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
  audioBlobUrl?: string; // For user recordings (temporary, not persisted)
  timestamp: number;
  pending?: boolean;
}

const STORAGE_KEY = 'glados-voice-history';
const MAX_STORED_MESSAGES = 50;

function loadMessages(): Message[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      // Filter out any pending messages that weren't completed
      return JSON.parse(stored).filter((m: Message) => !m.pending);
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
  return [];
}

function saveMessages(messages: Message[]) {
  try {
    // Don't save audioBlobUrls (they're temporary) or pending messages
    const toStore = messages
      .filter(m => !m.pending)
      .slice(-MAX_STORED_MESSAGES)
      .map(({ audioBlobUrl, ...rest }) => rest);
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
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processedBlobRef = useRef<Blob | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  const { isRecording, startRecording, stopRecording, audioBlob, error } = useVoiceRecorder();

  // Save messages whenever they change (but not pending ones)
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  // Check/request mic permission on mount
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then(result => {
        setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
        result.onchange = () => setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
      })
      .catch(() => {
        setMicPermission('prompt');
      });
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle audio blob when recording completes
  useEffect(() => {
    if (audioBlob && !isRecording && audioBlob !== processedBlobRef.current) {
      processedBlobRef.current = audioBlob;
      handleAudioSubmit(audioBlob);
    }
  }, [audioBlob, isRecording]);

  // Cleanup abort controller on unmount
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
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = url;
    } else {
      audioRef.current = new Audio(url);
    }
    
    const audio = audioRef.current;
    audio.load();
    
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(err => {
        console.log('Autoplay blocked:', err);
      });
    }
  }, []);

  const handleAudioSubmit = async (blob: Blob) => {
    if (isProcessing) return;
    
    setIsProcessing(true);
    
    // Create a temporary URL for the user's recording
    const userAudioUrl = URL.createObjectURL(blob);
    
    // Add user message with pending transcript
    const userMsgId = addMessage('user', '🎤 Transcribing...', {
      audioBlobUrl: userAudioUrl,
      pending: true,
    });
    
    // Cancel any existing request
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    
    try {
      const response = await chatWithAudio(blob);
      const audioUrl = getAudioUrl(response.audio_url);
      
      // Update user message with transcript
      const transcript = response.user_text || '🎤 [Voice message]';
      updateMessage(userMsgId, { 
        text: transcript, 
        pending: false 
      });
      
      // Add assistant response
      addMessage('assistant', response.text, { audioUrl });
      playAudio(audioUrl);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Request was cancelled, don't show error
        return;
      }
      
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      
      // Update user message to show it was sent
      updateMessage(userMsgId, { 
        text: '🎤 [Voice message - transcript unavailable]', 
        pending: false 
      });
      
      // Add error message with retry option
      addMessage('assistant', `Error: ${errorMsg}. Tap to retry or send another message.`);
    } finally {
      setIsProcessing(false);
      abortControllerRef.current = null;
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
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
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      
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
    if (micPermission === 'prompt') {
      requestMicPermission();
    } else if (micPermission === 'granted') {
      startRecording();
    }
  };

  const clearHistory = () => {
    if (confirm('Clear conversation history?')) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🎂 GLaDOS</h1>
        {messages.length > 0 && (
          <button className="clear-button" onClick={clearHistory} title="Clear history">
            🗑️
          </button>
        )}
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            {micPermission === 'prompt' ? (
              <>Tap the mic button to enable voice, or type below.</>
            ) : micPermission === 'denied' ? (
              <>Mic access denied. Use text input below.</>
            ) : (
              <>Hold the button to talk, or type below.</>
            )}
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role} ${msg.pending ? 'pending' : ''}`}>
            <div className="message-text">
              {msg.role === 'assistant' ? (
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              ) : (
                msg.text
              )}
            </div>
            <div className="message-actions">
              {/* User voice message playback */}
              {msg.audioBlobUrl && (
                <button 
                  className="play-button"
                  onClick={() => playAudio(msg.audioBlobUrl!)}
                  aria-label="Play your recording"
                  title="Play your recording"
                >
                  🎤
                </button>
              )}
              {/* Assistant audio playback */}
              {msg.audioUrl && (
                <button 
                  className="play-button"
                  onClick={() => playAudio(msg.audioUrl!)}
                  aria-label="Play response"
                  title="Play response"
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
          onStopRecording={stopRecording}
          disabled={isProcessing || micPermission === 'denied'}
        />
        
        <form className="text-input-form" onSubmit={handleTextSubmit}>
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Or type here..."
            disabled={isProcessing}
          />
          <button type="submit" disabled={isProcessing || !textInput.trim()}>
            Send
          </button>
        </form>
      </footer>
    </div>
  );
}

export default App;
