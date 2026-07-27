import React from 'react';
import type { ChatMessage, ClipboardHistoryEntry, RoomInfo } from '../shared/types';
import { Badge, Button, Callout, EmptyState } from './ui';
import { clockTime, initials, relativeTime, truncate } from './format';
import {
  AlertIcon,
  ChatIcon,
  CheckIcon,
  ClipboardIcon,
  CopyIcon,
  ExitIcon,
  ImageIcon,
  LockIcon,
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
  onCopy,
  onDelete,
  onShareNow,
  onClear
}: {
  room: RoomInfo;
  entries: ClipboardHistoryEntry[];
  deviceId: string;
  onCopy: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  onShareNow: () => void;
  onClear: () => void;
}) {
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
        <span className="text-sm text-secondary">
          {entries.length} {entries.length === 1 ? 'item' : 'items'}
        </span>
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

      <div className="feed">
        {entries.map((entry) => (
          <article key={entry.id} className="clip">
            <header className="clip__head">
              <span className={entry.deviceId === deviceId ? 'clip__author is-me' : 'clip__author'}>
                {entry.deviceId === deviceId ? 'You' : entry.deviceName}
              </span>
              <span className="clip__time">{relativeTime(entry.timestamp)}</span>
              {entry.kind === 'image' ? <Badge>Image</Badge> : null}
              <span className="spacer" />
              <div className="clip__actions">
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
    </div>
  );
}

// ----------------------------------------------------------------------- chat

export function ChatPanel({
  room,
  messages,
  deviceId,
  onSend
}: {
  room: RoomInfo;
  messages: ChatMessage[];
  deviceId: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = React.useState('');

  function submit() {
    const text = draft.trim();
    if (!text) {
      return;
    }
    onSend(text);
    setDraft('');
  }

  return (
    <div className="chat">
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
              </div>
              <div className="msg__body">
                {message.type === 'file' ? `📎 ${message.fileName ?? 'File'}` : message.content}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="composer">
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
  onCopyCode
}: {
  room: RoomInfo;
  deviceId: string;
  onApprove: (memberId: string) => void;
  onReject: (memberId: string) => void;
  onRemove: (memberId: string) => void;
  onLeave: () => void;
  onCopyCode: (code: string) => void;
}) {
  const isOwner = room.ownerId === deviceId;
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
              </div>
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
