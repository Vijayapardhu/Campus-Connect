/**
 * Finding `@Name` in a chat message.
 *
 * The awkward part is that a device name is whatever its owner typed — "Vijaya's
 * Laptop", "Lab PC 3", "phone" — so there is no character that reliably ends a
 * mention. A regex like `@(\w+)` would clip every name with a space in it, and
 * requiring the user to type `@"Lab PC 3"` is not something anyone would do.
 *
 * So this does not parse `@Name` in the abstract at all: it matches against the
 * roster it is given, longest name first. "@Lab PC 3" resolves to that member
 * rather than to a member called "Lab", and a name that matches nobody is left
 * as ordinary text. That also means a mention is only ever as trustworthy as the
 * roster it was resolved against, which is why the main process re-resolves on
 * receipt rather than believing a sender's list of ids — see `postChatMessage`.
 *
 * Lives in `shared` because both sides need the same answer: the main process to
 * decide who was mentioned, the renderer to underline the same spans the main
 * process counted. Testable in plain Node, like `contentType.ts`.
 */

/** The part of a roster member this needs — deliberately narrow, so a `RoomMember` or a DM peer both fit. */
export type MentionTarget = {
  deviceId: string;
  deviceName: string;
};

/** One resolved `@Name` and exactly where it sits in the string. */
export type MentionSpan = {
  /** Index of the `@`. */
  start: number;
  /** Index just past the last character of the name. */
  end: number;
  deviceId: string;
  deviceName: string;
};

/**
 * True when `char` may sit immediately before an `@` that starts a mention.
 *
 * Keeps an email address out: in `someone@Alice` the `@` follows a letter, so it
 * is part of an address rather than the start of a mention.
 */
function opensMention(char: string | undefined): boolean {
  return char === undefined || /[\s(\[{<"'—–-]/.test(char);
}

/**
 * True when `char` may sit immediately after a matched name.
 *
 * Without this, a roster holding both "Ali" and "Alice" could resolve "@Alice"
 * to "Ali" and leave "ce" behind. Longest-first ordering already prevents that
 * particular case, but only this makes it true in general.
 */
function closesMention(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}_]/u.test(char);
}

/**
 * Every `@Name` in `content` that names somebody on `members`, in the order
 * they appear. Overlapping matches are impossible: scanning resumes past the
 * end of each match.
 */
export function findMentions(content: string, members: MentionTarget[]): MentionSpan[] {
  if (!content.includes('@') || members.length === 0) {
    return [];
  }

  // Longest first, so "@Lab PC 3" is not cut short by a member called "Lab".
  const candidates = members
    .filter((member) => member.deviceName.trim().length > 0)
    .slice()
    .sort((a, b) => b.deviceName.length - a.deviceName.length);

  const haystack = content.toLowerCase();
  const spans: MentionSpan[] = [];

  for (let index = 0; index < content.length; index++) {
    if (content[index] !== '@' || !opensMention(content[index - 1])) {
      continue;
    }

    const nameStart = index + 1;
    const matched = candidates.find((member) => {
      const name = member.deviceName.toLowerCase();
      return (
        haystack.startsWith(name, nameStart) &&
        closesMention(content[nameStart + name.length])
      );
    });

    if (matched) {
      const end = nameStart + matched.deviceName.length;
      spans.push({ start: index, end, deviceId: matched.deviceId, deviceName: matched.deviceName });
      index = end - 1; // The loop's own ++ moves past the match.
    }
  }

  return spans;
}

/** The device ids mentioned in `content`, each listed once, in first-appearance order. */
export function mentionedDeviceIds(content: string, members: MentionTarget[]): string[] {
  const seen = new Set<string>();
  for (const span of findMentions(content, members)) {
    seen.add(span.deviceId);
  }
  return [...seen];
}

/**
 * `content` split into the plain runs and the mentions between them, ready to
 * render. Always alternates as it appears in the text; a string with no
 * mentions comes back as a single text part, so the caller needs no special
 * case for the common message.
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; deviceId: string };

export function splitOnMentions(content: string, members: MentionTarget[]): MessagePart[] {
  const spans = findMentions(content, members);
  if (spans.length === 0) {
    return [{ kind: 'text', text: content }];
  }

  const parts: MessagePart[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      parts.push({ kind: 'text', text: content.slice(cursor, span.start) });
    }
    parts.push({ kind: 'mention', text: content.slice(span.start, span.end), deviceId: span.deviceId });
    cursor = span.end;
  }

  if (cursor < content.length) {
    parts.push({ kind: 'text', text: content.slice(cursor) });
  }

  return parts;
}
