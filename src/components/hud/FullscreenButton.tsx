import { useCallback, useEffect, useState } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import './FullscreenButton.css';

// Cross-browser Fullscreen API surface - unprefixed is standard everywhere
// modern, but Safari (including iPadOS) still only exposes the
// webkit-prefixed names, and older Firefox/IE used their own. iPhone Safari
// specifically has never supported *any* of these for a plain element
// (only <video> gets native fullscreen there) - isFullscreenSupported()
// below exists to detect exactly that case, since calling requestFullscreen
// there either doesn't exist or silently rejects, which otherwise looks
// like "the button does nothing".
interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
  mozFullScreenElement?: Element | null;
  mozCancelFullScreen?: () => Promise<void>;
  msFullscreenElement?: Element | null;
  msExitFullscreen?: () => Promise<void>;
}
interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
  mozRequestFullScreen?: () => Promise<void>;
  msRequestFullscreen?: () => Promise<void>;
}

const FULLSCREEN_CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];

function getFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.mozFullScreenElement ?? doc.msFullscreenElement ?? null;
}

function isFullscreenSupported(): boolean {
  const el = document.documentElement as FullscreenElement;
  return !!(el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.mozRequestFullScreen ?? el.msRequestFullscreen);
}

async function requestFullscreen(el: HTMLElement): Promise<void> {
  const target = el as FullscreenElement;
  const request = target.requestFullscreen ?? target.webkitRequestFullscreen ?? target.mozRequestFullScreen ?? target.msRequestFullscreen;
  if (!request) throw new Error('Fullscreen is not supported in this browser');
  await request.call(target);
}

async function exitFullscreenAnyPrefix(): Promise<void> {
  const doc = document as FullscreenDocument;
  const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen ?? doc.mozCancelFullScreen ?? doc.msExitFullscreen;
  if (exit) await exit.call(doc);
}

/**
 * Mobile-only button to enter/exit true fullscreen (Fullscreen API) -
 * worth having specifically on mobile since the browser chrome (address
 * bar, nav buttons) otherwise eats a real chunk of an already-small
 * viewport; desktop doesn't have that problem, so this renders nothing
 * there (same useIsMobile gate MobileControls uses).
 *
 * iPhone Safari (not iPad) has no fullscreen support for arbitrary
 * elements at all - the only real workaround is the user adding the page
 * to their home screen (a PWA launched that way can declare
 * display: standalone/fullscreen in its manifest), which isn't something a
 * button click can trigger. `error` surfaces exactly this instead of the
 * click silently doing nothing.
 */
export default function FullscreenButton() {
  const isMobile = useIsMobile();
  const [isFullscreen, setIsFullscreen] = useState(getFullscreenElement() !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      setIsFullscreen(getFullscreenElement() !== null);
      setError(null);
    };
    for (const eventName of FULLSCREEN_CHANGE_EVENTS) document.addEventListener(eventName, update);
    return () => {
      for (const eventName of FULLSCREEN_CHANGE_EVENTS) document.removeEventListener(eventName, update);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    setError(null);
    if (getFullscreenElement()) {
      void exitFullscreenAnyPrefix();
      return;
    }
    requestFullscreen(document.documentElement).catch((err: unknown) => {
      console.warn('Failed to enter fullscreen:', err);
      setError(
        isFullscreenSupported()
          ? 'Fullscreen request was blocked.'
          : "This browser doesn't support fullscreen (common on iPhone Safari - try adding this page to your home screen instead).",
      );
    });
  }, []);

  if (!isMobile) return null;

  return (
    <div className="fullscreen-button-wrap">
      <button
        type="button"
        className="fullscreen-button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        {isFullscreen ? (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <path
              d="M9 4H6a1 1 0 0 0-1 1v3M15 4h3a1 1 0 0 1 1 1v3M9 20H6a1 1 0 0 1-1-1v-3M15 20h3a1 1 0 0 0 1-1v-3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <path
              d="M4 8V5a1 1 0 0 1 1-1h3M20 8V5a1 1 0 0 0-1-1h-3M4 16v3a1 1 0 0 0 1 1h3M20 16v3a1 1 0 0 1-1 1h-3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      {error && <div className="fullscreen-button-error">{error}</div>}
    </div>
  );
}
