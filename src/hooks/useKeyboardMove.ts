import { useEffect, useRef } from 'react';

/** WASD + arrow keys, mapped to the same (x = right, y = forward) axes the mobile joystick emits. */
const MOVE_KEYS: Record<string, { axis: 'x' | 'y'; sign: 1 | -1 }> = {
  KeyW: { axis: 'y', sign: 1 },
  ArrowUp: { axis: 'y', sign: 1 },
  KeyS: { axis: 'y', sign: -1 },
  ArrowDown: { axis: 'y', sign: -1 },
  KeyD: { axis: 'x', sign: 1 },
  ArrowRight: { axis: 'x', sign: 1 },
  KeyA: { axis: 'x', sign: -1 },
  ArrowLeft: { axis: 'x', sign: -1 },
};

/** Typing in a text field (the GM console, an equip search, ...) shouldn't also walk the character. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

/**
 * Desktop counterpart to MobileControls' joystick: holds down WASD/arrow
 * keys to drive the same camera-relative (x, y) move-input channel
 * (ViewerScene.setMoveInput) the joystick uses, so both sources share one
 * movement path through CharacterController rather than each needing their
 * own. Diagonals (e.g. W+D) are normalized to the same max magnitude a
 * fully-pushed joystick would send.
 */
export function useKeyboardMove(onMove: (input: { x: number; y: number } | null) => void): void {
  const pressed = useRef(new Set<string>());
  // Ref, not a dependency - callers may not memoize onMove, and this hook's
  // listeners shouldn't be torn down/reattached (losing in-progress key
  // state) just because the caller re-rendered. See MobileControls' onMoveRef
  // for the same pattern and why it matters.
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  useEffect(() => {
    const emit = () => {
      let x = 0;
      let y = 0;
      for (const code of pressed.current) {
        const mapped = MOVE_KEYS[code];
        if (!mapped) continue;
        if (mapped.axis === 'x') x += mapped.sign;
        else y += mapped.sign;
      }
      if (x === 0 && y === 0) {
        onMoveRef.current(null);
        return;
      }
      const len = Math.hypot(x, y);
      onMoveRef.current({ x: x / len, y: y / len });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.code in MOVE_KEYS) || isTypingTarget(event.target)) return;
      if (pressed.current.has(event.code)) return; // ignore OS key-repeat
      pressed.current.add(event.code);
      emit();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!(event.code in MOVE_KEYS)) return;
      pressed.current.delete(event.code);
      emit();
    };

    // Held keys never see their keyup if focus/visibility is lost mid-press
    // (alt-tab, a browser dialog, DevTools stealing focus, ...) - without
    // this the character would keep walking forever with no way to stop.
    const releaseAll = () => {
      if (pressed.current.size === 0) return;
      pressed.current.clear();
      onMoveRef.current(null);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', releaseAll);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseAll);
      document.removeEventListener('visibilitychange', releaseAll);
      releaseAll();
    };
  }, []);
}
