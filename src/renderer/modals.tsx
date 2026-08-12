import React from 'react';
import type {
  AppSettings,
  AppState,
  DiscoveredRoom,
  DmThreadSummary,
  PeerInfo,
  RoomInfo,
  RoomInvite,
  RoomMember,
  RoomRestrictions,
  RoomType,
  RoomUpdate
} from '../shared/types';
import { APP_INFO, FONT_SCALES, MAX_FONT_SCALE, MIN_FONT_SCALE } from '../shared/types';
import { Button, Field, Modal, SwitchRow } from './ui';
import { initials, passwordStrength } from './format';
import { listSystemFonts } from './fonts';
import {
  ChatIcon,
  ClipboardIcon,
  ForwardIcon,
  GithubIcon,
  GlobeIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  UsersIcon
} from './icons';

// ------------------------------------------------------------- create a room

export function CreateRoomModal({
  onClose,
  onCreate
}: {
  onClose: () => void;
  onCreate: (name: string, type: RoomType, password: string) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [type, setType] = React.useState<RoomType>('private');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const strength = passwordStrength(password);
  // Private rooms are approval-gated, which is only meaningful with a secret.
  const passwordRequired = type === 'private';

  async function submit() {
    if (!name.trim()) {
      setError('Give the room a name.');
      return;
    }
    if (passwordRequired && password.length < 4) {
      setError('Private rooms need a password of at least 4 characters.');
      return;
    }

    setBusy(true);
    const created = await onCreate(name.trim(), type, password);
    setBusy(false);
    if (created) {
      onClose();
    }
  }

  return (
    <Modal
      title="New room"
      description="A room is the boundary for everything you share."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create room'}
          </Button>
        </>
      }
    >
      <Field label="Room name">
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          placeholder="e.g. Final Year Project"
          maxLength={40}
        />
      </Field>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <span className="field__label">Access</span>
        <div className="segmented">
          <button
            className={type === 'public' ? 'segmented__option is-selected' : 'segmented__option'}
            onClick={() => setType('public')}
          >
            <span className="segmented__title">
              <GlobeIcon size={14} />
              Public
            </span>
            <span className="segmented__desc">Anyone on this WiFi can join instantly.</span>
          </button>
          <button
            className={type === 'private' ? 'segmented__option is-selected' : 'segmented__option'}
            onClick={() => setType('private')}
          >
            <span className="segmented__title">
              <LockIcon size={14} />
              Private
            </span>
            <span className="segmented__desc">Needs a code, a password, and your approval.</span>
          </button>
        </div>
      </div>

      <Field
        label={passwordRequired ? 'Room password' : 'Room password (optional)'}
        hint={
          password
            ? `${strength.label} — this password becomes the encryption key. It is never sent over the network.`
            : passwordRequired
              ? 'Required. It becomes the encryption key for everything in this room.'
              : 'Leave blank for an open, unencrypted room.'
        }
        error={error}
      >
        <input
          className="input"
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          placeholder="Choose a password"
          autoComplete="new-password"
        />
      </Field>
    </Modal>
  );
}

// --------------------------------------------------------------- edit a room

/**
 * Changing a room after it exists. The owner's dialog, and the one place the
 * difference between an ordinary edit and a re-key has to be made plain: a name
 * change is invisible to everyone, while a password change locks every other
 * member out until they are told the new one.
 */
