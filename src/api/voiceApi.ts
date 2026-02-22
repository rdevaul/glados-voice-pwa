const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8100';

export interface ChatResponse {
  user_text?: string;
  text: string;
  audio_url: string;
}

export async function chatWithText(text: string): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/voice/chat/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

export async function chatWithAudio(audioBlob: Blob): Promise<ChatResponse> {
  const formData = new FormData();
  formData.append('file', audioBlob, 'recording.webm');
  
  const response = await fetch(`${API_BASE}/voice/chat/audio`, {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  
  return response.json();
}

export function getAudioUrl(path: string): string {
  // If path is already a full URL, return as-is
  if (path.startsWith('http')) return path;
  // Otherwise, prepend the API base
  return `${API_BASE}${path}`;
}
