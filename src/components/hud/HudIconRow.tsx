import { useEffect } from 'react';
import { isTypingTarget } from '../../hooks/useKeyboardMove';
import { useIsMobile } from '../../hooks/useIsMobile';
import './HudIconRow.css';

export interface HudIconRowProps {
  /** All optional and unwired for now (no inventory/character/settings screens exist yet online) - same inert-until-wired precedent as MobileControls' onAttack/onSkill. */
  onOpenCharacter?: () => void;
  onOpenInventory?: () => void;
  onOpenSettings?: () => void;
}

/**
 * Physical-key shortcuts for each button - C/I for Character/Inventory,
 * and L (not S) for Settings specifically to avoid colliding with S/
 * ArrowDown's existing meaning as "move backward" (see useKeyboardMove's
 * MOVE_KEYS). Keyed by KeyboardEvent.code, same convention useKeyboardMove
 * itself uses, so this stays layout-independent.
 */
const SHORTCUTS: { code: string; label: string; handlerKey: keyof HudIconRowProps }[] = [
  { code: 'KeyC', label: 'C', handlerKey: 'onOpenCharacter' },
  { code: 'KeyI', label: 'I', handlerKey: 'onOpenInventory' },
  { code: 'KeyL', label: 'L', handlerKey: 'onOpenSettings' },
];

/** Vertical menu bar, right edge of the screen (Character/Inventory/Settings) - visual chrome only until the screens behind these exist. Desktop (non-touch) also gets a C/I/L keyboard shortcut per button, with a matching hint badge - mobile has no physical keyboard, so neither the hint nor the listener add anything there. */
export default function HudIconRow({ onOpenCharacter, onOpenInventory, onOpenSettings }: HudIconRowProps) {
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isMobile) return;
    const handlers: Record<string, (() => void) | undefined> = { onOpenCharacter, onOpenInventory, onOpenSettings };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.repeat) return;
      const shortcut = SHORTCUTS.find((s) => s.code === event.code);
      if (shortcut) handlers[shortcut.handlerKey]?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, onOpenCharacter, onOpenInventory, onOpenSettings]);

  return (
    <div className="hud-icon-row">
      <button type="button" className="hud-icon-btn" onClick={onOpenCharacter} aria-label="Character (C)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4" strokeLinecap="round" />
        </svg>
        {!isMobile && <span className="hud-icon-btn-shortcut">C</span>}
      </button>
      <button type="button" className="hud-icon-btn" onClick={onOpenInventory} aria-label="Inventory (I)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="8" width="16" height="12" rx="1.5" />
          <path d="M8 8V6a4 4 0 0 1 8 0v2" strokeLinecap="round" />
        </svg>
        {!isMobile && <span className="hud-icon-btn-shortcut">I</span>}
      </button>
      <button type="button" className="hud-icon-btn" onClick={onOpenSettings} aria-label="Settings (L)">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
        {!isMobile && <span className="hud-icon-btn-shortcut">L</span>}
      </button>
    </div>
  );
}