export function EditRoomModal({
  room,
  onClose,
  onSave
}: {
  room: RoomInfo;
  onClose: () => void;
  onSave: (patch: RoomUpdate) => Promise<boolean>;
}) {
  const [name, setName] = React.useState(room.name);
  const [type, setType] = React.useState<RoomType>(room.type);
  /** Off by default: the credentials are left alone unless asked for. */
  const [changingPassword, setChangingPassword] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [removePassword, setRemovePassword] = React.useState(false);
  const [newCode, setNewCode] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const strength = passwordStrength(password);
  const trimmed = name.trim();
  const rekeying = changingPassword && (removePassword || password.length > 0);

  const nameChanged = trimmed !== room.name;
  const typeChanged = type !== room.type;
  const dirty = nameChanged || typeChanged || newCode || rekeying;

  async function submit() {
    if (!trimmed) {
      setError('A room needs a name.');
      return;
    }
    if (changingPassword && !removePassword && password.length > 0 && password.length < 4) {
      setError('Use at least 4 characters, or remove the password instead.');
      return;
    }
    if (changingPassword && !removePassword && password.length === 0) {
      setError('Enter the new password, or choose to remove it.');
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }

    const patch: RoomUpdate = {};
    if (nameChanged) patch.name = trimmed;
    if (typeChanged) patch.type = type;
    if (newCode) patch.regenerateJoinCode = true;
    if (rekeying) patch.password = removePassword ? null : password;

    setBusy(true);
    const saved = await onSave(patch);
    setBusy(false);
    if (saved) {
      onClose();
    }
  }

  return (
    <Modal
      title={`Edit ${room.name}`}
      description="Only you can change this room. Everyone in it sees the change."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={rekeying ? 'danger' : 'primary'} onClick={submit} disabled={busy || !dirty}>
            {busy ? 'Saving…' : rekeying ? 'Save and re-key' : 'Save changes'}
          </Button>
        </>
      }
    >
      <Field label="Room name">
        <input
          className="input"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          maxLength={48}
        />
      </Field>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <span className="field__label">Access</span>
        <div className="segmented">
          <button
            className={type === 'public' ? 'segmented__option is-selected' : 'segmented__option'}
            onClick={() => setType('public')}
          >
            <span className="segmented__title">
              <GlobeIcon size={14} />
              Public
            </span>
            <span className="segmented__desc">Anyone on this WiFi can join instantly.</span>
          </button>
          <button
            className={type === 'private' ? 'segmented__option is-selected' : 'segmented__option'}
            onClick={() => setType('private')}
          >
            <span className="segmented__title">
              <LockIcon size={14} />
              Private
            </span>
            <span className="segmented__desc">Needs a code, a password, and your approval.</span>
          </button>
        </div>
      </div>

      <div style={{ marginTop: 'var(--space-4)' }}>
        <SwitchRow
          title="Issue a new join code"
          description="The current code stops working. Anyone already in the room stays in."
          checked={newCode}
          onChange={setNewCode}
        />

        <SwitchRow
          title={room.encrypted ? 'Change the password' : 'Add a password'}
          description={
            room.encrypted
              ? 'Everyone else is locked out until you tell them the new one.'
              : 'Encrypts everything sent in this room from now on. Everyone else has to enter it.'
          }
          checked={changingPassword}
          onChange={(next) => {
            setChangingPassword(next);
            setError('');
            if (!next) {
              setPassword('');
              setRemovePassword(false);
            }
          }}
        />
      </div>

      {changingPassword && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          {room.encrypted && (
            <SwitchRow
              title="Remove the password instead"
              description="The room stops being encrypted. Anything sent in it can be read by anyone who joins."
              checked={removePassword}
              onChange={(next) => {
                setRemovePassword(next);
                setError('');
              }}
            />
          )}

          {!removePassword && (
            <Field
              label="New room password"
              hint={
                password
                  ? `${strength.label} — this becomes the new encryption key. It is never sent over the network.`
                  : 'At least 4 characters.'
              }
              error={error}
            >
              <input
                className="input"
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError('');
                }}
                onKeyDown={(event) => event.key === 'Enter' && submit()}
                placeholder="Choose a new password"
                autoComplete="new-password"
              />
            </Field>
          )}

          <div className="callout callout--warning" style={{ marginTop: 'var(--space-4)' }}>
            <span className="callout__icon">
              <LockIcon size={17} />
            </span>
            <div className="callout__body">
              <div className="callout__title">This locks everyone else out</div>
              <div className="callout__text">
                Every other device in {room.name} stops being able to read it until you give them
                the new password — including any device you were trying to shut out, which is what
                makes this worth doing. Nobody loses their history, and any call in progress ends.
              </div>
            </div>
          </div>
        </div>
      )}

      {!changingPassword && error ? <p className="field__error">{error}</p> : null}
    </Modal>
  );
}

// ------------------------------------------------------- restrict a member

/**
 * A lesser tier than a block. Owner-only, scoped to one room — narrows what
 * one member may do here rather than severing the device from the network
 * entirely, which is what `onBlock` in `MembersPanel` already does.
 */
