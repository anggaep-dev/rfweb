import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChatLogEntry } from '../../scenes/OnlineScene';
import './ChatBox.css';

export interface ChatBoxProps {
  entries: ChatLogEntry[];
  onSend: (message: string) => void;
}

/** Client-side only - the wire protocol doesn't cap message length itself, this just keeps one runaway paste from filling the log with an unreadable wall of text. */
const MAX_MESSAGE_LENGTH = 200;

/**
 * Real chat log + send box, left side under MiniMap - unlike most of this
 * HUD pass (VitalsBar, InventoryWindow, ...), this isn't a mocked shell:
 * OnlineScene already received ChatEvent/WhisperEvent/SystemMessage packets
 * (previously just console.logged) and WorldConnection already has
 * sendChatAll/sendWhisper, so this wires straight into real data both ways.
 * Only the chat-all channel is sent from here for now - a whisper needs a
 * target-player picker this doesn't have yet, though incoming whispers still
 * render (visually distinguished, see .chat-box-entry-whisper).
 */
export default function ChatBox({ entries, onSend }: ChatBoxProps) {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  // Keep the log pinned to the newest message - a chat box that doesn't
  // auto-scroll just silently hides everything new below the fold.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setDraft('');
  };

  return (
    <div className="chat-box">
      <div className="chat-box-log" ref={logRef}>
        {entries.length === 0 && <div className="chat-box-empty">No messages yet.</div>}
        {entries.map((entry) => (
          <div key={entry.id} className={`chat-box-entry chat-box-entry-${entry.kind}`}>
            {entry.kind === 'system' ? (
              <span className="chat-box-message">{entry.message}</span>
            ) : (
              <>
                <span className="chat-box-sender">{entry.kind === 'whisper' ? `[W] ${entry.playerName}` : entry.playerName}:</span>{' '}
                <span className="chat-box-message">{entry.message}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <form className="chat-box-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="chat-box-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Say something…"
          maxLength={MAX_MESSAGE_LENGTH}
          aria-label="Chat message"
        />
        <button type="submit" className="chat-box-send" aria-label="Send" disabled={!draft.trim()}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 12 20 4 13 20 11 13Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </form>
    </div>
  );
}
