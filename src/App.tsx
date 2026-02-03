import { useState, useEffect, useRef } from 'react';
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
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { isRecording, startRecording, stopRecording, audioBlob, error } = useVoiceRecorder();

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle audio blob when recording completes
  useEffect(() => {
    if (audioBlob && !isRecording) {
      handleAudioSubmit(audioBlob);
    }
  }, [audioBlob, isRecording]);

  const addMessage = (role: 'user' | 'assistant', text: string, audioUrl?: string) => {
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role,
      text,
      audioUrl,
    }]);
  };

  const handleAudioSubmit = async (blob: Blob) => {
    setIsProcessing(true);
    addMessage('user', '🎤 [Voice message]');
    
    try {
      const response = await chatWithAudio(blob);
      addMessage('assistant', response.text, getAudioUrl(response.audio_url));
      
      // Auto-play response
      playAudio(getAudioUrl(response.audio_url));
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
      addMessage('assistant', response.text, getAudioUrl(response.audio_url));
      
      // Auto-play response
      playAudio(getAudioUrl(response.audio_url));
    } catch (err) {
      addMessage('assistant', `Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const playAudio = (url: string) => {
    if (currentAudio) {
      currentAudio.pause();
    }
    const audio = new Audio(url);
    setCurrentAudio(audio);
    audio.play().catch(console.error);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🎂 GLaDOS</h1>
      </header>

      <main className="messages">
        {messages.length === 0 && (
          <div className="empty-state">
            Hold the button to talk, or type below.
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-text">{msg.text}</div>
            {msg.audioUrl && (
              <button 
                className="play-button"
                onClick={() => playAudio(msg.audioUrl!)}
              >
                ▶️
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
          onStartRecording={startRecording}
          onStopRecording={stopRecording}
          disabled={isProcessing}
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
