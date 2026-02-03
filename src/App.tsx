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
  timestamp: number;
}

const STORAGE_KEY = 'glados-voice-history';
const MAX_STORED_MESSAGES = 50;

// Load messages from localStorage
function loadMessages(): Message[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load messages:', e);
  }
  return [];
}

// Save messages to localStorage
function saveMessages(messages: Message[]) {
  try {
    // Keep only recent messages to avoid storage bloat
    const toStore = messages.slice(-MAX_STORED_MESSAGES);
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
  
  const { isRecording, startRecording, stopRecording, audioBlob, error } = useVoiceRecorder();

  // Save messages whenever they change
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

  // Handle audio blob when recording completes - with dedup
  useEffect(() => {
    if (audioBlob && !isRecording && audioBlob !== processedBlobRef.current) {
      processedBlobRef.current = audioBlob;
      handleAudioSubmit(audioBlob);
    }
  }, [audioBlob, isRecording]);

  const addMessage = useCallback((role: 'user' | 'assistant', text: string, audioUrl?: string) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      role,
      text,
      audioUrl,
      timestamp: Date.now(),
    }]);
  }, []);

  const playAudio = useCallback((url: string) => {
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
    addMessage('user', '🎤 [Voice message]');
    
    try {
      const response = await chatWithAudio(blob);
      const audioUrl = getAudioUrl(response.audio_url);
      addMessage('assistant', response.text, audioUrl);
      playAudio(audioUrl);
    } catch (err) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessing) return;

    const text = textInput.trim();
    setTextInput('');
    setIsProcessing(true);
    addMessage('user', text);

    try {
      const response = await chatWithText(text);
      const audioUrl = getAudioUrl(response.audio_url);
      addMessage('assistant', response.text, audioUrl);
      playAudio(audioUrl);
    } catch (err) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
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
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-text">
              {msg.role === 'assistant' ? (
                <ReactMarkdown>{msg.text}</ReactMarkdown>
              ) : (
                msg.text
              )}
            </div>
            {msg.audioUrl && (
              <button 
                className="play-button"
                onClick={() => playAudio(msg.audioUrl!)}
                aria-label="Play audio"
              >
                🔊
              </button>
            )}
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