export function RestrictMemberModal({
  room,
  member,
  onClose,
  onSave
}: {
  room: RoomInfo;
  member: RoomMember;
  onClose: () => void;
  onSave: (restrictions: RoomRestrictions) => Promise<boolean>;
}) {
  const [chat, setChat] = React.useState(Boolean(member.restricted?.chat));
  const [files, setFiles] = React.useState(Boolean(member.restricted?.files));
  const [calls, setCalls] = React.useState(Boolean(member.restricted?.calls));
  const [remote, setRemote] = React.useState(Boolean(member.restricted?.remote));
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    setBusy(true);
    const saved = await onSave({ chat, files, calls, remote });
    setBusy(false);
    if (saved) {
      onClose();
    }
  }

  return (
    <Modal
      title={`Restrict ${member.deviceName}`}
      description={`Applies only in ${room.name}. Visible to everyone in the room, including ${member.deviceName} — a restriction nobody can see is one that just looks like something is broken.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <SwitchRow
        title="Messages"
        description="Cannot send, edit, delete or react to chat messages in this room."
        checked={chat}
        onChange={setChat}
      />
      <SwitchRow
        title="Files"
        description="Cannot send files or images in this room. Text messages are unaffected."
        checked={files}
        onChange={setFiles}
      />
      <SwitchRow
        title="Calls"
        description="Cannot start or join a call in this room."
        checked={calls}
        onChange={setCalls}
      />
      <SwitchRow
        title="Screen sharing"
        description="Cannot ask to view or control another member's screen through this room. Calls are unaffected."
        checked={remote}
        onChange={setRemote}
      />
    </Modal>
  );
}

// --------------------------------------------------------------- join a room

export function JoinRoomModal({
  target,
  initialCode = '',
  onClose,
  onJoinDiscovered,
  onJoinByCode
}: {
  /** A room picked from the discovered list, or null when joining by code alone. */
  target: DiscoveredRoom | null;
  /**
   * A code that arrived rather than one being typed — from a scanned QR code or
   * a `campusconnect://` link. Filled in, never submitted: a link should say
   * what it is about to do and let a person agree to it.
   */
  initialCode?: string;
  onClose: () => void;
  onJoinDiscovered: (roomId: string, password: string, joinCode: string) => Promise<boolean>;
  onJoinByCode: (joinCode: string, password: string) => Promise<boolean>;
}) {
  const [code, setCode] = React.useState(initialCode);
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Either credential admits you, so neither field is mandatory on its own.
  const showCode = target ? target.type === 'private' : true;
  const showPassword = target ? target.encrypted : true;
  const openRoom = Boolean(target) && !showCode && !showPassword;

  const hasCode = code.trim().length > 0;
  const hasPassword = password.length > 0;
  // A join code alone admits you, but the password is the decryption key.
  const willBeLocked = showPassword && hasCode && !hasPassword;

  async function submit() {
    if (!openRoom && !hasCode && !hasPassword) {
      setError(
        showCode && showPassword
          ? 'Enter the join code, or the room password. Either one works.'
          : showCode
            ? 'Enter the join code.'
            : 'Enter the room password.'
      );
      return;
    }
    if (hasCode && code.trim().length < 6) {
      setError('A join code is six characters.');
      return;
    }

    setBusy(true);
    const sent = target
      ? await onJoinDiscovered(target.roomId, password, code.trim())
      : await onJoinByCode(code.trim(), password);
    setBusy(false);
    if (sent) {
      onClose();
    }
  }

  return (
    <Modal
      title={target ? `Join ${target.name}` : 'Join a room'}
      description={
        target
          ? target.type === 'private'
            ? `${target.ownerName} has to approve your request.`
            : `Hosted by ${target.ownerName}.`
          : 'A join code or a room password will do — you do not need both.'
      }
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? 'Sending…' : 'Request access'}
          </Button>
        </>
      }
    >
      {showCode && showPassword && (
        <p className="field__hint" style={{ marginBottom: 'var(--space-4)' }}>
          Give either one — whichever you were sent.
        </p>
      )}

      {showCode && (
        <Field label={showPassword ? 'Join code' : 'Join code'} hint="Six characters, letters and numbers.">
          <input
            className="input input--code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.toUpperCase().slice(0, 6));
              setError('');
            }}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            placeholder="A1B2C3"
            maxLength={6}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}

      {showCode && showPassword && <div className="or-divider">or</div>}

      {showPassword && (
        <Field
          label="Room password"
          hint="Checked by the room owner without ever leaving this device."
        >
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => event.key === 'Enter' && submit()}
            placeholder="Room password"
            autoComplete="off"
          />
        </Field>
      )}

      {openRoom && <p className="field__hint">This is an open room. Nothing else is needed.</p>}

      {willBeLocked && (
        <div className="callout callout--warning" style={{ marginTop: 'var(--space-4)' }}>
          <span className="callout__icon">
            <LockIcon size={17} />
          </span>
          <div className="callout__body">
            <div className="callout__title">You will join, but the room stays locked</div>
            <div className="callout__text">
              The password is what decrypts this room, so the code alone gets you in
              without letting you read it. You can enter the password any time
              afterwards to unlock it.
            </div>
          </div>
        </div>
      )}

      {error ? <p className="field__error" style={{ marginTop: 'var(--space-3)' }}>{error}</p> : null}
    </Modal>
  );
}

