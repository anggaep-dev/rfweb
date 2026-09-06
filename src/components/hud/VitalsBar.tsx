import './VitalsBar.css';

/**
 * HP/MP + level chrome, bottom-center - mock values only. There's no combat
 * or leveling system in this project yet (see MobileControls' Attack/Skill
 * buttons for the same "shell now, wire real data later" precedent), so
 * this exists purely to establish the HUD's visual language; swap the
 * hardcoded numbers/fractions here for real character stats once those
 * exist server-side.
 */
const MOCK_LEVEL = 1;
const MOCK_HP = { current: 999, max: 999 };
const MOCK_MP = { current: 320, max: 320 };

export default function VitalsBar() {
  const hpPct = (MOCK_HP.current / MOCK_HP.max) * 100;
  const mpPct = (MOCK_MP.current / MOCK_MP.max) * 100;

  return (
    <div className="vitals-bar">
      <div className="vitals-level" aria-label={`Level ${MOCK_LEVEL}`}>
        <span className="vitals-level-number">{MOCK_LEVEL}</span>
      </div>
      <div className="vitals-bars">
        <div className="vitals-track vitals-track-hp">
          <div className="vitals-fill vitals-fill-hp" style={{ width: `${hpPct}%` }} />
          <span className="vitals-label">
            {MOCK_HP.current} / {MOCK_HP.max}
          </span>
        </div>
        <div className="vitals-track vitals-track-mp">
          <div className="vitals-fill vitals-fill-mp" style={{ width: `${mpPct}%` }} />
        </div>
      </div>
    </div>
  );
}
