/**
 * Turning a conversation into a file somebody can keep.
 *
 * Plain text rather than JSON. An exported conversation is nearly always read by
 * a person — pasted into a ticket, attached to an email, kept as a record of who
 * agreed to what — and a format that needs a tool to read defeats that. Nothing
 * here round-trips back into the app, and it is not meant to: this is an export,
 * not a backup.
 *
 * Room chat and direct messages share one formatter because they are the same
 * artefact from the reader's point of view. The two managers store different
 * shapes, so each maps into `TranscriptEntry` before handing it over.
 *
 * Lives in `shared` so it can be tested in plain Node — the exact bytes written
 * to a file the user keeps are worth pinning down.
 */

export type TranscriptEntry = {
  timestamp: number;
  author: string;
  type: 'text' | 'file' | 'image';
  content: string;
  fileName?: string;
  /** Withdrawn for everyone: the row survives as a marker, with nothing in it. */
  deleted?: boolean;
  editedAt?: number;
};

export type TranscriptOptions = {
  /** "Team Room" or a peer's name — whatever the conversation is called. */
  title: string;
  /** When the export was taken. Passed in rather than read, so this stays pure. */
  exportedAt: number;
  /**
   * Renders one timestamp. Injected because the default is locale- and
   * timezone-dependent, which is right for a person reading the file and wrong
   * for a test asserting on its contents.
   */
  formatTime?: (timestamp: number) => string;
};

/** "08 Aug 2026, 14:32" — unambiguous about the month, which a numeric date is not. */
function defaultTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** What one message reads as, once it is a line of text rather than a bubble. */
function lineFor(entry: TranscriptEntry): string {
  if (entry.deleted) {
    return '(message deleted)';
  }

  if (entry.type !== 'text') {
    const name = entry.fileName || 'attachment';
    const label = entry.type === 'image' ? 'sent an image' : 'sent a file';
    // The bytes are not in the transcript, so the name is all there is to say.
    return `[${label}: ${name}]`;
  }

  const edited = entry.editedAt ? ' (edited)' : '';
  // A message that runs over several lines is indented under its own header,
  // so a stray newline in someone's message cannot be mistaken for a new one.
  const [first, ...rest] = entry.content.split('\n');
  const body = rest.length > 0 ? [first, ...rest.map((line) => `    ${line}`)].join('\n') : first;
  return `${body}${edited}`;
}

/**
 * The whole conversation as text, oldest first.
 *
 * Callers pass entries in whatever order they hold them; this sorts, because
 * both history managers store newest-first and a transcript that reads backwards
 * is not one anybody wants.
 */
export function formatTranscript(entries: TranscriptEntry[], options: TranscriptOptions): string {
  const when = options.formatTime ?? defaultTime;
  const ordered = entries.slice().sort((a, b) => a.timestamp - b.timestamp);

  const header = [
    `Campus Connect — ${options.title}`,
    `Exported ${when(options.exportedAt)}`,
    `${ordered.length} ${ordered.length === 1 ? 'message' : 'messages'}`,
    ''.padEnd(60, '-'),
    ''
  ];

  const body = ordered.map((entry) => `[${when(entry.timestamp)}] ${entry.author}: ${lineFor(entry)}`);

  // A trailing newline, so the file ends the way a text file should.
  return [...header, ...body, ''].join('\n');
}

/** A filename that is safe on every platform this runs on, and still recognisable. */
export function transcriptFileName(title: string, exportedAt: number): string {
  const stamp = new Date(exportedAt).toISOString().slice(0, 10);
  const safe = title
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${safe || 'conversation'}-${stamp}.txt`;
}
