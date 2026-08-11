import React from 'react';
import type {
  ChatMessage,
  ClipboardHistoryEntry,
  MessageStatus,
  PeerInfo,
  RoomInfo,
  RoomMember
} from '../shared/types';
import { REACTION_CHOICES } from '../shared/types';
import { Badge, Button, Callout, EmptyState } from './ui';
import { clockTime, formatBytes, initials, relativeTime, truncate } from './format';
import { detectContent, isOpenableUrl, type ContentInfo } from '../shared/contentType';
import { splitOnMentions, type MentionTarget } from '../shared/mentions';
import {
  AlertIcon,
  BookmarkIcon,
  ChatIcon,
  CheckAllIcon,
  CheckIcon,
  ClipboardIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  ExitIcon,
  FileIcon,
  ForwardIcon,
  ImageIcon,
  GlobeIcon,
  LockIcon,
  MailIcon,
  MonitorIcon,
  PaperclipIcon,
  PencilIcon,
  PhoneIcon,
  PinIcon,
  QrIcon,
  ReplyIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SmileIcon,
  TrashIcon,
  UsersIcon,
  XIcon
} from './icons';

// ------------------------------------------------------------------ clipboard

export function ClipboardPanel({
  room,
  entries,
  deviceId,
  searchRef,
  onCopy,
  onDelete,
  onTogglePin,
  onSaveSnippet,
  onOpenUrl,
  quickPasteShortcut,
  onShareNow,
  onClear
}: {
  room: RoomInfo;
  entries: ClipboardHistoryEntry[];
  deviceId: string;
  /** So Ctrl+F can put the cursor here. */
  searchRef?: React.RefObject<HTMLInputElement | null>;
  onCopy: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  onTogglePin: (entryId: string) => void;
  /** Keeps this text permanently, out of the way of the retention sweep. */
  onSaveSnippet: (text: string) => void;
  /** Opens a copied link in the system browser. http/https only. */
  onOpenUrl: (url: string) => void;
  /** Shown as a hint. Empty when the global shortcut is switched off. */
  quickPasteShortcut: string;
  onShareNow: () => void;
  onClear: () => void;
}) {
  const [query, setQuery] = React.useState('');

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? entries.filter(
        (entry) =>
          entry.text.toLowerCase().includes(needle) ||
          entry.deviceName.toLowerCase().includes(needle)
      )
    : entries;

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<ClipboardIcon size={22} />}
        title="Nothing shared yet"
        text={`Copy something on any device in ${room.name} and it appears here. Everything in this room stays on your local network.`}
        actions={
          <Button variant="primary" onClick={onShareNow}>
            <CopyIcon size={15} />
            Share my clipboard now
          </Button>
        }
      />
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <div className="search">
          <SearchIcon size={14} />
          <input
            ref={searchRef}
            className="search__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            placeholder="Search this room's history"
            aria-label="Search clipboard history"
            spellCheck={false}
          />
          {query ? (
            <Button size="sm" icon variant="ghost" onClick={() => setQuery('')} aria-label="Clear search">
              <XIcon size={13} />
            </Button>
          ) : null}
        </div>
        <span className="spacer" />
        <Button size="sm" onClick={onShareNow}>
          <CopyIcon size={14} />
          Share clipboard now
        </Button>
        <Button size="sm" variant="danger" onClick={onClear}>
          <TrashIcon size={14} />
          Clear
        </Button>
      </div>

      {/* This row labels the list under it, so it sits close to the list and
          further from the toolbar above — proximity doing the grouping. */}
      <div className="row row--meta">
        <span className="text-sm text-secondary">
          {needle
            ? `${visible.length} of ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
            : `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`}
        </span>
        <span className="spacer" />
        {/* The shortcut is the fastest way to use any of this and is invisible
            until someone happens to read the settings. It sits here, quietly,
            where the eye already is. */}
        {quickPasteShortcut ? (
          <span className="hint-inline">
            <BookmarkIcon size={13} />
            Press <kbd>{quickPasteShortcut.replace(/\+/g, ' + ')}</kbd> anywhere to paste from here
          </span>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={22} />}
          title="No matches"
          text={`Nothing in ${room.name} matches “${query.trim()}”.`}
          actions={<Button onClick={() => setQuery('')}>Clear search</Button>}
        />
      ) : (
        <div className="feed">
          {visible.map((entry) => (
            <ClipCard
              key={entry.id}
              className={[
                'clip is-clickable',
                entry.pinned ? 'is-pinned' : '',
                // An image needs the full width; a line of text does not.
                entry.kind === 'image' ? 'has-image' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              data-kind={entry.kind === 'image' ? 'image' : detectContent(entry.text).kind}
              // The most common action by far, so the whole card does it rather
              // than a small button you have to hover for.
              onClick={() => onCopy(entry.id)}
              onKeyDown={(event) => {
                // Only when the card itself has focus. Otherwise pressing Enter
                // on one of the action buttons would copy the card as well as
                // doing whatever the button does.
                if (event.target !== event.currentTarget) {
                  return;
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onCopy(entry.id);
                }
              }}
              role="button"
              tabIndex={0}
              title="Click to copy"
            >
              {entry.kind === 'image' ? (
                entry.dataUrl ? (
                  <img className="clip__image" src={entry.dataUrl} alt="Shared clipboard image" />
                ) : (
                  <div className="row text-sm text-tertiary">
                    <ImageIcon size={14} />
                    Image preview was not kept after restart
                  </div>
                )
              ) : (
                <ClipBody text={entry.text} onOpenUrl={onOpenUrl} />
              )}

              {/*
                * Metadata and actions sit at the foot and stay out of the way
                * until wanted. The content is what you came to read; who copied
                * it and when is almost never the question, and a row of buttons
                * on every card turns a list into a control panel.
                */}
              <footer className="clip__foot" onClick={(event) => event.stopPropagation()}>
                <span className="clip__meta">
                  {entry.pinned ? <PinIcon size={11} /> : null}
                  {entry.deviceId === deviceId ? 'You' : entry.deviceName}
                  <span aria-hidden="true">·</span>
                  {relativeTime(entry.timestamp)}
                </span>
                <span className="spacer" />
                <div className="clip__actions">
                  <Button
                    size="sm"
                    icon
                    variant="ghost"
                    onClick={() => onTogglePin(entry.id)}
                    aria-label={entry.pinned ? 'Unpin' : 'Pin so it is never cleared out'}
                    title={entry.pinned ? 'Unpin' : 'Pin'}
                  >
                    <PinIcon size={15} />
                  </Button>
                  {entry.kind === 'text' && entry.text ? (
                    <Button
                      size="sm"
                      icon
                      variant="ghost"
                      onClick={() => onSaveSnippet(entry.text)}
                      aria-label="Keep as a snippet"
                      title="Keep as a snippet"
                    >
                      <BookmarkIcon size={15} />
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    icon
                    variant="ghost"
                    onClick={() => onDelete(entry.id)}
                    aria-label="Remove from history"
                    title="Remove"
                  >
                    <TrashIcon size={15} />
                  </Button>
                  <Button
                    size="sm"
                    icon
                    variant="ghost"
                    onClick={() => onCopy(entry.id)}
                    aria-label="Copy to clipboard"
                    title="Copy"
                  >
                    <CopyIcon size={15} />
                  </Button>
                </div>
              </footer>
            </ClipCard>
          ))}
        </div>
      )}
    </div>
  );
}

/** Grid rows the masonry is built from. Small enough to be invisible. */
const ROW_PX = 8;
/** Space between cards, added to each span rather than as a row gap. */
const CARD_GAP_PX = 12;

/**
 * One card, with a footprint that does not depend on its contents.
 *
 * This is what stops hovering from throwing the page around. The visible surface
 * is absolutely positioned, so when it grows it grows *over* its neighbours; the
 * article behind it keeps a height measured while collapsed, and the grid row
 * span is computed from that. Nothing below ever moves.
 *
 * The earlier attempt made the surface absolute without giving the article a
 * height, so the article had no in-flow content left and collapsed to zero the
 * instant you hovered it — taking every card below it upwards.
 */
function ClipCard({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLElement> & { className: string }) {
  const innerRef = React.useRef<HTMLDivElement>(null);
  const [span, setSpan] = React.useState(1);
  /** Measurements taken while expanded would freeze the expanded size in. */
  const hovering = React.useRef(false);

  React.useLayoutEffect(() => {
    const element = innerRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      if (hovering.current) {
        return;
      }
      const height = element.getBoundingClientRect().height;
      setSpan(Math.max(1, Math.ceil((height + CARD_GAP_PX) / ROW_PX)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <article
      {...rest}
      className={className}
      style={{ gridRowEnd: `span ${span}` }}
      onMouseEnter={() => {
        hovering.current = true;
      }}
      onMouseLeave={() => {
        hovering.current = false;
      }}
    >
      <div className="clip__inner" ref={innerRef}>
        {children}
      </div>
    </article>
  );
}

/** The type of an entry, in a word. Shown at the top of every card. */
function kindLabel(entry: ClipboardHistoryEntry): string {
  if (entry.kind === 'image') {
    return 'Image';
  }
  const info = detectContent(entry.text);
  return info.kind === 'text' ? 'Text' : info.label;
}

/**
 * The leading icon. A colour swatch for a colour, because there is no word for
 * "#4f46e5" that is faster to read than the colour itself.
 */
function ClipKindIcon({ entry }: { entry: ClipboardHistoryEntry }) {
  if (entry.kind === 'image') {
    return <ImageIcon size={13} />;
  }

  const info = detectContent(entry.text);
  if (info.kind === 'color' && info.value) {
    return <span className="clip__swatch" style={{ background: info.value }} aria-hidden="true" />;
  }
  if (info.kind === 'url') return <GlobeIcon size={13} />;
  if (info.kind === 'email') return <MailIcon size={13} />;
  if (info.kind === 'code' || info.kind === 'json') return <FileIcon size={13} />;
  return <ClipboardIcon size={13} />;
}

/**
 * What kind of thing this entry is, said in a badge.
 *
 * A colour gets the colour itself rather than the word — a swatch is the one
 * label that is faster to read than any text could be.
 */
function ContentBadge({ info }: { info: ContentInfo }) {
  if (info.kind === 'text') {
    return null; // Labelling plain text "Text" tells nobody anything.
  }

  if (info.kind === 'color' && info.value) {
    return (
      <Badge>
        <span className="clip__swatch" style={{ background: info.value }} aria-hidden="true" />
        {info.value}
      </Badge>
    );
  }

  return <Badge tone={info.kind === 'url' ? 'accent' : 'neutral'}>{info.label}</Badge>;
}

/**
 * The body of a text entry, rendered according to what it turned out to be.
 *
 * Code gets a monospace block because whitespace is meaningful in it; a link
 * gets an action, because the thing you want to do with a copied link is
 * usually to follow it rather than to paste it somewhere.
 */
/**
 * How tall a clipped entry stands before it is cut.
 *
 * Measured against `scrollHeight` rather than `clientHeight`, so the answer does
 * not change when the entry expands — comparing against the live height would
 * flip the flag off the moment it grew and flicker the fade in and out.
 */
const CLIP_COLLAPSED_PX = 140;

/**
 * A block of copied text that says when there is more of it.
 *
 * The old behaviour cut anything past ~six lines with nothing to indicate it —
 * so a truncated command looked exactly like a complete one, which is worse than
 * useless for something you are about to paste. Now the tail fades out, and
 * hovering (or focusing, for anyone not using a mouse) opens it up.
 */
function ClipText({ text, code }: { text: string; code: boolean }) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [full, setFull] = React.useState(0);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    /*
     * The full height is measured, not guessed.
     *
     * Animating `max-height` to an arbitrary large number is what made this look
     * broken: the browser eases towards 520px, so a 200px block reaches its real
     * size a fifth of the way through and then appears to hang. Easing towards
     * the height the content actually has makes the motion match the distance.
     */
    const measure = () => setFull(element.scrollHeight);
    measure();

    // The same text wraps to a different number of lines as the column width
    // changes, so the measurement has to follow the layout.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  const clipped = full > CLIP_COLLAPSED_PX + 2;

  return (
    <div
      className={clipped ? 'clip__body is-clipped' : 'clip__body'}
      style={clipped ? ({ ['--clip-full' as string]: `${full}px` } as React.CSSProperties) : undefined}
    >
      <pre ref={ref} className={code ? 'clip__text is-code' : 'clip__text'}>
        {text}
      </pre>
      {clipped ? <span className="clip__more">more</span> : null}
    </div>
  );
}

function ClipBody({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => void }) {
  const info = detectContent(text);
  // Generous now that the block scrolls when open; the cap is only a guard
  // against rendering a multi-megabyte paste into the DOM.
  const body = truncate(text, 6000);

  if (info.kind === 'url' && info.value && isOpenableUrl(info.value)) {
    const url = info.value;
    return (
      <div className="clip__link">
        <span className="clip__link-text">{body}</span>
        <Button
          size="sm"
          onClick={(event) => {
            // The card itself copies on click; opening is a different intent.
            event.stopPropagation();
            onOpenUrl(url);
          }}
        >
          Open
        </Button>
      </div>
    );
  }

  if (info.kind === 'color' && info.value) {
    return (
      <div className="clip__color">
        <span className="clip__color-chip" style={{ background: info.value }} aria-hidden="true" />
        <code className="clip__text is-inline">{body}</code>
      </div>
    );
  }

  return <ClipText text={body} code={info.kind === 'code' || info.kind === 'json'} />;
}

// ----------------------------------------------------------------------- chat

/**
 * What the sender sees against their own message.
 *
 * A message counts as delivered or seen only once *every* other accepted member
 * has acknowledged it — a half-delivered message is not delivered. Anything
 * still unacknowledged after a grace period is called undelivered rather than
 * left looking like it is still in flight.
 */
const UNDELIVERED_AFTER_MS = 25000;

function statusOf(message: ChatMessage, room: RoomInfo): MessageStatus {
  const others = room.members
    .filter((member) => member.status === 'accepted' && member.deviceId !== message.deviceId)
    .map((member) => member.deviceId);

  if (others.length === 0) {
    return 'sent';
  }

  const seen = message.seenBy ?? [];
  const delivered = message.deliveredTo ?? [];

  if (others.every((id) => seen.includes(id))) return 'seen';
  if (others.every((id) => delivered.includes(id))) return 'delivered';
  // `delivered.length > 0` alone used to return here too — harmless for a
  // DM, where `others.length` is always 1 and the line above already covers
  // it, but wrong for a room: it reported "Delivered" the moment even one
  // of several accepted members had it, contradicting the invariant this
  // function's own comment states. A genuinely partial delivery now falls
  // through to 'partial' below instead of being reported as complete.
  if (delivered.length > 0) return 'partial';
  return Date.now() - message.timestamp > UNDELIVERED_AFTER_MS ? 'undelivered' : 'sent';
}

function Receipt({ status }: { status: MessageStatus }) {
  if (status === 'undelivered') {
    return (
      <span className="receipt is-undelivered" title="Not delivered — nobody has it yet">
        <ClockIcon size={13} />
      </span>
    );
  }
  if (status === 'seen') {
    return (
      <span className="receipt is-seen" title="Seen by everyone">
        <CheckAllIcon size={14} />
      </span>
    );
  }
  if (status === 'delivered') {
    return (
      <span className="receipt" title="Delivered">
        <CheckAllIcon size={14} />
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="receipt is-partial" title="Delivered to some, not everyone yet">
        <CheckIcon size={13} />
      </span>
    );
  }
  return (
    <span className="receipt" title="Sent">
      <CheckIcon size={13} />
    </span>
  );
}

function ChatAttachment({
  message,
  onSaveFile
}: {
  message: ChatMessage;
  onSaveFile: (messageId: string) => void;
}) {
  const label = message.fileName ?? 'File';
  const size = formatBytes(message.fileSize);

  if (message.type === 'image' && message.dataUrl) {
    return (
      <div className="attach">
        <img className="attach__image" src={message.dataUrl} alt={label} />
        <div className="attach__row">
          <span className="attach__name truncate">{label}</span>
          {size ? <span className="attach__size">{size}</span> : null}
          <Button size="sm" onClick={() => onSaveFile(message.id)}>
            <DownloadIcon size={13} />
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="attach attach--file">
      <span className="attach__icon">
        <FileIcon size={18} />
      </span>
      <div className="attach__body">
        <div className="attach__name truncate">{label}</div>
        <div className="attach__size">
          {message.dataUrl ? size : 'Not kept after restart — ask for it again'}
        </div>
      </div>
      {message.dataUrl ? (
        <Button size="sm" onClick={() => onSaveFile(message.id)}>
          <DownloadIcon size={13} />
          Save
        </Button>
      ) : null}
    </div>
  );
}

/** Messages closer together than this from one person are shown as a run. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
/** How often "still typing" is re-asserted while someone keeps writing. */
const TYPING_PING_MS = 2500;
/** Silence for this long ends it, as does sending. */
const TYPING_IDLE_MS = 3500;

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "Today" / "Yesterday" / "12 Mar 2026" above the first message of each day. */
function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (sameDay(timestamp, today.getTime())) return 'Today';
  if (sameDay(timestamp, yesterday.getTime())) return 'Yesterday';

  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  });
}

/**
 * Ceiling on an image pasted into the composer.
 *
 * The main process enforces the real limit (`MAX_FILE_BYTES`) — this is only so
 * an oversized paste is refused before 50 MB of base64 is built in the renderer
 * and pushed across the IPC boundary to be rejected at the other end. It must
 * not be *stricter* than the main-process limit, or a paste would be refused
 * here that the file picker would have accepted.
 */
const MAX_PASTE_BYTES = 50 * 1024 * 1024;

/** A name for something that arrived on the clipboard with no name of its own. */
function pastedImageName(mimeType: string): string {
  const extension = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
  // Stamped, so pasting several in a row does not offer the same filename in
  // the save dialog every time.
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `pasted-${stamp}.${extension}`;
}

/** The image on a paste event, if there is one. Text pastes fall through untouched. */
function pastedImage(event: React.ClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }
  return null;
}

/** Most names offered at once while typing `@` — enough to choose from, short enough to read. */
const MENTION_CHOICES = 6;

/**
 * The `@` fragment immediately before the caret, or null.
 *
 * Deliberately permissive about spaces: device names have them ("Lab PC 3"), so
 * a fragment runs until something that could not be part of a name. It gives up
 * after a couple of words, otherwise every `@` early in a message would keep
 * matching against the whole rest of the sentence.
 */
function mentionFragment(text: string, caret: number): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret);
  const at = upToCaret.lastIndexOf('@');
  if (at < 0) {
    return null;
  }

  const before = upToCaret[at - 1];
  if (before !== undefined && !/[\s(\[{<"']/.test(before)) {
    return null; // Part of an email address, not the start of a mention.
  }

  const query = upToCaret.slice(at + 1);
  if (query.includes('\n') || query.split(/\s+/).length > 3) {
    return null;
  }

  return { start: at, query };
}

function typingLine(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return `${names[0]} and ${names.length - 1} others are typing…`;
}

/**
 * Message text with any `@Name` picked out.
 *
 * Re-resolved from the roster on every render rather than trusting the stored
 * `mentions` ids, for the same reason the main process re-resolves on receipt:
 * the text is the source of truth, and the roster it is read against is the one
 * this device holds right now. `mentions` is only ever consulted to know
 * whether *this* device was named, which is a question about ids, not spans.
 */
function MessageText({
  content,
  members,
  deviceId
}: {
  content: string;
  members: MentionTarget[];
  deviceId: string;
}) {
  const parts = React.useMemo(() => splitOnMentions(content, members), [content, members]);

  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'mention' ? (
          <span
            key={index}
            className={part.deviceId === deviceId ? 'mention is-me' : 'mention'}
            title={part.deviceId === deviceId ? 'This mentions you' : undefined}
          >
            {part.text}
          </span>
        ) : (
          <React.Fragment key={index}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}

/** The hover toolbar, the reaction picker, and the two ways to delete. */
function MessageRow({
  message,
  room,
  deviceId,
  showHeader,
  showReceipts = true,
  onSaveFile,
  onReply,
  onForward,
  onTogglePin,
  onEdit,
  onDelete,
  onReact,
  onCopy
}: {
  message: ChatMessage;
  room: RoomInfo;
  deviceId: string;
  showHeader: boolean;
  /** Off where there is nothing to track it against — see `statusOf`. */
  showReceipts?: boolean;
  onSaveFile: (messageId: string) => void;
  onReply: (message: ChatMessage) => void;
  /** Absent where there is nowhere to forward to, which hides the button entirely. */
  onForward?: (message: ChatMessage) => void;
  /** Bookmarks the message on this device. Absent hides the button. */
  onTogglePin?: (messageId: string) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (messageId: string, forEveryone: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
  onCopy: (text: string) => void;
}) {
  const [picking, setPicking] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const isMine = message.deviceId === deviceId;

  // Anything already on the message stays offered, even an emoji this build
  // does not list, so a reaction from a newer version is still answerable.
  const used = Object.keys(message.reactions ?? {});
  const choices = [...REACTION_CHOICES, ...used.filter((emoji) => !REACTION_CHOICES.includes(emoji as never))];

  // Named by someone else — a message this device wrote naming itself is not
  // worth flagging, and would otherwise light up every "@me" note-to-self.
  const mentionsMe = !isMine && !message.deleted && Boolean(message.mentions?.includes(deviceId));

  const classes = [
    'msg',
    isMine ? 'is-mine' : '',
    showHeader ? '' : 'is-run',
    message.deleted ? 'is-deleted' : '',
    mentionsMe ? 'is-mention' : '',
    // Also a class, not just the header badge: a message inside a run has no
    // header to put the badge in.
    message.pinned ? 'is-pinned' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {showHeader && (
        <div className="msg__head">
          <span className="msg__author">{isMine ? 'You' : message.deviceName}</span>
          <span className="msg__time">{clockTime(message.timestamp)}</span>
          {message.pinned && (
            <span className="msg__pin" title="Pinned on this device — kept out of the history cap">
              <PinIcon size={11} />
            </span>
          )}
          {isMine && !message.deleted && showReceipts && <Receipt status={statusOf(message, room)} />}
        </div>
      )}

      {message.deleted ? (
        <div className="msg__body msg__deleted">
          <TrashIcon size={13} />
          This message was deleted
        </div>
      ) : (
        <>
          {message.replyTo && (
            <div className="msg__quote" title={message.replyTo.preview}>
              <span className="msg__quote-author">{message.replyTo.deviceName}</span>
              <span className="msg__quote-text truncate">{message.replyTo.preview}</span>
            </div>
          )}

          {message.type === 'text' ? (
            <div className="msg__body">
              <MessageText content={message.content} members={room.members} deviceId={deviceId} />
              {message.editedAt ? <span className="msg__edited" title={`Edited ${clockTime(message.editedAt)}`}>edited</span> : null}
            </div>
          ) : (
            <ChatAttachment message={message} onSaveFile={onSaveFile} />
          )}

          {used.length > 0 && (
            <div className="reactions">
              {used.map((emoji) => {
                const who = message.reactions?.[emoji] ?? [];
                const mine = who.includes(deviceId);
                return (
                  <button
                    key={emoji}
                    className={mine ? 'reaction is-mine' : 'reaction'}
                    onClick={() => onReact(message.id, emoji)}
                    title={mine ? 'You reacted — click to take it back' : `${who.length} reacted`}
                  >
                    <span>{emoji}</span>
                    <span className="reaction__count">{who.length}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {picking && !message.deleted && (
        <div className="msg__picker">
          {choices.map((emoji) => (
            <button
              key={emoji}
              className="msg__picker-emoji"
              onClick={() => {
                onReact(message.id, emoji);
                setPicking(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}

      {confirming && (
        <div className="msg__confirm">
          <span className="msg__confirm-text">
            {isMine ? 'Delete this message…' : 'Remove from this device?'}
          </span>
          <div className="msg__confirm-actions">
            <Button size="sm" onClick={() => { onDelete(message.id, false); setConfirming(false); }}>
              For me
            </Button>
            {isMine && (
              <Button size="sm" variant="danger" onClick={() => { onDelete(message.id, true); setConfirming(false); }}>
                For everyone
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!message.deleted && (
        <div className="msg__tools">
          <button className="msg__tool" onClick={() => setPicking((open) => !open)} title="React" aria-label="React">
            <SmileIcon size={14} />
          </button>
          <button className="msg__tool" onClick={() => onReply(message)} title="Reply" aria-label="Reply">
            <ReplyIcon size={14} />
          </button>
          {onForward && (
            <button className="msg__tool" onClick={() => onForward(message)} title="Forward" aria-label="Forward">
              <ForwardIcon size={14} />
            </button>
          )}
          {onTogglePin && (
            <button
              className={message.pinned ? 'msg__tool is-on' : 'msg__tool'}
              onClick={() => onTogglePin(message.id)}
              title={message.pinned ? 'Unpin' : 'Pin — keeps it out of the history cap, on this device only'}
              aria-label={message.pinned ? 'Unpin' : 'Pin'}
              aria-pressed={Boolean(message.pinned)}
            >
              <PinIcon size={14} />
            </button>
          )}
          {message.type === 'text' && (
            <button className="msg__tool" onClick={() => onCopy(message.content)} title="Copy text" aria-label="Copy text">
              <CopyIcon size={14} />
            </button>
          )}
          {isMine && message.type === 'text' && (
            <button className="msg__tool" onClick={() => onEdit(message)} title="Edit" aria-label="Edit">
              <PencilIcon size={14} />
            </button>
          )}
          <button className="msg__tool" onClick={() => setConfirming(true)} title="Delete" aria-label="Delete">
            <TrashIcon size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({
  room,
  messages,
  deviceId,
  typingNames,
  onSend,
  onSendFile,
  onSendImage,
  canSendFiles,
  onSaveFile,
  onEdit,
  onDelete,
  onReact,
  onCopy,
  onForward,
  onTogglePin,
  onExport,
  onTyping,
  showReceipts = true,
  headerExtra,
  emptyText
}: {
  room: RoomInfo;
  messages: ChatMessage[];
  deviceId: string;
  /** Everyone in this room currently composing, excluding this device. */
  typingNames: string[];
  onSend: (text: string, replyToId?: string) => void;
  onSendFile: () => void;
  /**
   * Sends an image pasted straight into the composer. Absent disables pasting
   * an image, which is what a device restricted from files should get.
   */
  onSendImage?: (dataUrl: string, fileName: string) => void;
  /** False on a phone: the picker and the save dialog are native. */
  canSendFiles: boolean;
  onSaveFile: (messageId: string) => void;
  onEdit: (messageId: string, content: string) => void;
  onDelete: (messageId: string, forEveryone: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
  onCopy: (text: string) => void;
  /** Opens the destination picker. Absent hides the forward button — see `MessageRow`. */
  onForward?: (message: ChatMessage) => void;
  /** Bookmarks a message on this device — see `MessageRow`. */
  onTogglePin?: (messageId: string) => void;
  /** Saves the conversation as a text file. Absent on the phone, where there is no native dialog. */
  onExport?: () => void;
  onTyping: (typing: boolean) => void;
  showReceipts?: boolean;
  /** Rendered at the start of the bar — a back button and a Call button, for a DM thread. */
  headerExtra?: React.ReactNode;
  emptyText?: string;
}) {
  const [draft, setDraft] = React.useState('');
  const [dragging, setDragging] = React.useState(false);
  const [replyTo, setReplyTo] = React.useState<ChatMessage | null>(null);
  const [editing, setEditing] = React.useState<ChatMessage | null>(null);
  const [query, setQuery] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  // Where the caret was when the draft last changed — mention autocomplete
  // reads the fragment before it, and a textarea will not tell us on render.
  const [caret, setCaret] = React.useState(0);
  const [mentionPick, setMentionPick] = React.useState(0);
  // The offset of an `@` whose menu was dismissed with Escape. Kept rather than
  // a plain boolean so starting a *different* mention opens the menu again,
  // while returning to this one leaves it shut.
  const [mentionDismissed, setMentionDismissed] = React.useState(-1);
  // Shown inline above the composer rather than as a toast: it is about the
  // thing being composed right now, and it clears on the next paste.
  const [pasteError, setPasteError] = React.useState('');

  // What this device itself is restricted from doing here — the roster is
  // already synced from the owner, so this needs no request of its own.
  const myRestrictions = room.members.find((member) => member.deviceId === deviceId)?.restricted;

  /*
   * Who `@` can name here: accepted members other than this device. Mentioning
   * yourself is not useful, and offering a member who has not been approved yet
   * would name somebody who cannot read the room.
   */
  const mentionable = React.useMemo(
    () => room.members.filter((member) => member.status === 'accepted' && member.deviceId !== deviceId),
    [room.members, deviceId]
  );

  // Only while composing something new: an edit reuses the same box, but the
  // dropdown appearing over a correction is more startle than help.
  const fragment = editing ? null : mentionFragment(draft, caret);
  const mentionMatches = React.useMemo(() => {
    if (!fragment) {
      return [];
    }
    const needle = fragment.query.toLowerCase();
    return mentionable
      .filter((member) => member.deviceName.toLowerCase().includes(needle))
      .slice(0, MENTION_CHOICES);
  }, [fragment?.query, mentionable]);

  const mentioning = Boolean(fragment) && fragment?.start !== mentionDismissed && mentionMatches.length > 0;

  /** Replaces the `@fragment` under the caret with the chosen name, and a trailing space. */
  function completeMention(member: RoomMember) {
    if (!fragment) {
      return;
    }
    const next = `${draft.slice(0, fragment.start)}@${member.deviceName} ${draft.slice(caret)}`;
    const at = fragment.start + member.deviceName.length + 2;

    setDraft(next);
    setCaret(at);
    setMentionPick(0);
    // The completed name is itself a fragment that would match again, so the
    // menu is shut for this `@` explicitly. Typing on re-opens it.
    setMentionDismissed(fragment.start);

    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(at, at);
    });
  }

  const composerRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Typing is a side effect of writing, so it is kept out of render entirely.
  const typingSince = React.useRef(0);
  const typingStop = React.useRef<number | undefined>(undefined);

  // Pinned to a ref because the caller passes a fresh closure every render:
  // depending on it would make stopTyping a new function each time, and the
  // effect below would then fire its cleanup — retracting "typing…" from
  // everyone else — while the message was still being written.
  const typingRef = React.useRef(onTyping);
  typingRef.current = onTyping;

  const stopTyping = React.useCallback(() => {
    window.clearTimeout(typingStop.current);
    if (typingSince.current > 0) {
      typingSince.current = 0;
      typingRef.current(false);
    }
  }, []);

  // Leaving the room, or closing the window, should not leave everyone else
  // believing this device is still mid-sentence.
  React.useEffect(() => stopTyping, [room.roomId, stopTyping]);

  function noteTyping(next: string, at: number) {
    setDraft(next);
    setCaret(at);
    setMentionPick(0);
    setMentionDismissed(-1);

    if (!next.trim()) {
      stopTyping();
      return;
    }

    const now = Date.now();
    if (now - typingSince.current > TYPING_PING_MS) {
      typingSince.current = now;
      typingRef.current(true);
    }

    window.clearTimeout(typingStop.current);
    typingStop.current = window.setTimeout(stopTyping, TYPING_IDLE_MS);
  }

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }

    stopTyping();
    setMentionPick(0);

    if (editing) {
      onEdit(editing.id, text);
      setEditing(null);
    } else {
      onSend(text, replyTo?.id);
      setReplyTo(null);
    }

    setDraft('');
  }

  /**
   * An image pasted into the composer is sent as an attachment.
   *
   * The bytes are already in hand, so this skips the native picker entirely and
   * goes straight to the same send a picked file uses. Anything that is not an
   * image — text, a file, an empty clipboard — falls through to the textarea's
   * own paste, which is what makes pasting text still work normally.
   */
  function handlePaste(event: React.ClipboardEvent) {
    if (!onSendImage || myRestrictions?.files) {
      return;
    }

    const image = pastedImage(event);
    if (!image) {
      return;
    }

    // Only now, once there is definitely an image to handle: preventing the
    // default on a text paste would swallow it.
    event.preventDefault();

    if (image.size > MAX_PASTE_BYTES) {
      setPasteError(
        `That image is ${(image.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(MAX_PASTE_BYTES / 1024 / 1024)} MB.`
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setPasteError('');
      if (typeof reader.result === 'string') {
        onSendImage(reader.result, image.name || pastedImageName(image.type));
      }
    };
    reader.onerror = () => setPasteError('That image could not be read from the clipboard.');
    reader.readAsDataURL(image);
  }

  function beginEdit(message: ChatMessage) {
    setReplyTo(null);
    setEditing(message);
    setDraft(message.content);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function beginReply(message: ChatMessage) {
    // Leaving edit mode, not just entering reply mode: the box was showing
    // the message being edited, not a new message being composed. Carrying
    // that text over used to mean submit() — seeing `editing` already
    // cleared — sent it as a brand-new reply instead of the edit it looked
    // like on screen, silently discarding the intended edit and posting an
    // unrelated message in its place.
    if (editing) {
      setDraft('');
    }
    setEditing(null);
    setReplyTo(message);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function cancelComposing() {
    setEditing(null);
    setReplyTo(null);
    setDraft('');
    stopTyping();
  }

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? messages.filter(
        (message) =>
          !message.deleted &&
          (message.content.toLowerCase().includes(needle) ||
            message.deviceName.toLowerCase().includes(needle) ||
            (message.fileName ?? '').toLowerCase().includes(needle))
      )
    : messages;

  return (
    <div
      className={dragging ? 'chat is-dragging' : 'chat'}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        // Electron gives a real path, but the picker in the main process is the
        // only place allowed to read it — so a drop just opens that picker.
        if (event.dataTransfer.files.length > 0 && canSendFiles) onSendFile();
      }}
    >
      {dragging && (
        <div className="chat__drop">
          <PaperclipIcon size={26} />
          <span>Drop to attach a file</span>
        </div>
      )}

      <div className="chat__bar">
        {headerExtra}
        {searching ? (
          <>
            <div className="search">
              <SearchIcon size={14} />
              <input
                className="search__input"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setQuery('');
                    setSearching(false);
                  }
                }}
                placeholder={`Search ${room.name}`}
                aria-label="Search messages"
                spellCheck={false}
              />
            </div>
            <span className="text-sm text-tertiary">
              {needle ? `${visible.length} of ${messages.length}` : `${messages.length} messages`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon
              onClick={() => {
                setQuery('');
                setSearching(false);
              }}
              aria-label="Close search"
            >
              <XIcon size={14} />
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm text-secondary">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </span>
            <span className="spacer" />
            {onExport && messages.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onExport}
                title="Save this conversation as a text file"
              >
                <DownloadIcon size={14} />
                Export
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSearching(true)}>
              <SearchIcon size={14} />
              Search
            </Button>
          </>
        )}
      </div>

      <div className="chat__scroll">
        {/* The column is reversed in CSS, so the first child sits at the bottom
            and new messages need no scroll bookkeeping. Anything that belongs
            visually above a message is therefore rendered after it. */}
        {typingNames.length > 0 && (
          <div className="chat__typing">
            <span className="chat__typing-dots">
              <i />
              <i />
              <i />
            </span>
            {typingLine(typingNames)}
          </div>
        )}

        {messages.length === 0 ? (
          <EmptyState
            icon={<ChatIcon size={22} />}
            title="No messages yet"
            text={emptyText ?? `Say something to everyone in ${room.name}.`}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<SearchIcon size={22} />}
            title="No matches"
            text={`Nothing in ${room.name} matches “${query.trim()}”.`}
            actions={<Button onClick={() => setQuery('')}>Clear search</Button>}
          />
        ) : (
          visible.map((message, index) => {
            // The next entry is the older one: the list runs newest first.
            const older = visible[index + 1];
            const opensDay = !older || !sameDay(older.timestamp, message.timestamp);
            const inRun =
              !opensDay &&
              Boolean(older) &&
              older.deviceId === message.deviceId &&
              message.timestamp - older.timestamp < GROUP_WINDOW_MS;

            return (
              <React.Fragment key={message.id}>
                <MessageRow
                  message={message}
                  room={room}
                  deviceId={deviceId}
                  showHeader={!inRun}
                  showReceipts={showReceipts}
                  onSaveFile={onSaveFile}
                  onReply={beginReply}
                  onForward={onForward}
                  onTogglePin={onTogglePin}
                  onEdit={beginEdit}
                  onDelete={onDelete}
                  onReact={onReact}
                  onCopy={onCopy}
                />
                {opensDay && (
                  <div className="chat__day">
                    <span>{dayLabel(message.timestamp)}</span>
                  </div>
                )}
              </React.Fragment>
            );
          })
        )}
      </div>

      {(replyTo || editing) && (
        <div className="composer__context">
          <span className="composer__context-icon">
            {editing ? <PencilIcon size={14} /> : <ReplyIcon size={14} />}
          </span>
          <div className="composer__context-body">
            <div className="composer__context-title">
              {editing ? 'Editing your message' : `Replying to ${replyTo?.deviceName}`}
            </div>
            <div className="composer__context-text truncate">
              {editing ? editing.content : (replyTo?.content || replyTo?.fileName || 'Attachment')}
            </div>
          </div>
          <Button size="sm" variant="ghost" icon onClick={cancelComposing} aria-label="Cancel">
            <XIcon size={14} />
          </Button>
        </div>
      )}

      {pasteError && (
        <div className="composer__context">
          <span className="composer__context-icon">
            <AlertIcon size={14} />
          </span>
          <div className="composer__context-body">
            <div className="composer__context-title">That image was not sent</div>
            <div className="composer__context-text">{pasteError}</div>
          </div>
          <Button size="sm" variant="ghost" icon onClick={() => setPasteError('')} aria-label="Dismiss">
            <XIcon size={14} />
          </Button>
        </div>
      )}

      {myRestrictions?.chat ? (
        <Callout
          tone="warning"
          icon={<AlertIcon size={17} />}
          title="You can't send messages here"
          text={`The owner of ${room.name} has restricted this device from sending messages in this room.`}
        />
      ) : (
        <div className="composer">
          {mentioning && (
            <div className="mention-menu" role="listbox" aria-label="Mention someone">
              {mentionMatches.map((member, index) => (
                <button
                  key={member.deviceId}
                  type="button"
                  role="option"
                  aria-selected={index === mentionPick}
                  className={index === mentionPick ? 'mention-menu__item is-active' : 'mention-menu__item'}
                  // The composer must not lose focus, or the caret position
                  // this insert is measured against is gone by the time it runs.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setMentionPick(index)}
                  onClick={() => completeMention(member)}
                >
                  <span className="mention-menu__avatar">{initials(member.deviceName)}</span>
                  <span className="truncate">{member.deviceName}</span>
                </button>
              ))}
            </div>
          )}

          {/* The picker is a native dialog on the machine with the files on it. */}
          {canSendFiles ? (
            <Button
              icon
              onClick={onSendFile}
              disabled={Boolean(myRestrictions?.files)}
              aria-label="Attach a file"
              title={
                myRestrictions?.files
                  ? `You've been restricted from sending files in ${room.name}.`
                  : 'Attach a file'
              }
            >
              <PaperclipIcon size={16} />
            </Button>
          ) : null}
          <textarea
            ref={composerRef}
            className="input composer__input"
            value={draft}
            rows={1}
            onChange={(event) => noteTyping(event.target.value, event.target.selectionStart)}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onPaste={handlePaste}
            onBlur={() => {
              stopTyping();
              // The mention menu had no dismiss-on-blur at all — clicking
              // anywhere else in the still-mounted panel (reacting to a
              // message, opening search) left it rendered and visually
              // live with nothing left pointing at it, since only Escape or
              // a further draft/caret change ever closed it. A click on the
              // menu itself never reaches here — its own `onMouseDown`
              // already prevents the blur that would otherwise cause.
              if (mentioning) {
                setMentionDismissed(fragment?.start ?? -1);
              }
            }}
            onKeyDown={(event) => {
              // The mention menu owns these keys while it is open, so Enter
              // picks a name rather than sending a half-typed one.
              if (mentioning) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : mentionMatches.length - 1;
                  setMentionPick((current) => (current + step) % mentionMatches.length);
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  completeMention(mentionMatches[mentionPick] ?? mentionMatches[0]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setMentionDismissed(fragment?.start ?? -1);
                  return;
                }
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
                return;
              }
              if (event.key === 'Escape' && (editing || replyTo)) {
                event.preventDefault();
                cancelComposing();
              }
            }}
            placeholder={editing ? 'Edit your message' : `Message ${room.name}`}
            aria-label="Message"
          />
          <Button variant="primary" onClick={submit} disabled={!draft.trim()}>
            <SendIcon size={15} />
            {editing ? 'Save' : 'Send'}
          </Button>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- members

