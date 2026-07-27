import React from 'react';
import type {
  AppSettings,
  AppState,
  DiscoveredRoom,
  RoomInfo,
  RoomInvite,
  RoomType
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

// --------------------------------------------------------------- join a room

export function JoinRoomModal({
  target,
  onClose,
  onJoinDiscovered,
  onJoinByCode
}: {
  /** A room picked from the discovered list, or null when joining by code alone. */
  target: DiscoveredRoom | null;
  onClose: () => void;
  onJoinDiscovered: (roomId: string, password: string, joinCode: string) => Promise<boolean>;
  onJoinByCode: (joinCode: string, password: string) => Promise<boolean>;
}) {
  const [code, setCode] = React.useState('');
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

/**
 * Text size and font family. The font list comes from the machine itself, so
 * every option in the dropdown is guaranteed to render.
 */
function TypographySettings({
  settings,
  onUpdateSettings
}: {
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [fonts, setFonts] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    let active = true;
    listSystemFonts().then((families) => {
      if (active) {
        setFonts(families);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  // Tolerate a settings object written by an older version that has no scale.
  const scale = Number.isFinite(settings.fontScale) ? settings.fontScale : 1;
  const isStep = (step: number) => Math.abs(step - scale) < 0.001;
  const scaleLabel =
    FONT_SCALES.find((step) => isStep(step.value))?.label ?? `${Math.round(scale * 100)}%`;

  return (
    <>
      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <span className="field__label">Text size</span>
        <div className="range-row">
          <input
            className="range"
            type="range"
            min={MIN_FONT_SCALE}
            max={MAX_FONT_SCALE}
            step={0.05}
            value={scale}
            onChange={(event) => onUpdateSettings({ fontScale: Number(event.target.value) })}
            aria-label="Text size"
          />
          <span className="range-row__value">{scaleLabel}</span>
        </div>
        <div className="row" style={{ gap: 'var(--space-1)' }}>
          {FONT_SCALES.map((step) => (
            <Button
              key={step.label}
              size="sm"
              variant={isStep(step.value) ? 'primary' : 'ghost'}
              onClick={() => onUpdateSettings({ fontScale: step.value })}
            >
              {step.label}
            </Button>
          ))}
        </div>
      </div>

      <Field
        label="Font"
        hint={
          fonts === null
            ? 'Reading the fonts installed on this computer…'
            : `${fonts.length} fonts found on this computer.`
        }
      >
        <select
          className="select"
          value={settings.fontFamily}
          onChange={(event) => onUpdateSettings({ fontFamily: event.target.value })}
        >
          <option value="">System default</option>
          {(fonts ?? []).map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </Field>

      <div className="type-preview" style={{ marginTop: 'var(--space-3)' }}>
        <div className="type-preview__title">Final Year Project</div>
        <div className="type-preview__body">
          Copy on one laptop, paste on another. The quick brown fox jumps over the lazy dog.
        </div>
        <div className="type-preview__mono">npm run dev — 0123456789</div>
      </div>
    </>
  );
}

export function SettingsModal({
  state,
  onClose,
  onRename,
  onUpdateSettings,
  onConnectPeer,
  onOpenExternal
}: {
  state: AppState;
  onClose: () => void;
  onRename: (name: string) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConnectPeer: (host: string) => void;
  onOpenExternal: (url: string) => void;
}) {
  const [name, setName] = React.useState(state.deviceName);
  const [peerHost, setPeerHost] = React.useState('');

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <Field label="Device name" hint="How this laptop appears to everyone else.">
        <div className="row">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() && name !== state.deviceName && onRename(name.trim())}
            onKeyDown={(event) => event.key === 'Enter' && name.trim() && onRename(name.trim())}
            maxLength={32}
          />
        </div>
      </Field>

      <div className="field" style={{ marginTop: 'var(--space-4)' }}>
        <span className="field__label">Appearance</span>
        <div className="segmented">
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              className={
                state.settings.theme === theme.value ? 'segmented__option is-selected' : 'segmented__option'
              }
              onClick={() => onUpdateSettings({ theme: theme.value })}
            >
              <span className="segmented__title">
                {theme.icon}
                {theme.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <TypographySettings settings={state.settings} onUpdateSettings={onUpdateSettings} />

      <div style={{ marginTop: 'var(--space-4)' }}>
        <SwitchRow
          title="Share my clipboard"
          description="Send what you copy to the room you have selected."
          checked={state.settings.syncEnabled}
          onChange={(next) => onUpdateSettings({ syncEnabled: next })}
        />
        <SwitchRow
          title="Paste automatically"
          description="Put incoming items straight onto this clipboard, ready for Ctrl+V."
          checked={state.settings.autoApply}
          onChange={(next) => onUpdateSettings({ autoApply: next })}
        />
        <SwitchRow
          title="Include images"
          description="Share copied images as well as text. Large images may not fit on the network."
          checked={state.settings.shareImages}
          onChange={(next) => onUpdateSettings({ shareImages: next })}
        />
      </div>

      <div className="field" style={{ marginTop: 'var(--space-5)' }}>
        <span className="field__label">This device on the network</span>
        <div className="code-block">
          <span className="mono text-sm">
            {state.localAddress}:{state.listenPort}
          </span>
          <span className="spacer" />
          <span className="text-sm text-tertiary">
            {state.peers.length} {state.peers.length === 1 ? 'peer' : 'peers'} seen
          </span>
        </div>
      </div>

      <Field
        label="Add a device by IP"
        hint="Only needed when your network blocks broadcast discovery."
      >
        <div className="row">
          <input
            className="input"
            value={peerHost}
            onChange={(event) => setPeerHost(event.target.value)}
            placeholder="192.168.1.42"
            spellCheck={false}
          />
          <Button
            onClick={() => {
              if (peerHost.trim()) {
                onConnectPeer(peerHost.trim());
                setPeerHost('');
              }
            }}
            disabled={!peerHost.trim()}
          >
            Add
          </Button>
        </div>
      </Field>

      <div className="about">
        <div className="about__head">
          <span className="about__mark">
            <ClipboardIcon size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="about__name">
              {APP_INFO.name}
              <span className="about__version">v{state.appVersion}</span>
            </div>
            <div className="about__by">
              MVP designed and built by{' '}
              <button className="link" onClick={() => onOpenExternal(APP_INFO.authorUrl)}>
                {APP_INFO.author}
              </button>
            </div>
          </div>
        </div>
        <div className="about__links">
          <Button size="sm" onClick={() => onOpenExternal(APP_INFO.repositoryUrl)}>
            <GithubIcon size={14} />
            Source code
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onOpenExternal(APP_INFO.websiteUrl)}>
            Website
          </Button>
          <span className="spacer" />
          <span className="about__license">{APP_INFO.license} licensed</span>
        </div>
      </div>
    </Modal>
  );
}
