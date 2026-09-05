import { useEffect, useState } from 'react';

export type Orientation = 'portrait' | 'landscape';

function getOrientation(): Orientation {
  return window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape';
}

/** Live portrait/landscape orientation - updates on device rotation, and on a desktop window resize that crosses the same width/height threshold (matchMedia's own change event covers both, no separate resize listener needed). */
export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(getOrientation);

  useEffect(() => {
    const mql = window.matchMedia('(orientation: portrait)');
    const update = () => setOrientation(mql.matches ? 'portrait' : 'landscape');
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return orientation;
}
