import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import './MobileControls.css';

/** Max distance (px) the stick can travel from center before clamping - also the divisor that turns that travel into a [-1, 1] input magnitude. */
const JOYSTICK_RADIUS_PX = 48;

export interface MobileControlsProps {
  /** Fires on every drag update with a stick vector (x = right, y = forward, each roughly [-1, 1]), and with null the instant the stick is released. */
  onMove: (input: { x: number; y: number } | null) => void;
  /** Attack/skill buttons render now so the joystick's layout is final, but have no gameplay behind them yet - wired up once combat exists. */
  onAttack?: () => void;
  onSkill?: () => void;
}

export default function MobileControls({ onMove, onAttack, onSkill }: MobileControlsProps) {
  const isMobile = useIsMobile();
  const baseRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);
  const activePointerId = useRef<number | null>(null);

  // The knob's on-screen position is written straight to the DOM instead of
  // through React state - a held/dragged touch can fire pointermove at a
  // high, browser-dependent rate, and there's no reason to pay for a React
  // re-render (and the cascade of prop/callback identity churn that comes
  // with it) just to move a div every time.
  const updateFromClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const base = baseRef.current;
      if (!base) return;
      const rect = base.getBoundingClientRect();
      let dx = clientX - (rect.left + rect.width / 2);
      let dy = clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist > JOYSTICK_RADIUS_PX) {
        dx = (dx / dist) * JOYSTICK_RADIUS_PX;
        dy = (dy / dist) * JOYSTICK_RADIUS_PX;
      }
      if (stickRef.current) stickRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
      // Screen Y grows downward, so pushing the stick up (negative dy) is forward (positive y).
      onMove({ x: dx / JOYSTICK_RADIUS_PX, y: -dy / JOYSTICK_RADIUS_PX });
    },
    [onMove],
  );

  const release = useCallback(() => {
    activePointerId.current = null;
    if (stickRef.current) stickRef.current.style.transform = 'translate(0px, 0px)';
    onMove(null);
  }, [onMove]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Ignore a second finger landing on the stick while one is already
      // driving it - without this guard, a stray touch (e.g. a palm brush)
      // hijacks activePointerId, and when that second touch lifts, release()
      // fires and zeroes movement even though the original finger is still
      // held down and driving the joystick (its now-mismatched pointerId
      // gets silently ignored below) - looks like the character randomly
      // stopping mid-hold.
      if (activePointerId.current !== null) return;
      event.preventDefault();
      baseRef.current?.setPointerCapture(event.pointerId);
      activePointerId.current = event.pointerId;
      updateFromClientPoint(event.clientX, event.clientY);
    },
    [updateFromClientPoint],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== event.pointerId) return;
      updateFromClientPoint(event.clientX, event.clientY);
    },
    [updateFromClientPoint],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== event.pointerId) return;
      release();
    },
    [release],
  );

  // Defensive fallback for anything that drops pointer capture without a
  // matching up/cancel event reaching us (observed as an occasional stuck
  // "held forward" state on some mobile browsers, e.g. after a long-press
  // gesture the OS partially intercepts) - if capture is gone, the stick is
  // no longer meaningfully "held" regardless of which pointer triggered it.
  const handleLostPointerCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activePointerId.current !== event.pointerId) return;
      release();
    },
    [release],
  );

  // Always call the latest onMove without making the unmount effect below
  // depend on it - onMove is RfViewer's callback prop, and even a memoized
  // caller shouldn't be able to make this component treat "the callback
  // changed" as "the component unmounted" (that coupling is exactly what
  // caused the joystick to randomly zero out mid-hold - see RfViewer's
  // handleMoveInput comment).
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  // Releases the stick if the component unmounts mid-drag (e.g. an exit
  // while touching it) - empty deps so this only runs on true mount/unmount,
  // never on a prop-identity change.
  useEffect(() => {
    return () => onMoveRef.current(null);
  }, []);

  if (!isMobile) return null;

  return (
    <div className="mobile-controls">
      <div
        className="mobile-controls-joystick-base"
        ref={baseRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onLostPointerCapture={handleLostPointerCapture}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div ref={stickRef} className="mobile-controls-joystick-stick" />
      </div>

      <div className="mobile-controls-actions">
        <button type="button" className="mobile-controls-btn mobile-controls-btn-skill" onClick={onSkill} aria-label="Skill">
          Skill
        </button>
        <button type="button" className="mobile-controls-btn mobile-controls-btn-attack" onClick={onAttack} aria-label="Attack">
          Attack
        </button>
      </div>
    </div>
  );
}
