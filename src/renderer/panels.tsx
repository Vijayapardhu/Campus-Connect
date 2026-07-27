import React from 'react';
import type {
  ChatMessage,
  ClipboardHistoryEntry,
  MessageStatus,
  PeerInfo,
  RoomInfo
} from '../shared/types';
import { Badge, Button, Callout, EmptyState } from './ui';
import { clockTime, formatBytes, initials, relativeTime, truncate } from './format';
import {
  AlertIcon,
  ChatIcon,
  CheckAllIcon,
  CheckIcon,
  ClipboardIcon,
  ClockIcon,
  CopyIcon,
  DownloadIcon,
  ExitIcon,
  FileIcon,
  ImageIcon,
  LockIcon,
  PaperclipIcon,
  PinIcon,
  QrIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
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

      <span className="text-sm text-secondary">
        {needle
          ? `${visible.length} of ${entries.length} ${entries.length === 1 ? 'item' : 'items'}`
          : `${entries.length} ${entries.length === 1 ? 'item' : 'items'}`}
      </span>

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
            <article
              key={entry.id}
              className={entry.pinned ? 'clip is-pinned is-clickable' : 'clip is-clickable'}
              // The most common action by far, so the whole card does it rather
              // than a small button you have to hover for.
              onClick={() => onCopy(entry.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onCopy(entry.id);
                }
              }}
              role="button"
              tabIndex={0}
              title="Click to copy"
            >
              <header className="clip__head">
                <span className={entry.deviceId === deviceId ? 'clip__author is-me' : 'clip__author'}>
                  {entry.deviceId === deviceId ? 'You' : entry.deviceName}
                </span>
                <span className="clip__time">{relativeTime(entry.timestamp)}</span>
                {entry.pinned ? (
                  <Badge tone="accent">
                    <PinIcon size={10} />
                    Pinned
                  </Badge>
                ) : null}
                {entry.kind === 'image' ? <Badge>Image</Badge> : null}
                <span className="spacer" />
                <div
                  className={entry.pinned ? 'clip__actions is-visible' : 'clip__actions'}
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    size="sm"
                    icon
                    variant={entry.pinned ? 'primary' : 'default'}
                    onClick={() => onTogglePin(entry.id)}
                    aria-label={entry.pinned ? 'Unpin' : 'Pin so it is never cleared out'}
                    title={entry.pinned ? 'Unpin' : 'Pin'}
                  >
                    <PinIcon size={14} />
                  </Button>
                  <Button size="sm" icon onClick={() => onCopy(entry.id)} aria-label="Copy to clipboard" title="Copy">
                    <CopyIcon size={14} />
                  </Button>
                  <Button
                    size="sm"
                    icon
                    variant="ghost"
                    onClick={() => onDelete(entry.id)}
                    aria-label="Remove from history"
                    title="Remove"
                  >
                    <TrashIcon size={14} />
                  </Button>
                </div>
              </header>

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
                <pre className="clip__text">{truncate(entry.text, 2000)}</pre>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
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
  if (delivered.length > 0) return 'delivered';
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

export function ChatPanel({
  room,
  messages,
  deviceId,
  onSend,
  onSendFile,
  onSaveFile
}: {
  room: RoomInfo;
  messages: ChatMessage[];
  deviceId: string;
  onSend: (text: string) => void;
  onSendFile: () => void;
  onSaveFile: (messageId: string) => void;
}) {
  const [draft, setDraft] = React.useState('');
  const [dragging, setDragging] = React.useState(false);

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSend(text);
    setDraft('');
  }

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
        if (event.dataTransfer.files.length > 0) onSendFile();
      }}
    >
      {dragging && (
        <div className="chat__drop">
          <PaperclipIcon size={26} />
          <span>Drop to attach a file</span>
        </div>
      )}
      <div className="chat__scroll">
        {messages.length === 0 ? (
          <EmptyState
            icon={<ChatIcon size={22} />}
            title="No messages yet"
            text={`Say something to everyone in ${room.name}.`}
          />
        ) : (
          // The column is reversed in CSS so new messages sit at the bottom
          // without any scroll bookkeeping.
          messages.map((message) => (
            <div
              key={message.id}
              className={message.deviceId === deviceId ? 'msg is-mine' : 'msg'}
            >
              <div className="msg__head">
                <span className="msg__author">
                  {message.deviceId === deviceId ? 'You' : message.deviceName}
                </span>
                <span className="msg__time">{clockTime(message.timestamp)}</span>
                {message.deviceId === deviceId && <Receipt status={statusOf(message, room)} />}
              </div>
              {message.type === 'text' ? (
                <div className="msg__body">{message.content}</div>
              ) : (
                <ChatAttachment message={message} onSaveFile={onSaveFile} />
              )}
            </div>
          ))
        )}
      </div>

      <div className="composer">
        <Button icon onClick={onSendFile} aria-label="Attach a file" title="Attach a file">
          <PaperclipIcon size={16} />
        </Button>
        <input
          className="input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={`Message ${room.name}`}
          aria-label="Message"
        />
        <Button variant="primary" onClick={submit} disabled={!draft.trim()}>
          <SendIcon size={15} />
          Send
        </Button>
      </div>
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
    // Re-render whenever the room changes; the code is baked into the image.
    setShowQr(false);
    setQr(null);
  }, [room.roomId]);

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
              </div>
              <div className="member__meta">Joined {relativeTime(member.joinedAt)}</div>
            </div>
            {isOwner && member.deviceId !== deviceId && (
              <div className="member__actions">
                <Button size="sm" variant="danger" onClick={() => onRemove(member.deviceId)}>
                  Remove
                </Button>
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

          <div className="row row--end">
            <Button variant="danger" onClick={onLeave}>
              <ExitIcon size={15} />
              {isOwner ? 'Close this room' : 'Leave room'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
