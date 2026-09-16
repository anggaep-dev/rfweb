import type { CSSProperties } from 'react';
import './VitalsBar.css';

/**
 * RF-style HP/FP/SP chrome - mock values only. There's no combat or leveling
 * system in this project yet (see MobileControls' Attack/Skill buttons for
 * the same "shell now, wire real data later" precedent), so this exists purely
 * to establish the HUD's visual language; swap these values for real character
 * stats once those exist server-side.
 */
const MOCK_LEVEL = 1;
const MOCK_HP = { current: 999, max: 999 };
const MOCK_FP = { current: 320, max: 320 };
const MOCK_SP = { current: 160, max: 160 };

const VITAL_ROWS = [
  { key: 'hp', label: 'HP', stat: MOCK_HP },
  { key: 'fp', label: 'FP', stat: MOCK_FP },
  { key: 'sp', label: 'SP', stat: MOCK_SP },
] as const;

function getPercent(current: number, max: number) {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (current / max) * 100));
}

export default function VitalsBar() {
  return (
    <div className="vitals-bar" aria-label={`Level ${MOCK_LEVEL} character vitals`}>
      <div className="vitals-frame">
        <span className="vitals-level" aria-hidden="true">
          {MOCK_LEVEL}
        </span>
        {VITAL_ROWS.map(({ key, label, stat }) => {
          const percent = getPercent(stat.current, stat.max);

          return (
            <div
              key={key}
              className={`vitals-row vitals-row-${key}`}
              role="meter"
              aria-label={`${label} ${stat.current} / ${stat.max}`}
              aria-valuemin={0}
              aria-valuemax={stat.max}
              aria-valuenow={stat.current}
              style={{ '--vital-percent': `${percent}%` } as CSSProperties}
            >
              <span className={`vitals-gauge vitals-gauge-${key}`} />
              <span className="vitals-value">
                {stat.current}/{stat.max}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
