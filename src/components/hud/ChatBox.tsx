import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChatLogEntry } from '../../scenes/OnlineScene';
import { useIsMobile } from '../../hooks/useIsMobile';
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
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
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

  if (isMobile && !expanded) {
    const previewEntries = entries.slice(-3);
    return (
      <button type="button" className="chat-peek" onClick={() => setExpanded(true)} aria-label="Open chat">
        <span className="chat-peek-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a8 8 0 0 1-8 8H6l-3 3v-7a8 8 0 1 1 18-4Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="chat-peek-lines">
          {previewEntries.length === 0 ? (
            <span className="chat-peek-empty">No messages yet.</span>
          ) : (
            previewEntries.map((entry) => (
              <span key={entry.id} className={`chat-peek-line chat-peek-line-${entry.kind}`}>
                {entry.kind === 'system' ? entry.message : `${entry.kind === 'whisper' ? '[W] ' : ''}${entry.playerName}: ${entry.message}`}
              </span>
            ))
          )}
        </span>
      </button>
    );
  }

  return (
    <div className={`chat-box ${isMobile ? 'chat-box-mobile-expanded' : ''}`}>
      {isMobile && (
        <button type="button" className="chat-box-collapse" onClick={() => setExpanded(false)} aria-label="Collapse chat">
          ×
        </button>
      )}
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
