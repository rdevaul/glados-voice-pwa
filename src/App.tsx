import { useState, useEffect, useRef, useCallback } from 'react';
import { useVoiceRecorder } from './hooks/useVoiceRecorder';
import { PushToTalkButton } from './components/PushToTalkButton';
import { chatWithText, chatWithAudio, getAudioUrl } from './api/voiceApi';
import './App.css';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  audioUrl?: string;
}

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [textInput, setTextInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [micPermission, setMicPermission] = useState<'prompt' | 'granted' | 'denied'>('prompt');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const processedBlobRef = useRef<Blob | null>(null);
  
  const { isRecording, startRecording, stopRecording, audioBlob, error } = useVoiceRecorder();

  // Check/request mic permission on mount
  useEffect(() => {
    navigator.permissions?.query({ name: 'microphone' as PermissionName })
      .then(result => {
        setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
        result.onchange = () => setMicPermission(result.state as 'prompt' | 'granted' | 'denied');
      })
      .catch(() => {
        // Safari doesn't support permissions API for mic
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
    }]);
  }, []);

  // Pre-warm audio for Safari autoplay
  const playAudio = useCallback((url: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = url;
    } else {
      audioRef.current = new Audio(url);
    }
    
    const audio = audioRef.current;
    audio.load();
    
    // Try to play - Safari may still block this
    const playPromise = audio.play();
    if (playPromise) {
      playPromise.catch(err => {
        console.log('Autoplay blocked:', err);
        // Audio will be available via play button
      });
    }
  }, []);

  const handleAudioSubmit = async (blob: Blob) => {
    if (isProcessing) return; // Prevent double submission
    
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

  // Request mic permission explicitly (tap-to-enable)
  const requestMicPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop()); // Release immediately
      setMicPermission('granted');
    } catch {
      setMicPermission('denied');
    }
  };

  const handleStartRecording = () => {
    if (micPermission === 'prompt') {
      // First time - this will show permission dialog
      // User will need to tap again after granting
      requestMicPermission();
    } else if (micPermission === 'granted') {
      startRecording();
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🎂 GLaDOS</h1>
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
            <div className="message-text">{msg.text}</div>
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
