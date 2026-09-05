import { useEffect, useState } from 'react';

/** True on touch-primary devices (phones/tablets) - re-evaluated live so e.g. rotating a foldable or docking a tablet updates it, not just the initial load. Extracted out of MobileControls so FullscreenButton (and anything else mobile-only) can share the same check. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(pointer: coarse)').matches);

  useEffect(() => {
    const mql = window.matchMedia('(pointer: coarse)');
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return isMobile;
}
