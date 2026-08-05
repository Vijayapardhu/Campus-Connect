import { useEffect, useState } from 'react';

/*
 * A media query as state.
 *
 * Used where a layout difference is structural rather than cosmetic — the
 * pinned horizontal section rebuilds itself as a vertical list on a phone,
 * which is a different tree, not a different stylesheet.
 *
 * Seeded from `matchMedia` on the first render rather than from `false`, so
 * a narrow screen never paints the wide layout for a frame before correcting
 * itself.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}
