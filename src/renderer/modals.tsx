import React from 'react';
import type {
  AppSettings,
  AppState,
  DiscoveredRoom,
  RoomInfo,
  RoomInvite,
  RoomType,
  RoomUpdate
} from '../shared/types';
import { APP_INFO, FONT_SCALES, MAX_FONT_SCALE, MIN_FONT_SCALE } from '../shared/types';
import { Button, Field, Modal, SwitchRow } from './ui';
import { passwordStrength } from './format';
import { listSystemFonts } from './fonts';
import {
  ClipboardIcon,
  GithubIcon,
  GlobeIcon,
  LockIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon
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

