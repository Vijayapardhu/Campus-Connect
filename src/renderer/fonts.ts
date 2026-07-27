/**
 * Discovering which fonts are actually installed on this machine.
 *
 * Two strategies, tried in order:
 *
 *  1. The Local Font Access API (`queryLocalFonts`). Chromium exposes the real
 *     installed list, which is what we want. It needs a permission the main
 *     process grants, and it must be called from a user gesture.
 *
 *  2. Width measurement. Every font falls back to a generic family when it is
 *     not installed, so a string rendered in `"Candidate", monospace` measures
 *     exactly the same as one rendered in plain `monospace` unless the
 *     candidate really exists. Comparing against all three generics avoids
 *     false negatives when a candidate happens to match one of them.
 *
 * The fallback only sees fonts on the candidate list, which is why the list
 * covers the families that actually ship with Windows, macOS and common Linux
 * distributions.
 */

const CANDIDATES = [
  // Windows
  'Arial', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Cascadia Code', 'Cascadia Mono',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic',
  'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Sans Unicode',
  'Malgun Gothic', 'Microsoft Sans Serif', 'Nirmala UI', 'Palatino Linotype', 'Segoe Print',
  'Segoe Script', 'Segoe UI', 'Segoe UI Variable Display', 'Sitka', 'Sylfaen', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana',
  // macOS
  'Avenir', 'Avenir Next', 'Baskerville', 'Charter', 'Futura', 'Geneva', 'Gill Sans', 'Helvetica',
  'Helvetica Neue', 'Hoefler Text', 'Menlo', 'Monaco', 'Optima', 'Palatino', 'PT Sans', 'PT Mono',
  'SF Mono', 'SF Pro Text',
  // Linux / open source
  'Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif', 'Fira Code', 'Fira Sans',
  'IBM Plex Mono', 'IBM Plex Sans', 'Inter', 'JetBrains Mono', 'Liberation Mono',
  'Liberation Sans', 'Liberation Serif', 'Noto Sans', 'Noto Serif', 'Nimbus Sans',
  'Open Sans', 'Roboto', 'Roboto Mono', 'Source Code Pro', 'Source Sans Pro', 'Ubuntu',
  'Ubuntu Mono'
];

const GENERICS = ['monospace', 'serif', 'sans-serif'];
const PROBE = 'MMMMMMMMMMlliWWWWWWWWWW0123456789';
const PROBE_SIZE = '72px';

let cache: string[] | null = null;

function measure(context: CanvasRenderingContext2D, family: string): number {
  context.font = `${PROBE_SIZE} ${family}`;
  return context.measureText(PROBE).width;
}

function detectByMeasurement(): string[] {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) {
    return [];
  }

  const baselines = GENERICS.map((generic) => measure(context, generic));

  return CANDIDATES.filter((candidate) =>
    GENERICS.some((generic, index) => {
      // A quoted name first, then the generic: if the width shifts, the named
      // font was used, which means it is installed.
      const width = measure(context, `"${candidate}", ${generic}`);
      return Math.abs(width - baselines[index]) > 0.5;
    })
  );
}

/**
 * Without a user gesture the permission request behind `queryLocalFonts` can
 * sit unanswered instead of rejecting, so the call is raced against a timeout.
 * A settings dialog that says "Reading fonts…" forever is worse than a shorter
 * list that appears immediately.
 */
const LOCAL_FONTS_TIMEOUT_MS = 1500;

async function detectByLocalFontAccess(): Promise<string[] | null> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
    .queryLocalFonts;

  if (typeof query !== 'function') {
    return null;
  }

  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCAL_FONTS_TIMEOUT_MS));

  try {
    const faces = await Promise.race([query(), timeout]);
    if (!faces) {
      return null;
    }
    const families = Array.from(new Set(faces.map((face) => face.family))).filter(Boolean);
    return families.length > 0 ? families : null;
  } catch {
    // Permission denied, or no user gesture — fall through to measurement.
    return null;
  }
}

/** Installed font families, sorted. Cached: enumeration is not free. */
export async function listSystemFonts(): Promise<string[]> {
  if (cache) {
    return cache;
  }

  let families: string[];
  try {
    families = (await detectByLocalFontAccess()) ?? detectByMeasurement();
  } catch {
    families = detectByMeasurement();
  }

  cache = families.sort((a, b) => a.localeCompare(b));
  return cache;
}

/** Wraps a family name so names containing spaces survive the CSS round trip. */
export function toFontStack(family: string): string {
  return family ? `"${family.replace(/"/g, '')}", system-ui, sans-serif` : '';
}
