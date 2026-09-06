import './HudIconRow.css';

export interface HudIconRowProps {
  /** All optional and unwired for now (no inventory/character/settings screens exist yet online) - same inert-until-wired precedent as MobileControls' onAttack/onSkill. */
  onOpenCharacter?: () => void;
  onOpenInventory?: () => void;
  onOpenSettings?: () => void;
}

/** Top-right menu icon cluster - visual chrome only until the screens behind these exist. */
export default function HudIconRow({ onOpenCharacter, onOpenInventory, onOpenSettings }: HudIconRowProps) {
  return (
    <div className="hud-icon-row">
      <button type="button" className="hud-icon-btn" onClick={onOpenCharacter} aria-label="Character">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="8" r="3.2" />
          <path d="M5 20c0-3.6 3.1-6.4 7-6.4s7 2.8 7 6.4" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="hud-icon-btn" onClick={onOpenInventory} aria-label="Inventory">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="8" width="16" height="12" rx="1.5" />
          <path d="M8 8V6a4 4 0 0 1 8 0v2" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="hud-icon-btn" onClick={onOpenSettings} aria-label="Settings">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
