"""
Chunked audio transcription using Whisper.
Buffers audio and transcribes in chunks for streaming partial results.
"""

import asyncio
import logging
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Optional, AsyncIterator, List

logger = logging.getLogger(__name__)


class ChunkedTranscriber:
    """
    Buffers incoming audio chunks and transcribes periodically.
    
    Usage:
        transcriber = ChunkedTranscriber()
        
        # Feed audio chunks as they arrive
        partial = await transcriber.feed_audio(chunk1)
        partial = await transcriber.feed_audio(chunk2)
        ...
        
        # Get final transcript
        final = await transcriber.finalize()
    """
    
    def __init__(
        self,
        chunk_duration_ms: int = 3000,
        overlap_ms: int = 500,
        model: str = "base",
        language: str = "en"
    ):
        self.chunk_duration_ms = chunk_duration_ms
        self.overlap_ms = overlap_ms
        self.model = model
        self.language = language
        
        self.audio_buffer = bytearray()
        self.audio_format: str = "webm"
        self.sample_rate: int = 48000  # Default for webm
        
        self.partial_transcripts: List[str] = []
        self.last_chunk_text: str = ""
        
        # Bytes per ms estimate (rough, will vary by codec)
        # webm opus: ~16 kbps = 2 bytes/ms
        self.bytes_per_ms = 2
        
    def set_format(self, audio_format: str, sample_rate: int = 48000):
        """Set the audio format for incoming chunks."""
        self.audio_format = audio_format
        self.sample_rate = sample_rate
        
        # Adjust bytes_per_ms based on format
        if audio_format in ("webm", "opus"):
            self.bytes_per_ms = 2  # ~16kbps
        elif audio_format == "mp4":
            self.bytes_per_ms = 4  # ~32kbps AAC
        elif audio_format == "wav":
            self.bytes_per_ms = sample_rate * 2 // 1000  # 16-bit mono
        
    async def feed_audio(self, chunk: bytes) -> Optional[str]:
        """
        Feed an audio chunk. Returns partial transcript if enough audio buffered.
        """
        self.audio_buffer.extend(chunk)
        
        # Check if we have enough for a transcription chunk
        chunk_bytes = self.chunk_duration_ms * self.bytes_per_ms
        
        if len(self.audio_buffer) >= chunk_bytes:
            # Transcribe the chunk
            partial = await self._transcribe_chunk()
            return partial
            
        return None
    
    async def finalize(self) -> str:
        """
        Finalize transcription with any remaining audio.
        Returns the complete transcript.
        """
        if len(self.audio_buffer) > 0:
            # Transcribe remaining audio
            await self._transcribe_chunk(is_final=True)
        
        # Merge all partials
        full_transcript = self._merge_transcripts()
        
        # Reset state
        self.reset()
        
        return full_transcript
    
    def reset(self):
        """Reset transcriber state for a new session."""
        self.audio_buffer = bytearray()
        self.partial_transcripts = []
        self.last_chunk_text = ""
    
    async def _transcribe_chunk(self, is_final: bool = False) -> str:
        """Transcribe buffered audio and return partial result."""
        
        if len(self.audio_buffer) == 0:
            return ""
        
        # Determine how much audio to process
        if is_final:
            audio_to_process = bytes(self.audio_buffer)
            self.audio_buffer = bytearray()
        else:
            chunk_bytes = self.chunk_duration_ms * self.bytes_per_ms
            overlap_bytes = self.overlap_ms * self.bytes_per_ms
            
            audio_to_process = bytes(self.audio_buffer[:chunk_bytes])
            # Keep overlap for continuity
            self.audio_buffer = bytearray(self.audio_buffer[chunk_bytes - overlap_bytes:])
        
        # Write to temp file
        tmp_id = uuid.uuid4().hex
        tmp_dir = Path(tempfile.gettempdir())
        input_file = tmp_dir / f"{tmp_id}.{self.audio_format}"
        output_dir = tmp_dir
        
        try:
            input_file.write_bytes(audio_to_process)
            
            # Debug: verify file was written correctly
            actual_size = input_file.stat().st_size
            logger.info(f"Wrote {len(audio_to_process)} bytes, file size: {actual_size} bytes, path: {input_file}")
            
            # Debug: save a copy for analysis
            debug_file = tmp_dir / f"debug_audio_{tmp_id}.{self.audio_format}"
            debug_file.write_bytes(audio_to_process)
            logger.info(f"Debug copy saved to {debug_file}")
            
            # Run Whisper
            cmd = f"whisper {input_file} --model {self.model} --language {self.language} --output_format txt --output_dir {output_dir}"
            
            logger.debug(f"Running Whisper on {len(audio_to_process)} bytes")
            
            process = await asyncio.create_subprocess_shell(
                cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=30.0
            )
            
            if process.returncode != 0:
                logger.error(f"Whisper failed: {stderr.decode()}")
                return ""
            
            # Read output
            output_file = tmp_dir / f"{tmp_id}.txt"
            if output_file.exists():
                text = output_file.read_text().strip()
                output_file.unlink(missing_ok=True)
                
                # Store for merging
                self.partial_transcripts.append(text)
                self.last_chunk_text = text
                
                logger.debug(f"Transcribed: {text[:50]}...")
                return text
            else:
                logger.warning("Whisper produced no output file")
                return ""
                
        except asyncio.TimeoutError:
            logger.error("Whisper timed out")
            return ""
        except Exception as e:
            logger.exception(f"Transcription error: {e}")
            return ""
        finally:
            # Cleanup
            input_file.unlink(missing_ok=True)
    
    def _merge_transcripts(self) -> str:
        """Merge partial transcripts, removing overlap duplicates."""
        if not self.partial_transcripts:
            return ""
        
        if len(self.partial_transcripts) == 1:
            return self.partial_transcripts[0]
        
        # Simple merge: join with space, then clean up
        # A more sophisticated approach would detect overlapping phrases
        merged = " ".join(self.partial_transcripts)
        
        # Remove obvious duplications (e.g., repeated words at boundaries)
        words = merged.split()
        cleaned = []
        for i, word in enumerate(words):
            if i == 0 or word.lower() != words[i-1].lower():
                cleaned.append(word)
        
        return " ".join(cleaned)


class StreamingTranscriber:
    """
    Higher-level transcriber that yields partial results as an async iterator.
    """
    
    def __init__(self, **kwargs):
        self.transcriber = ChunkedTranscriber(**kwargs)
        self.audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        
    def set_format(self, audio_format: str, sample_rate: int = 48000):
        self.transcriber.set_format(audio_format, sample_rate)
        
    async def start(self) -> AsyncIterator[str]:
        """Start transcription and yield partial results."""
        while True:
            chunk = await self.audio_queue.get()
            
            if chunk is None:
                # End of audio
                final = await self.transcriber.finalize()
                if final:
                    yield final
                break
            
            partial = await self.transcriber.feed_audio(chunk)
            if partial:
                yield partial
    
    async def feed(self, chunk: bytes):
        """Feed an audio chunk."""
        await self.audio_queue.put(chunk)
    
    async def end(self):
        """Signal end of audio."""
        await self.audio_queue.put(None)
    
    def reset(self):
        """Reset for a new session."""
        self.transcriber.reset()
        # Clear queue
        while not self.audio_queue.empty():
            try:
                self.audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