// ------------------------------------------------------- forward a message

/** Where a forwarded message can be sent. */
export type ForwardTarget =
  | { kind: 'room'; id: string; name: string }
  | { kind: 'dm'; id: string; name: string };

/**
 * The destination picker for forwarding.
 *
 * Rooms and DM threads are listed together, because "where do I send this" is
 * one question, not two — the two kinds are labelled rather than separated into
 * tabs the user has to guess between. Locked rooms are shown but not offered:
 * a message cannot be sealed for a room whose key this device does not hold,
 * and silently failing after the click would be worse than saying so up front.
 */
export function ForwardMessageModal({
  preview,
  rooms,
  threads,
  peers,
  selfDeviceId,
  blockedIds,
  onForward,
  onClose
}: {
  /** A line of the message being forwarded, so the modal says what it is about to send. */
  preview: string;
  rooms: RoomInfo[];
  threads: DmThreadSummary[];
  peers: PeerInfo[];
  selfDeviceId: string;
  blockedIds: Set<string>;
  onForward: (target: ForwardTarget) => Promise<boolean>;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [sending, setSending] = React.useState('');

  const destinations = React.useMemo(() => {
    const roomTargets = rooms
      // A `direct` room is the hidden 1:1 room behind a DM call — it is not a
      // place anyone chose to be, so it is never a destination.
      .filter((room) => room.type !== 'direct')
      .filter((room) => room.members.some((m) => m.deviceId === selfDeviceId && m.status === 'accepted'))
      .map((room) => ({ kind: 'room' as const, id: room.roomId, name: room.name }));

    // Threads first, then anyone visible this device has not written to yet —
    // forwarding is often the first thing you ever send someone.
    const known = new Set(threads.map((thread) => thread.peerId));
    const dmTargets = [
      ...threads.map((thread) => ({ kind: 'dm' as const, id: thread.peerId, name: thread.peerName })),
      ...peers
        .filter((peer) => peer.id !== selfDeviceId && !known.has(peer.id) && !blockedIds.has(peer.id))
        .map((peer) => ({ kind: 'dm' as const, id: peer.id, name: peer.name }))
    ].filter((target) => !blockedIds.has(target.id));

    return [...roomTargets, ...dmTargets];
  }, [rooms, threads, peers, selfDeviceId, blockedIds]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? destinations.filter((target) => target.name.toLowerCase().includes(needle))
    : destinations;

  async function pick(target: ForwardTarget) {
    setSending(`${target.kind}:${target.id}`);
    const sent = await onForward(target);
    setSending('');
    if (sent) {
      onClose();
    }
  }

  return (
    <Modal
      title="Forward this message"
      description={preview ? `Sending: “${preview}”` : 'Choose where to send a copy.'}
      onClose={onClose}
      footer={<Button onClick={onClose}>Cancel</Button>}
    >
      <Field label="Where to" hint="Any room you are in, or any device you can reach.">
        <input
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search rooms and people"
          autoFocus
          spellCheck={false}
        />
      </Field>

      {matches.length === 0 ? (
        <p className="field__hint">
          {destinations.length === 0
            ? 'There is nowhere to forward this yet — join a room, or find a device to message.'
            : `Nothing matches “${query.trim()}”.`}
        </p>
      ) : (
        <div className="stack" style={{ marginTop: 'var(--space-2)' }}>
          {matches.map((target) => (
            <button
              key={`${target.kind}:${target.id}`}
              type="button"
              className="member"
              disabled={sending !== ''}
              onClick={() => void pick(target)}
            >
              <span className="member__avatar">
                {target.kind === 'room' ? <UsersIcon size={15} /> : initials(target.name)}
              </span>
              <div className="member__body">
                <div className="member__name">{target.name}</div>
                <div className="member__meta">{target.kind === 'room' ? 'Room' : 'Direct message'}</div>
              </div>
              {sending === `${target.kind}:${target.id}` ? (
                <span className="text-sm text-tertiary">Sending…</span>
              ) : (
                <ForwardIcon size={14} />
              )}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

// --------------------------------------------------- find someone to message

/**
 * The FAB's destination on the Messages page. Modelled on `JoinRoomModal`'s
 * "either credential admits you" shape — here, either a name/device-id match
 * among already-visible peers, or a direct-by-IP connect, gets you to the
 * same place: a device you can open a thread with.
 */

/** How many name/id matches actually render — see the constant's use for why. */
const FIND_USER_MAX_RESULTS = 20;

export function FindUserModal({
  peers,
  selfDeviceId,
  blockedIds,
  defaultPort,
  onConnectByIp,
  onOpenThread,
  onClose
}: {
  peers: PeerInfo[];
  selfDeviceId: string;
  blockedIds: Set<string>;
  defaultPort: number;
  onConnectByIp: (host: string, port: number) => Promise<void>;
  onOpenThread: (peerId: string, peerName: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [host, setHost] = React.useState('');
  const [port, setPort] = React.useState(String(defaultPort));
  const [connecting, setConnecting] = React.useState(false);
  const [lookingForHost, setLookingForHost] = React.useState('');

  const reachable = peers.filter((peer) => peer.id !== selfDeviceId && !blockedIds.has(peer.id));

  const needle = query.trim().toLowerCase();
  const allMatches = needle
    ? reachable.filter(
        (peer) => peer.name.toLowerCase().includes(needle) || peer.id.toLowerCase().includes(needle)
      )
    : [];
  // Rendered rows only, not the whole match set — a broad query on a
  // network with hundreds of devices visible should not mean hundreds of
  // rows in a modal meant to help narrow down to one. The hint below tells
  // the person to keep typing, which is the actual way to get there at
  // that scale.
  const matches = allMatches.slice(0, FIND_USER_MAX_RESULTS);

  // Once a device answers at the address just connected to, it is offered
  // directly — `peers` is the live, ever-updating list from `AppState`, so
  // this just needs to notice a new entry at that host, not poll for one.
  const justConnected = lookingForHost ? reachable.find((peer) => peer.host === lookingForHost) : undefined;

  async function connect() {
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      return;
    }
    const parsedPort = Number(port) || defaultPort;
    setConnecting(true);
    await onConnectByIp(trimmedHost, parsedPort);
    setConnecting(false);
    setLookingForHost(trimmedHost);
  }

  function choose(peer: PeerInfo) {
    onOpenThread(peer.id, peer.name);
    onClose();
  }

  return (
    <Modal
      title="Find someone to message"
      description="Search by name or device ID, or connect directly by IP address."
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <Field label="Name or device ID" hint="Matches anyone currently visible on the network.">
        <input
          className="input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A name, or a device id"
          autoFocus
          spellCheck={false}
        />
      </Field>

      {needle ? (
        matches.length > 0 ? (
          <div className="stack" style={{ marginTop: 'var(--space-2)' }}>
            {matches.map((peer) => (
              <button key={peer.id} type="button" className="member" onClick={() => choose(peer)}>
                <span className="member__avatar">{initials(peer.name)}</span>
                <div className="member__body">
                  <div className="member__name">{peer.name}</div>
                  <div className="member__meta mono truncate">{peer.id}</div>
                </div>
                <ChatIcon size={14} />
              </button>
            ))}
            {allMatches.length > matches.length && (
              <p className="field__hint">
                {allMatches.length - matches.length} more — keep typing to narrow it down.
              </p>
            )}
          </div>
        ) : (
          <p className="field__hint">No one visible right now matches “{query.trim()}”.</p>
        )
      ) : null}

      <div className="or-divider">or</div>

      <Field label="IP address" hint="For a device not yet visible on this network segment.">
        <div className="row">
          <input
            className="input"
            value={host}
            onChange={(event) => {
              setHost(event.target.value);
              setLookingForHost('');
            }}
            onKeyDown={(event) => event.key === 'Enter' && connect()}
            placeholder="192.168.1.42"
            spellCheck={false}
            style={{ flex: 2 }}
          />
          <input
            className="input"
            value={port}
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
            placeholder={String(defaultPort)}
            style={{ flex: 1 }}
          />
          <Button onClick={connect} disabled={connecting || !host.trim()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      </Field>

      {justConnected ? (
        <button type="button" className="member" onClick={() => choose(justConnected)}>
          <span className="member__avatar">{initials(justConnected.name)}</span>
          <div className="member__body">
            <div className="member__name">{justConnected.name}</div>
            <div className="member__meta">Answered at {justConnected.host}</div>
          </div>
          <ChatIcon size={14} />
        </button>
      ) : lookingForHost ? (
        <p className="field__hint">
          Waiting for a device to answer at {lookingForHost} — it will appear here once it does.
        </p>
      ) : null}
    </Modal>
  );
}

// -------------------------------------------------------- answer an invite

export function InviteModal({
  invite,
  onClose,
  onRespond
}: {
  invite: RoomInvite;
  onClose: () => void;
  onRespond: (roomId: string, accept: boolean) => Promise<boolean>;
}) {
  const [busy, setBusy] = React.useState(false);

  async function respond(accept: boolean) {
    setBusy(true);
    await onRespond(invite.roomId, accept);
    setBusy(false);
    onClose();
  }

  return (
    <Modal
      title={`${invite.ownerName} invited you`}
      description={`They would like you to join ${invite.roomName}.`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={() => respond(false)} disabled={busy}>
            Decline
          </Button>
          <Button variant="primary" onClick={() => respond(true)} disabled={busy}>
            {busy ? 'Sending…' : 'Accept'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <span className={`badge badge--${invite.type === 'private' ? 'accent' : 'neutral'}`}>
            {invite.type === 'private' ? <LockIcon size={11} /> : <GlobeIcon size={11} />}
            {invite.type === 'private' ? 'Private' : 'Public'}
          </span>
          {invite.encrypted ? (
            <span className="badge badge--success">Encrypted</span>
          ) : (
            <span className="badge badge--warning">Not encrypted</span>
          )}
        </div>

        <p className="field__hint">
          Accepting does not put you in the room straight away — {invite.ownerName} still
          has to approve you.
          {invite.encrypted
            ? ' And because this room is encrypted, you will also need its password before you can read anything in it.'
            : ''}
        </p>

        <p className="field__hint">
          Nothing is shared with them by accepting, and your clipboard is only sent to a
          room once you select it.
        </p>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------- unlock a room

export function UnlockRoomModal({
  room,
  onClose,
  onUnlock
}: {
  room: RoomInfo;
  onClose: () => void;
  onUnlock: (roomId: string, password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (!password) {
      return;
    }
    setBusy(true);
    const unlocked = await onUnlock(room.roomId, password);
    setBusy(false);
    if (unlocked) {
      onClose();
    }
  }

  return (
    <Modal
      title={`Unlock ${room.name}`}
      description="The room key is derived from the password, so it has to be entered on each device."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !password}>
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </>
      }
    >
      <Field label="Room password">
        <input
          className="input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          placeholder="Room password"
          autoComplete="off"
        />
      </Field>
    </Modal>
  );
}

// -------------------------------------------------------------- settings

const THEMES: Array<{ value: AppSettings['theme']; label: string; icon: React.ReactNode }> = [
  { value: 'system', label: 'System', icon: <MonitorIcon size={14} /> },
  { value: 'light', label: 'Light', icon: <SunIcon size={14} /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon size={14} /> }
];

