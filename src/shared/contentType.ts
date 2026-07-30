/**
 * Working out what a piece of copied text actually *is*.
 *
 * A clipboard is not a pile of undifferentiated strings. It is mostly links,
 * commands, error messages, colours and credentials, and each of those wants to
 * be shown — and acted on — differently. Rendering all of them as the same grey
 * paragraph is most of what makes a clipboard tool feel like a text dump rather
 * than a tool.
 *
 * Deliberately conservative. A wrong guess is worse than no guess: something
 * mislabelled as a link gets an "open" button that goes somewhere unexpected,
 * and something mislabelled as a colour gets a swatch of the wrong thing. Every
 * pattern here is anchored to the whole string for that reason, except code,
 * which is a judgement made from several signals at once.
 *
 * Lives in `shared` rather than the renderer so it can be tested in plain Node —
 * the renderer's own build output is wiped by Vite.
 */

export type ContentKind =
  | 'url'
  | 'email'
  | 'color'
  | 'code'
  | 'json'
  | 'number'
  | 'text';

export type ContentInfo = {
  kind: ContentKind;
  /** A short human label for the badge. */
  label: string;
  /**
   * The value an action would use — the URL to open, the address to mail, the
   * colour to swatch. Absent when there is nothing to act on.
   */
  value?: string;
};

/** Longest string worth examining. Past this it is a document, not a value. */
const MAX_INSPECT = 4000;

/** Anchored so that prose merely *containing* a URL is not treated as one. */
const URL_PATTERN = /^https?:\/\/[^\s]+$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_COLOR_PATTERN = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)$/i;
const NUMBER_PATTERN = /^[+-]?\d[\d\s,._-]*$/;

/**
 * Hints that a run of text is code rather than prose. None is conclusive on its
 * own — prose contains semicolons and brackets too — so two are required.
 */
const CODE_HINTS: RegExp[] = [
  /[;{}]\s*$/m,
  /^\s*(?:function|const|let|var|class|def|import|from|export|return|if|for|while|public|private)\b/m,
  /^\s*(?:npm|npx|yarn|pnpm|git|docker|kubectl|sudo|apt|brew|pip|cargo|go|python|node)\s+\S/m,
  /=>|::|->|\|\||&&|!==|===/,
  /^\s*[<[{].*[>\]}]\s*$/s,
  /\$\{|\{\{/,
  /^\s*(?:#|\/\/|\/\*)\s/m
];

export function detectContent(text: string): ContentInfo {
  const trimmed = text.trim();

  if (!trimmed || trimmed.length > MAX_INSPECT) {
    return { kind: 'text', label: 'Text' };
  }

  if (URL_PATTERN.test(trimmed)) {
    return { kind: 'url', label: hostOf(trimmed) ?? 'Link', value: trimmed };
  }

  if (EMAIL_PATTERN.test(trimmed)) {
    return { kind: 'email', label: 'Email', value: trimmed };
  }

  if (HEX_COLOR_PATTERN.test(trimmed) || RGB_COLOR_PATTERN.test(trimmed)) {
    return { kind: 'color', label: 'Colour', value: trimmed };
  }

  const json = asJson(trimmed);
  if (json) {
    return { kind: 'json', label: json };
  }

  // Before the number check: a version string or an id is not a quantity.
  if (looksLikeCode(trimmed)) {
    return { kind: 'code', label: 'Code' };
  }

  if (NUMBER_PATTERN.test(trimmed) && /\d/.test(trimmed) && trimmed.length <= 40) {
    return { kind: 'number', label: 'Number' };
  }

  return { kind: 'text', label: 'Text' };
}

/**
 * Whether a URL is safe to hand to the operating system.
 *
 * Only http and https, ever. A clipboard can contain `file://`, `javascript:`
 * or any custom scheme some other installed application has registered, and
 * "open the thing the user copied" must not become "launch whatever this string
 * names".
 */
export function isOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * Recognises JSON, and says what shape it is — an object with three keys is far
 * more informative in a list than the word "JSON".
 */
function asJson(text: string): string | null {
  const first = text[0];
  if (first !== '{' && first !== '[') {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    if (Array.isArray(parsed)) {
      return `JSON · ${parsed.length} item${parsed.length === 1 ? '' : 's'}`;
    }
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed).length;
      return `JSON · ${keys} field${keys === 1 ? '' : 's'}`;
    }
    return null;
  } catch {
    return null;
  }
}

function looksLikeCode(text: string): boolean {
  const matched = CODE_HINTS.filter((pattern) => pattern.test(text)).length;
  if (matched >= 2) {
    return true;
  }

  // A single strong signal is enough when it is a whole line of shell.
  return matched === 1 && CODE_HINTS[2].test(text);
}