export function MembersPanel({
  room,
  deviceId,
  onApprove,
  onReject,
  onRemove,
  onBlock,
  onRestrict,
  onCallRequest,
  canCall,
  onMessageRequest,
  onRemoteRequest,
  canRemote,
  onEdit,
  onLeave,
  onCopyCode,
  onRequestQr,
  peers,
  invitedIds,
  onInvite
}: {
  room: RoomInfo;
  deviceId: string;
  peers: PeerInfo[];
  /** Devices already invited to this room and not yet heard back from. */
  invitedIds: string[];
  onInvite: (targetDeviceId: string) => void;
  onApprove: (memberId: string) => void;
  onReject: (memberId: string) => void;
  onRemove: (memberId: string) => void;
  /** Refuses this device everywhere, not just in this room. */
  onBlock: (memberId: string, memberName: string) => void;
  /** Owner only. A lesser tier than a block — narrows what this member may do in this one room. */
  onRestrict: (member: RoomMember) => void;
  /** Rings that one member directly instead of the whole room. */
  onCallRequest: (memberId: string) => void;
  /** True wherever a call can actually be placed — a phone included. */
  canCall: boolean;
  /** Opens a private thread with that one member — no room involved. */
  onMessageRequest: (memberId: string, memberName: string) => void;
  /** Asks that device for its screen. They still have to allow it. */
  onRemoteRequest: (memberId: string, memberName: string) => void;
  /** False on a phone: there is no way to display somebody's desktop here. */
  canRemote: boolean;
  /** Owner only. Opens the dialog for renaming, re-typing or re-keying. */
  onEdit: () => void;
  onLeave: () => void;
  onCopyCode: (code: string) => void;
  onRequestQr: (roomId: string) => Promise<string | null>;
}) {
  const isOwner = room.ownerId === deviceId;
  // Anyone on the network who is not already in the room, invited or not.
  const invitable = peers.filter(
    (peer) => !room.members.some((member) => member.deviceId === peer.id)
  );
  const [qr, setQr] = React.useState<string | null>(null);
  const [showQr, setShowQr] = React.useState(false);

  React.useEffect(() => {
    // Invalidated on the room's join code too, not just the room itself — a
    // regenerated code left the cached image encoding the old, now-rejected
    // one while the text next to it (read straight from `room.joinCode`)
    // correctly showed the new one. `toggleQr`'s `if (!qr)` guard means
    // hiding and reshowing the panel was not enough to pick up a fresh
    // fetch on its own; only a real invalidation forces one.
    setShowQr(false);
    setQr(null);
  }, [room.roomId, room.joinCode]);

  async function toggleQr() {
    if (showQr) {
      setShowQr(false);
      return;
    }
    setShowQr(true);
    if (!qr) {
      setQr(await onRequestQr(room.roomId));
    }
  }
  const pending = room.members.filter((member) => member.status === 'pending');
  const accepted = room.members.filter((member) => member.status === 'accepted');

  return (
    <div className="stack">
      {isOwner && pending.length > 0 && (
        <section className="card">
          <div className="card__header">
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Waiting for your approval</h3>
              <p className="card__desc">
                These devices know the room password but cannot read anything until you let them in.
              </p>
            </div>
            <Badge tone="warning">{pending.length}</Badge>
          </div>

          {pending.map((member) => (
            <div key={member.deviceId} className="member">
              <span className="member__avatar">{initials(member.deviceName)}</span>
              <div className="member__body">
                <div className="member__name">{member.deviceName}</div>
                <div className="member__meta">Requested {relativeTime(member.joinedAt)}</div>
              </div>
              <div className="member__actions">
                <Button size="sm" variant="primary" onClick={() => onApprove(member.deviceId)}>
                  <CheckIcon size={14} />
                  Approve
                </Button>
                <Button size="sm" variant="danger" onClick={() => onReject(member.deviceId)}>
                  <XIcon size={14} />
                  Decline
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {isOwner && (
        <section className="card">
          <div className="card__header">
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Devices on this network</h3>
              <p className="card__desc">
                Invite someone directly instead of passing on a code. They still have to
                accept, and you still have to approve them.
              </p>
            </div>
            <Badge>{invitable.length}</Badge>
          </div>

          {invitable.length === 0 ? (
            <p className="text-sm text-tertiary" style={{ paddingTop: 'var(--space-2)' }}>
              No other devices are visible right now. They appear here once the app is
              running on them and they are on the same network.
            </p>
          ) : (
            invitable.map((peer) => {
              const invited = invitedIds.includes(peer.id);
              return (
                <div key={peer.id} className="member">
                  <span className="member__avatar">{initials(peer.name)}</span>
                  <div className="member__body">
                    <div className="member__name">{peer.name}</div>
                    <div className="member__meta">
                      {invited ? 'Invited — waiting for them to accept' : peer.host}
                    </div>
                  </div>
                  <div className="member__actions">
                    <Button
                      size="sm"
                      variant={invited ? 'ghost' : 'default'}
                      onClick={() => onInvite(peer.id)}
                      disabled={invited}
                    >
                      {invited ? (
                        <>
                          <CheckIcon size={14} />
                          Invited
                        </>
                      ) : (
                        <>
                          <SendIcon size={14} />
                          Invite
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </section>
      )}

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Members</h3>
            <p className="card__desc">Devices that can read and write in this room.</p>
          </div>
          <Badge>{accepted.length}</Badge>
        </div>

        {accepted.map((member) => (
          <div key={member.deviceId} className="member">
            <span className="member__avatar">{initials(member.deviceName)}</span>
            <div className="member__body">
              <div className="member__name">
                {member.deviceId === deviceId ? `${member.deviceName} (this device)` : member.deviceName}
                {member.role === 'owner' ? <Badge tone="accent">Owner</Badge> : null}
                {/* Visible to everyone, not just the owner and the member it names —
                    a restriction nobody else can see is a restriction that reads as
                    a mystery when a message from this member never arrives. */}
                {member.restricted ? <Badge tone="warning">Restricted</Badge> : null}
              </div>
              <div className="member__meta">Joined {relativeTime(member.joinedAt)}</div>
            </div>
            {member.deviceId !== deviceId && (
              <div className="member__actions">
                {/* Rings this one member directly rather than the whole room —
                    otherwise identical to a room call once it is answered.
                    Gated on media access alone, not `canRemote` — a phone can
                    place this the same way it can a room call. */}
                {canCall && (
                  <Button
                    size="sm"
                    onClick={() => onCallRequest(member.deviceId)}
                    title={`Call ${member.deviceName} directly`}
                  >
                    <PhoneIcon size={14} />
                    Call
                  </Button>
                )}
                {/* A private thread with this one member — no room involved.
                    Native only, the same as `dmSend` itself. */}
                {canRemote && (
                  <Button
                    size="sm"
                    onClick={() => onMessageRequest(member.deviceId, member.deviceName)}
                    title={`Message ${member.deviceName} directly`}
                  >
                    <ChatIcon size={14} />
                    Message
                  </Button>
                )}
                {/* Asking is always allowed; it is answering that is guarded,
                    and that happens on the other machine. */}
                {canRemote && (
                  <Button
                    size="sm"
                    onClick={() => onRemoteRequest(member.deviceId, member.deviceName)}
                    title={`Ask ${member.deviceName} to share their screen`}
                  >
                    <MonitorIcon size={14} />
                    Screen
                  </Button>
                )}
                {/* Blocking is a decision about a device, not about this room,
                    so anyone can make it about anyone — unlike removal, which
                    is the owner's to do. Neither depends on a native feature,
                    so neither should have been hidden by the same gate that
                    hides screen-sharing. */}
                <Button
                  size="sm"
                  onClick={() => onBlock(member.deviceId, member.deviceName)}
                  title={`Stop dealing with ${member.deviceName} entirely`}
                >
                  Block
                </Button>
                {isOwner && (
                  <Button
                    size="sm"
                    variant={member.restricted ? 'primary' : 'default'}
                    onClick={() => onRestrict(member)}
                    title={`Choose what ${member.deviceName} may do in ${room.name}`}
                  >
                    Restrict
                  </Button>
                )}
                {isOwner && (
                  <Button size="sm" variant="danger" onClick={() => onRemove(member.deviceId)}>
                    Remove
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Security</h3>
            <p className="card__desc">How this room is protected on the network.</p>
          </div>
          {isOwner && (
            <Button size="sm" onClick={onEdit}>
              <PencilIcon size={14} />
              Edit room
            </Button>
          )}
        </div>

        <div className="stack">
          <Callout
            tone={room.encrypted ? 'accent' : 'warning'}
            icon={room.encrypted ? <ShieldIcon size={18} /> : <AlertIcon size={18} />}
            title={room.encrypted ? 'End-to-end encrypted' : 'Not encrypted'}
            text={
              room.encrypted
                ? 'Everything sent in this room is sealed with AES-256-GCM using a key derived from the room password. The password itself never travels over the network.'
                : 'This is an open room, so its contents travel as plain text on the WiFi. Add a password when you create a room to encrypt it.'
            }
          />

          <Callout
            tone="accent"
            icon={room.type === 'private' ? <LockIcon size={18} /> : <UsersIcon size={18} />}
            title={room.type === 'private' ? 'Private — approval required' : 'Public — open to the network'}
            text={
              room.type === 'private'
                ? 'New devices must supply the join code and password, and then be approved by the owner.'
                : 'Any device on this network can join instantly.'
            }
          />

          {isOwner && room.joinCode && (
            <div>
              <div className="field__label" style={{ marginBottom: 6 }}>
                Join code
              </div>
              <div className="code-block">
                <span className="code-block__value">{room.joinCode}</span>
                <span className="spacer" />
                <Button size="sm" onClick={() => onCopyCode(room.joinCode!)}>
                  <CopyIcon size={14} />
                  Copy
                </Button>
                <Button size="sm" onClick={toggleQr} aria-expanded={showQr}>
                  <QrIcon size={14} />
                  {showQr ? 'Hide QR' : 'QR code'}
                </Button>
              </div>

              {showQr && (
                <div className="qr">
                  {qr ? (
                    <img className="qr__image" src={qr} alt={`QR code for join code ${room.joinCode}`} />
                  ) : (
                    <span className="text-sm text-tertiary">Generating…</span>
                  )}
                  <p className="qr__note">
                    Scanning gives the join code only. The password still has to be shared
                    separately — never put it on screen next to this.
                  </p>
                </div>
              )}

              <p className="field__hint" style={{ marginTop: 6 }}>
                Share this with the password to let someone request access.
              </p>
            </div>
          )}

          {/* Closing takes the room away from everyone in it; leaving only
              takes it away from here. The distinction is worth spelling out
              next to the button rather than only in the confirmation. */}
          <Callout
            tone="warning"
            icon={<AlertIcon size={18} />}
            title={isOwner ? 'Closing this room ends it for everyone' : 'Leaving removes it from this device'}
            text={
              isOwner
                ? `${room.name} disappears from every device in it, and its history here is deleted. There is no way to undo it or to reopen the same room.`
                : `You stop receiving anything shared in ${room.name} and its history on this device is deleted. You can rejoin later with the code and password.`
            }
            action={
              <Button variant="danger" onClick={onLeave}>
                <ExitIcon size={15} />
                {isOwner ? 'Close room' : 'Leave room'}
              </Button>
            }
          />
        </div>
      </section>
    </div>
  );
}
