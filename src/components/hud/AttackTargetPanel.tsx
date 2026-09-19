import { Button } from '../ui';
import type { SelectedTarget } from '../../scenes/OnlineScene';
import { useIsMobile } from '../../hooks/useIsMobile';
import './AttackTargetPanel.css';

export interface AttackTargetPanelProps {
  /** The click-selected monster (see OnlineScene.handleAttackClick) - panel renders nothing at all when null, rather than a disabled "no target" placeholder. */
  target: SelectedTarget | null;
  onAttack: () => void;
}

/**
 * Top-center "target frame" - appears only once a monster is click-selected
 * (see OnlineScene.selectTarget), showing its name/HP and (desktop only -
 * see useIsMobile below) the Attack button that actually sends
 * AttackRequest (OnlineScene.attackSelectedTarget) and plays the local
 * player's own attack swing. On mobile the same action lives in
 * MobileControls' thumb-reachable attack button instead (this panel's own
 * button sits at top-center, too far from either thumb during real play) -
 * this panel still shows name/HP there, just without a second, harder-to-
 * reach attack trigger. A dead target still shows briefly (state carried in
 * the last-known SelectedTarget) with the Attack button disabled, until the
 * exit/death delta clears the selection entirely.
 */
export default function AttackTargetPanel({ target, onAttack }: AttackTargetPanelProps) {
  const isMobile = useIsMobile();
  if (!target) return null;
  const hpPercent = target.maxHp > 0 ? Math.max(0, Math.min(1, target.hp / target.maxHp)) * 100 : 0;

  return (
    <div className="attack-target-panel">
      <div className="attack-target-info">
        <div className="attack-target-name">{target.name || 'Unknown'}</div>
        <div className="attack-target-hp-track">
          <div className="attack-target-hp-fill" style={{ width: `${hpPercent}%` }} />
        </div>
      </div>
      {!isMobile && (
        <Button variant="danger" size="sm" onClick={onAttack} disabled={!target.alive}>
          {target.alive ? 'Attack' : 'Defeated'}
        </Button>
      )}
    </div>
  );
}
