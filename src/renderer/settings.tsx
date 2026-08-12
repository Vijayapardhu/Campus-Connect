import React from 'react';
import type { AppSettings, AppState, ConnectivityResult } from '../shared/types';
import { APP_INFO, FONT_SCALES, MAX_FONT_SCALE, MIN_FONT_SCALE, RETENTION_CHOICES, STORAGE_CHOICES } from '../shared/types';
import { Button, Field, SwitchRow } from './ui';
import { formatBytes, relativeTime } from './format';
import { listSystemFonts } from './fonts';
import {
  AlertIcon,
  BellIcon,
  BookmarkIcon,
  CheckIcon,
  CopyIcon,
  QrIcon,
  XIcon,
  TrashIcon,
  DownloadIcon,
  ClipboardIcon,
  DatabaseIcon,
  GithubIcon,
  MonitorIcon,
  MoonIcon,
  ShieldIcon,
  SignalIcon,
  SunIcon,
  TypeIcon,
  UserIcon
} from './icons';

type SectionId =
  | 'device'
  | 'appearance'
  | 'sync'
  | 'notifications'
  | 'privacy'
  | 'snippets'
  | 'phone'
  | 'storage'
  | 'network'
  | 'updates'
  | 'about';

/*
 * Grouped by what a setting is actually *about*, in the order most people
 * would reach for it — not by whichever section happened to have room:
 *
 *   1. Who this device is, and how it starts       (device)
 *   2. What it does day to day                      (sync, notifications, privacy)
 *   3. How it looks                                 (appearance)
 *   4. What it keeps                                (snippets, storage)
 *   5. How it reaches other devices                 (network, phone)
 *   6. Upkeep                                        (updates, about)
 *
 * "Starting with this computer" used to sit inside Notifications, which is
 * where it happened to be added rather than where anyone would look for it —
 * it is about this device, not about being told things, and now lives there
 * instead.
 */
const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ReactNode }> = [
  { id: 'device', label: 'This device', icon: <UserIcon size={15} /> },
  { id: 'sync', label: 'Sharing', icon: <ClipboardIcon size={15} /> },
  { id: 'notifications', label: 'Notifications', icon: <BellIcon size={15} /> },
  { id: 'privacy', label: 'Privacy', icon: <ShieldIcon size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <TypeIcon size={15} /> },
  { id: 'snippets', label: 'Snippets', icon: <BookmarkIcon size={15} /> },
  { id: 'storage', label: 'Storage', icon: <DatabaseIcon size={15} /> },
  { id: 'network', label: 'Network', icon: <SignalIcon size={15} /> },
  { id: 'phone', label: 'Phone', icon: <QrIcon size={15} /> },
  { id: 'updates', label: 'Updates', icon: <DownloadIcon size={15} /> },
  { id: 'about', label: 'About', icon: <GithubIcon size={15} /> }
];

const THEMES: Array<{ value: AppSettings['theme']; label: string; icon: React.ReactNode }> = [
  { value: 'system', label: 'System', icon: <MonitorIcon size={14} /> },
  { value: 'light', label: 'Light', icon: <SunIcon size={14} /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon size={14} /> }
];

export function SettingsPage({
  state,
  onRename,
  onUpdateSettings,
  onConnectPeer,
  onForgetPeer,
  onOpenExternal,
  onCompactStorage,
  onUnblockDevice,
  onSaveSnippet,
  onDeleteSnippet,
  onCopySnippet,
  onStartPhone,
  onStopPhone,
  onRevokePhone,
  onPhoneQr,
  onBlockDevice,
  onTestConnection,
  onCheckUpdate,
  onDownloadUpdate,
  onInstallUpdate
}: {
  state: AppState;
  onRename: (name: string) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConnectPeer: (host: string) => void;
  onForgetPeer: (host: string, port: number) => void;
  onOpenExternal: (url: string) => void;
  onCompactStorage: () => void;
  onUnblockDevice: (deviceId: string) => void;
  onSaveSnippet: (input: { id?: string; label: string; content: string }) => void;
  onDeleteSnippet: (id: string) => void;
  onCopySnippet: (id: string) => void;
  onStartPhone: () => void;
  onStopPhone: () => void;
  onRevokePhone: (connectedAt: number) => void;
  onPhoneQr: () => Promise<string | null>;
  onBlockDevice: (deviceId: string, deviceName: string) => void;
  onTestConnection: (host: string) => Promise<ConnectivityResult>;
  onCheckUpdate: () => void;
  onDownloadUpdate: () => void;
  onInstallUpdate: () => void;
}) {
  const [section, setSection] = React.useState<SectionId>('device');
  const [name, setName] = React.useState(state.deviceName);
  const [nameFieldFocused, setNameFieldFocused] = React.useState(false);

  // A paired phone can rename this device too (settings are part of what it
  // shares). Without this, that rename never reaches the box below — it
  // stays seeded from whatever `state.deviceName` was on mount — so leaving
  // this page open, then blurring or pressing Enter in the box, silently
  // reverted the phone's rename back to the old name. Skipped while the
  // field is focused, so an external rename cannot overwrite something being
  // typed right now.
  React.useEffect(() => {
    if (!nameFieldFocused) {
      setName(state.deviceName);
    }
  }, [state.deviceName, nameFieldFocused]);
  const [peerHost, setPeerHost] = React.useState('');
  const [testHost, setTestHost] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ConnectivityResult | null>(null);
  const [fonts, setFonts] = React.useState<string[] | null>(null);
  const [idCopied, setIdCopied] = React.useState(false);

  React.useEffect(() => {
    if (!idCopied) {
      return;
    }
    const timer = window.setTimeout(() => setIdCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [idCopied]);

  const settings = state.settings;
  const scale = Number.isFinite(settings.fontScale) ? settings.fontScale : 1;
  const isStep = (step: number) => Math.abs(step - scale) < 0.001;

  React.useEffect(() => {
    let active = true;
    listSystemFonts().then((families) => active && setFonts(families));
    return () => {
      active = false;
    };
  }, []);

  const update = state.update;
  const canSelfInstall = !navigator.userAgent.includes('Mac');

  const updateHeadline = {
    idle: 'Not checked yet',
    checking: 'Checking for a new version…',
    current: 'Up to date',
    available: `Version ${update.availableVersion} is available`,
    downloading: `Downloading… ${update.percent ?? 0}%`,
    retrying: `Connection dropped — resuming (attempt ${(update.attempt ?? 1) + 1} of 4)`,
    // Says what will happen on its own, so the button below reads as a way to
    // have it sooner rather than the only way to have it at all.
    ready: `Version ${update.availableVersion} installs when you close the app`,
    manual: 'Download it from the releases page',
    unsupported: 'Running from source — updates apply to installed builds',
    error: 'Could not check for updates'
  }[update.state];

  const net = state.diagnostics;

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await onTestConnection(testHost.trim()));
    } finally {
      setTesting(false);
    }
  }

  /*
   * Turns the counters into the one sentence that actually helps. The failure
   * modes look identical from the outside — nothing appears — but they need
   * completely different fixes.
   */
  const diagnosis = React.useMemo(() => {
    if (net.otherVersions.length > 0) {
      return {
        tone: 'warning' as const,
        title: 'Another device is running a different version',
        detail: `Something on this network speaks protocol v${net.otherVersions.join(', v')} while this app speaks v${net.protocolVersion}. Different versions cannot talk to each other. Install the same version on both machines.`
      };
    }

    if (state.peers.length > 0) {
      return {
        tone: 'accent' as const,
        title: `${state.peers.length} device${state.peers.length === 1 ? '' : 's'} reachable`,
        detail: 'Discovery is working. If a room still will not accept you, check the join code or password, and that the owner has approved the request.'
      };
    }

    if (net.packetsSent > 0 && net.packetsReceived === 0) {
      return {
        tone: 'warning' as const,
        title: 'Sending, but nothing is coming back',
        detail: 'Packets are leaving this device and none are arriving back. Two usual causes: the firewall is blocking the app — check that Windows still has this network marked Private, since a network switching to Public silently blocks inbound traffic — or the network has client isolation turned on, which university and public WiFi commonly do so that devices cannot see each other at all. A phone hotspot settles which it is in a minute.'
      };
    }

    return {
      tone: 'accent' as const,
      title: 'Waiting for other devices',
      detail: 'Nothing has been seen yet. Make sure the app is running on the other machine and that both are on the same network.'
    };
  }, [net, state.peers.length]);

  const storage = state.storage;
  const usedPercent = Math.min(
    100,
    Math.round((storage.totalBytes / (settings.maxStorageMb * 1024 * 1024)) * 100)
  );

  return (
    <div className="settings">
      <nav className="settings__nav" aria-label="Settings sections">
        {SECTIONS.map((entry) => (
          <button
            key={entry.id}
            className={section === entry.id ? 'settings__tab is-active' : 'settings__tab'}
            onClick={() => setSection(entry.id)}
            aria-current={section === entry.id}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="settings__body">
        {section === 'device' && (
          <section className="settings__section">
            <h2 className="settings__title">This device</h2>
            <p className="settings__lede">How this machine appears to everyone else, and how it starts.</p>

            <Field label="Device name" hint="Shown next to everything you share.">
              <div className="row">
                <input
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onFocus={() => setNameFieldFocused(true)}
                  onBlur={() => {
                    setNameFieldFocused(false);
                    name.trim() && name !== state.deviceName && onRename(name.trim());
                  }}
                  onKeyDown={(event) => event.key === 'Enter' && name.trim() && onRename(name.trim())}
                  maxLength={32}
                />
              </div>
            </Field>

            <dl className="facts">
              <div>
                <dt>Address</dt>
                <dd className="mono">
                  {state.localAddress}:{state.listenPort}
                </dd>
              </div>
              <div>
                <dt>Device id</dt>
                <dd className="mono truncate" title={state.deviceId}>{state.deviceId}</dd>
                {/*
                 * This is the network-wide unique id "Find someone to
                 * message" searches by — shown truncated above so it never
                 * breaks the layout, so the only way to actually hand it to
                 * someone is to copy the whole thing, not the visible slice.
                 */}
                <Button
                  size="sm"
                  icon
                  variant="ghost"
                  onClick={() => {
                    navigator.clipboard.writeText(state.deviceId);
                    setIdCopied(true);
                  }}
                  aria-label="Copy device id"
                  title="Copy device id"
                >
                  {idCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                </Button>
              </div>
              <div>
                <dt>Rooms</dt>
                {/* Excludes the hidden 1:1 room a DM call is placed in — not a room from the user's point of view. */}
                <dd>{state.rooms.filter((room) => room.type !== 'direct').length}</dd>
              </div>
            </dl>

            <h3 className="settings__subtitle">Starting with this computer</h3>

            <SwitchRow
              title="Open Campus Connect at login"
              description="Start automatically when you sign in to this computer. Your clipboard, the quick-paste shortcut and file transfers only work while it is running."
              checked={settings.launchAtLogin}
              onChange={(next) => onUpdateSettings({ launchAtLogin: next })}
            />

            <SwitchRow
              title="Start in the tray"
              description={
                settings.launchAtLogin
                  ? 'Start without opening the window. Everything runs as normal in the background — click the tray icon whenever you want to see it.'
                  : 'Start without opening the window. Only matters once "Open Campus Connect at login" is on — there is nothing to start hidden otherwise.'
              }
              checked={settings.launchMinimized}
              disabled={!settings.launchAtLogin}
              onChange={(next) => onUpdateSettings({ launchMinimized: next })}
            />

            <SwitchRow
              title="Show the welcome tour again"
              description="Replays the short introduction right over whatever is on screen now. Useful when handing this machine to somebody who has not seen it before."
              checked={!settings.hasOnboarded}
              onChange={(next) => onUpdateSettings({ hasOnboarded: !next })}
            />
          </section>
        )}

        {section === 'appearance' && (
          <section className="settings__section">
            <h2 className="settings__title">Appearance</h2>
            <p className="settings__lede">Theme, text size and the font used throughout.</p>

            <div className="field">
              <span className="field__label">Theme</span>
              <div className="segmented">
                {THEMES.map((theme) => (
                  <button
                    key={theme.value}
                    className={
                      settings.theme === theme.value ? 'segmented__option is-selected' : 'segmented__option'
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

            <div className="field" style={{ marginTop: 'var(--space-5)' }}>
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
                <span className="range-row__value">
                  {FONT_SCALES.find((step) => isStep(step.value))?.label ?? `${Math.round(scale * 100)}%`}
                </span>
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
          </section>
        )}

        {section === 'sync' && (
          <section className="settings__section">
            <h2 className="settings__title">Sharing</h2>
            <p className="settings__lede">What leaves this device, and what arrives on it.</p>

            <SwitchRow
              title="Campus Connect"
              description="The master switch, also on the header. Off means nothing at all — not just the clipboard, but chat, rooms, calls, files and messages too — is shared, received or announced, and this device is invisible to the others."
              checked={settings.online !== false}
              onChange={(next) => onUpdateSettings({ online: next })}
            />
            <SwitchRow
              title="Share my clipboard"
              description="Send what you copy to the room you have selected. Chat, calls and everything else keep working either way — this switch is the clipboard alone."
              checked={settings.syncEnabled}
              onChange={(next) => onUpdateSettings({ syncEnabled: next })}
            />
            <SwitchRow
              title="Paste automatically"
              description="Put incoming items straight onto this clipboard, ready for Ctrl+V."
              checked={settings.autoApply}
              onChange={(next) => onUpdateSettings({ autoApply: next })}
            />
            <SwitchRow
              title="Include images"
              description="Share copied images as well as text."
              checked={settings.shareImages}
              onChange={(next) => onUpdateSettings({ shareImages: next })}
            />
            <SwitchRow
              title="Send read receipts"
              description="Let others see when their messages reached you and when you read them. Turning this off also hides their receipts from you."
              checked={settings.sendReceipts}
              onChange={(next) => onUpdateSettings({ sendReceipts: next })}
            />
            <SwitchRow
              title="Accept files from my rooms"
              description="Take files from devices in your rooms without asking first — they already know the room password. Anyone else is still asked about every time."
              checked={settings.autoAcceptFiles}
              onChange={(next) => onUpdateSettings({ autoAcceptFiles: next })}
            />
          </section>
        )}

        {section === 'notifications' && (
          <section className="settings__section">
            <h2 className="settings__title">Notifications</h2>
            <p className="settings__lede">
              The app keeps running in the tray when you close the window, so it can still tell
              you when something arrives.
            </p>

            <SwitchRow
              title="Show popups"
              description="A notification for new messages, clipboard items, join requests and invitations. Turning this off silences the app completely — nothing appears on screen and nothing is heard."
              checked={settings.notifications}
              onChange={(next) => onUpdateSettings({ notifications: next })}
            />

            <SwitchRow
              title="Notification sound"
              description={
                settings.notifications
                  ? 'Play the system sound with each popup. Off means notifications still appear, but arrive quietly.'
                  : 'Play the system sound with each popup. Has nothing to play while popups themselves are off.'
              }
              checked={settings.notificationSound}
              disabled={!settings.notifications}
              onChange={(next) => onUpdateSettings({ notificationSound: next })}
            />

            <h3 className="settings__subtitle">Calls</h3>

            <SwitchRow
              title="Ring for incoming calls"
              description="Ring out loud when someone calls a room you are in. The call still appears on screen when this is off."
              checked={settings.ringOnCalls}
              onChange={(next) => onUpdateSettings({ ringOnCalls: next })}
            />

            <SwitchRow
              title="Join calls muted"
              description="Start every call with your microphone off, so the room does not hear whatever is going on around you before you are ready."
              checked={settings.startCallsMuted}
              onChange={(next) => onUpdateSettings({ startCallsMuted: next })}
            />

            <div className="callout callout--accent" style={{ marginTop: 'var(--space-4)' }}>
              <span className="callout__icon">
                <BellIcon size={17} />
              </span>
              <div className="callout__body">
                <div className="callout__title">Only when you are not looking</div>
                <div className="callout__text">
                  Nothing is shown while the window is open and focused — you can already see it.
                  Notifications appear when the window is hidden, minimised, or behind something
                  else. A ringing call is the exception: it appears wherever you are, because it
                  is over in seconds.
                </div>
              </div>
            </div>
          </section>
        )}

        {section === 'privacy' && (
          <section className="settings__section">
            <h2 className="settings__title">Privacy</h2>
            <p className="settings__lede">
              Blocking a device stops this one dealing with it at all. Nothing it sends is read,
              stored, shown or answered, in any room, and it is removed from every room you own.
            </p>

            <h3 className="settings__subtitle">Blocked devices</h3>

            {state.blocked.length === 0 ? (
              <p className="text-secondary text-sm">
                No devices are blocked. You can block one from the Members list of any room, or
                from the list of devices on this network below.
              </p>
            ) : (
              <div className="blocklist">
                {state.blocked.map((entry) => (
                  <div key={entry.deviceId} className="blocklist__row">
                    <span className="blocklist__icon">
                      <ShieldIcon size={15} />
                    </span>
                    <span className="blocklist__body">
                      <span className="blocklist__name">{entry.deviceName}</span>
                      <span className="blocklist__meta">
                        Blocked {relativeTime(entry.blockedAt)}
                      </span>
                    </span>
                    <Button size="sm" onClick={() => onUnblockDevice(entry.deviceId)}>
                      Unblock
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <h3 className="settings__subtitle">Devices on this network</h3>

            {state.peers.length === 0 ? (
              <p className="text-secondary text-sm">
                No other devices are announcing themselves right now.
              </p>
            ) : (
              <div className="blocklist">
                {state.peers.map((peer) => (
                  <div key={peer.id} className="blocklist__row">
                    <span className="blocklist__icon">
                      <UserIcon size={15} />
                    </span>
                    <span className="blocklist__body">
                      <span className="blocklist__name">{peer.name}</span>
                      <span className="blocklist__meta">{peer.host}</span>
                    </span>
                    <Button size="sm" variant="danger" onClick={() => onBlockDevice(peer.id, peer.name)}>
                      Block
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="callout callout--warning" style={{ marginTop: 'var(--space-5)' }}>
              <span className="callout__icon">
                <AlertIcon size={17} />
              </span>
              <div className="callout__body">
                <div className="callout__title">What blocking cannot do</div>
                <div className="callout__text">
                  It is a decision made on this device. A blocked device is thrown out of rooms you
                  own, but a room owned by someone else is theirs to manage — there, blocking only
                  means you stop seeing anything that device sends. It also has no way of hiding
                  that this device exists: discovery is a broadcast, and anything on the network
                  can hear it.
                </div>
              </div>
            </div>
          </section>
        )}

        {section === 'snippets' && (
          <SnippetsSection
            state={state}
            onSave={onSaveSnippet}
            onDelete={onDeleteSnippet}
            onCopy={onCopySnippet}
            onUpdateSettings={onUpdateSettings}
          />
        )}

        {section === 'phone' && (
          <PhoneSection
            state={state}
            onStart={onStartPhone}
            onStop={onStopPhone}
            onRevoke={onRevokePhone}
            onQr={onPhoneQr}
          />
        )}

        {section === 'storage' && (
          <section className="settings__section">
            <h2 className="settings__title">Storage</h2>
            <p className="settings__lede">
              Text costs almost nothing to keep. Images and files are what grow, so they are
              cleaned up on a schedule while the messages themselves stay.
            </p>

            <div className="meter">
              <div className="meter__head">
                <span className="meter__value">{formatBytes(storage.totalBytes) || '0 B'}</span>
                <span className="meter__of">of {settings.maxStorageMb} MB</span>
              </div>
              <div className="meter__track">
                <div
                  className={usedPercent > 85 ? 'meter__fill is-high' : 'meter__fill'}
                  style={{ width: `${Math.max(2, usedPercent)}%` }}
                />
              </div>
              <div className="meter__legend">
                <span>{storage.clipboardEntries} clipboard items</span>
                <span>{storage.chatMessages} messages</span>
                <span>{formatBytes(storage.mediaBytes) || '0 B'} in attachments</span>
                {storage.clearedAttachments > 0 && (
                  <span>{storage.clearedAttachments} cleaned up so far</span>
                )}
              </div>
            </div>

            <Field
              label="Keep images and files for"
              hint="Text is always kept. Only the attachment is removed — the message stays, so the conversation still reads."
            >
              <select
                className="select"
                value={settings.retainMediaDays}
                onChange={(event) => onUpdateSettings({ retainMediaDays: Number(event.target.value) })}
              >
                {RETENTION_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Maximum storage"
              hint="When the history exceeds this, the oldest attachments are dropped until it fits."
            >
              <select
                className="select"
                value={settings.maxStorageMb}
                onChange={(event) => onUpdateSettings({ maxStorageMb: Number(event.target.value) })}
              >
                {STORAGE_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="row" style={{ marginTop: 'var(--space-4)' }}>
              <Button onClick={onCompactStorage}>
                <DatabaseIcon size={15} />
                Clean up now
              </Button>
              <span className="text-sm text-tertiary">Runs automatically every hour.</span>
            </div>
          </section>
        )}

        {section === 'network' && (
          <section className="settings__section">
            <h2 className="settings__title">Network</h2>
            <p className="settings__lede">
              Devices find each other by broadcasting on the local network. When that does not
              work, this is where you find out why.
            </p>

            {diagnosis && (
              <div className={`callout callout--${diagnosis.tone}`} style={{ marginBottom: 'var(--space-5)' }}>
                <span className="callout__icon">
                  {diagnosis.tone === 'warning' ? <AlertIcon size={17} /> : <ShieldIcon size={17} />}
                </span>
                <div className="callout__body">
                  <div className="callout__title">{diagnosis.title}</div>
                  <div className="callout__text">{diagnosis.detail}</div>
                </div>
              </div>
            )}

            <div className="facts">
              <div>
                <dt>Sent</dt>
                <dd>{net.packetsSent.toLocaleString()} packets</dd>
              </div>
              <div>
                <dt>Received</dt>
                <dd>
                  {net.packetsReceived.toLocaleString()} packets
                  {net.lastReceivedAt > 0 && (
                    <span className="text-tertiary"> · last {relativeTime(net.lastReceivedAt)}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Devices seen</dt>
                <dd>{state.peers.length}</dd>
              </div>
              <div>
                <dt>Direct links</dt>
                <dd>
                  {net.directHosts.length === 0 ? (
                    <span className="text-tertiary">none — using UDP only</span>
                  ) : (
                    <span className="mono">{net.directHosts.join(', ')}</span>
                  )}
                  {net.tcpFramesSent + net.tcpFramesReceived > 0 && (
                    <span className="text-tertiary">
                      {' '}
                      · {net.tcpFramesSent.toLocaleString()} sent,{' '}
                      {net.tcpFramesReceived.toLocaleString()} received over TCP
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Protocol</dt>
                <dd className="mono">v{net.protocolVersion}</dd>
              </div>
              {net.lastError && (
                <div>
                  <dt>Last error</dt>
                  <dd style={{ color: 'var(--danger)' }}>{net.lastError}</dd>
                </div>
              )}
            </div>

            <h3 className="settings__subtitle">Network adapters</h3>
            <div className="facts">
              {net.interfaces.map((nic) => (
                <div key={nic.name + nic.address}>
                  <dt className="truncate" title={nic.name}>
                    {nic.name}
                  </dt>
                  <dd>
                    <span className="mono">{nic.address}</span>
                    {nic.broadcast && (
                      <span className="text-tertiary mono"> → {nic.broadcast}</span>
                    )}
                    {nic.chosen && <span className="badge badge--accent" style={{ marginLeft: 8 }}>Using</span>}
                    {nic.virtual && <span className="badge" style={{ marginLeft: 6 }}>Virtual</span>}
                  </dd>
                </div>
              ))}
            </div>
            <p className="field__hint" style={{ marginTop: 'var(--space-2)' }}>
              Broadcasts go to every one of these, not just the default route — a virtual
              adapter would otherwise swallow them.
            </p>

            {state.peers.length > 0 && (
              <>
                <h3 className="settings__subtitle">Devices on this network</h3>
                <div className="peer-list">
                  {state.peers.map((peer) => (
                    <div key={peer.id} className="peer-item">
                      <strong>{peer.name}</strong>
                      <span className="mono">{peer.host}</span>
                      {peer.protocolVersion !== undefined &&
                        peer.protocolVersion !== net.protocolVersion && (
                          <span className="badge badge--danger">
                            protocol v{peer.protocolVersion} — update needed
                          </span>
                        )}
                    </div>
                  ))}
                </div>
              </>
            )}

            <h3 className="settings__subtitle">Test a connection</h3>
            <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
              Enter the address the other machine shows here, and this checks which
              transports actually survive your network.
            </p>
            <div className="row">
              <input
                className="input"
                value={testHost}
                onChange={(event) => setTestHost(event.target.value)}
                onKeyDown={(event) => event.key === 'Enter' && runTest()}
                placeholder="10.102.3.199"
                spellCheck={false}
              />
              <Button onClick={runTest} disabled={testing || !testHost.trim()}>
                {testing ? 'Testing…' : 'Test'}
              </Button>
            </div>

            {result && (
              <div
                className={`callout callout--${result.verdict === 'unreachable' ? 'warning' : 'accent'}`}
                style={{ marginTop: 'var(--space-4)' }}
              >
                <span className="callout__icon">
                  {result.verdict === 'unreachable' ? <AlertIcon size={17} /> : <ShieldIcon size={17} />}
                </span>
                <div className="callout__body">
                  <div className="callout__title">
                    {result.verdict === 'direct' && 'Both transports reach it'}
                    {result.verdict === 'tcp-only' && 'Reachable, but UDP is filtered'}
                    {result.verdict === 'udp-only' && 'UDP works, direct connections do not'}
                    {result.verdict === 'unreachable' && 'Nothing reaches that device'}
                  </div>
                  <div className="callout__text">{result.detail}</div>
                  <div className="row" style={{ gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
                    <span className="text-sm">
                      TCP {result.tcpReachable ? '✓ reachable' : '✗ blocked'}
                    </span>
                    <span className="text-sm">
                      UDP {result.udpReplied ? '✓ replied' : '✗ no reply'}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginTop: 'var(--space-6) ' }} />

            <Field
              label="Add a device by IP"
              hint="Opens a direct connection as well as UDP, so it works even where UDP is filtered. Find the other machine's address above."
            >
              <div className="row">
                <input
                  className="input"
                  value={peerHost}
                  onChange={(event) => setPeerHost(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && peerHost.trim()) {
                      onConnectPeer(peerHost.trim());
                      setPeerHost('');
                    }
                  }}
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

            {state.rememberedPeers.length > 0 && (
              <>
                <h3 className="settings__subtitle">Remembered devices</h3>
                <p className="field__hint" style={{ marginBottom: 'var(--space-3)' }}>
                  Reconnected to automatically every time Campus Connect starts, so the address only
                  has to be typed once.
                </p>
                <div className="blocklist">
                  {state.rememberedPeers.map((peer) => (
                    <div key={`${peer.host}:${peer.port}`} className="blocklist__row">
                      <span className="blocklist__icon">
                        <SignalIcon size={15} />
                      </span>
                      <span className="blocklist__body">
                        <span className="blocklist__name">{peer.name}</span>
                        <span className="blocklist__meta mono">
                          {peer.host}:{peer.port}
                        </span>
                      </span>
                      <Button size="sm" onClick={() => onForgetPeer(peer.host, peer.port)}>
                        Forget
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        {section === 'updates' && (
          <section className="settings__section">
            <h2 className="settings__title">Updates</h2>
            <p className="settings__lede">
              Worth leaving on. Two devices running different versions cannot talk to each
              other at all, so an out-of-date machine looks like a broken app.
            </p>

            <div className="meter" style={{ marginBottom: 'var(--space-5)' }}>
              <div className="meter__head">
                <span className="meter__value">v{update.currentVersion}</span>
                <span className="meter__of">{updateHeadline}</span>
              </div>
              {update.state === 'downloading' && (
                <div className="meter__track" style={{ marginBottom: 0 }}>
                  <div className="meter__fill" style={{ width: `${Math.max(3, update.percent ?? 0)}%` }} />
                </div>
              )}
              {update.error && update.state === 'error' && (
                <div className="meter__legend" style={{ color: 'var(--danger)' }}>
                  <span>{update.error}</span>
                </div>
              )}
            </div>

            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <Button
                onClick={onCheckUpdate}
                disabled={
                  update.state === 'checking' ||
                  update.state === 'downloading' ||
                  update.state === 'retrying'
                }
              >
                {update.state === 'checking' ? 'Checking…' : 'Check now'}
              </Button>

              {update.state === 'available' && (
                <Button variant="primary" onClick={onDownloadUpdate}>
                  <DownloadIcon size={15} />
                  Download v{update.availableVersion}
                </Button>
              )}

              {update.state === 'ready' && (
                <Button variant="primary" onClick={onInstallUpdate}>
                  Restart and install now
                </Button>
              )}

              {update.state === 'manual' && (
                <Button variant="primary" onClick={onInstallUpdate}>
                  Open the download page
                </Button>
              )}
            </div>

            <div style={{ marginTop: 'var(--space-5)' }}>
              <SwitchRow
                title="Keep Campus Connect up to date"
                description="Looks for a new version every few hours, downloads it quietly in the background, and installs it the next time you close the app. Nothing restarts on its own, and nothing interrupts a call or a transfer."
                checked={settings.autoUpdate}
                onChange={(next) => onUpdateSettings({ autoUpdate: next })}
              />
            </div>

            {!canSelfInstall && (
              <div className="callout callout--warning" style={{ marginTop: 'var(--space-4)' }}>
                <span className="callout__icon">
                  <AlertIcon size={17} />
                </span>
                <div className="callout__body">
                  <div className="callout__title">macOS installs updates by hand for now</div>
                  <div className="callout__text">
                    Applying an update automatically on macOS requires the app to be
                    code-signed, and this project has no certificate yet. Checking still
                    works and will tell you when a version is out — the download is a
                    manual step until then.
                  </div>
                </div>
              </div>
            )}
          </section>
        )}

        {section === 'about' && (
          <section className="settings__section">
            <h2 className="settings__title">About</h2>

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

            <div className="shortcuts">
              <h3 className="settings__subtitle">Keyboard shortcuts</h3>
              {[
                ['Ctrl + 1 … 9', 'Switch to that room'],
                ['Ctrl + F', 'Search the clipboard history'],
                ['Ctrl + Enter', 'Share the clipboard right now'],
                ['Enter', 'Send a chat message'],
                ['Esc', 'Close a dialog or clear the search']
              ].map(([keys, what]) => (
                <div key={keys} className="shortcut">
                  <kbd>{keys}</kbd>
                  <span>{what}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ snippets

/**
 * The snippet library, and the shortcut that reaches it.
 *
 * Kept in its own component because it is the one settings section with real
 * state of its own — an editor that is either adding or amending — and inlining
 * that would have made the main component's state a good deal harder to follow.
 */
function SnippetsSection({
  state,
  onSave,
  onDelete,
  onCopy,
  onUpdateSettings
}: {
  state: AppState;
  onSave: (input: { id?: string; label: string; content: string }) => void;
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');
  const [content, setContent] = React.useState('');
  const [recording, setRecording] = React.useState(false);

  function reset() {
    setEditingId(null);
    setLabel('');
    setContent('');
  }

  function submit() {
    if (!content.trim()) {
      return;
    }
    onSave({ id: editingId ?? undefined, label, content });
    reset();
  }

  /**
   * Captures the next key combination pressed and stores it as an Electron
   * accelerator. Far kinder than asking someone to type `Control+Shift+V` by
   * hand and getting the spelling wrong.
   */
  function onRecordKey(event: React.KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }

    const parts: string[] = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.metaKey) parts.push('Command');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');

    const key = event.key;
    // A modifier on its own is not a shortcut; keep listening.
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(key)) {
      return;
    }
    // A global shortcut without a modifier would swallow that key everywhere on
    // the machine, which is never what anyone means.
    if (parts.length === 0) {
      return;
    }

    parts.push(key.length === 1 ? key.toUpperCase() : key);
    onUpdateSettings({ quickPasteShortcut: parts.join('+') });
    setRecording(false);
  }

  return (
    <section className="settings__section">
      <h2 className="settings__title">Snippets</h2>
      <p className="settings__lede">
        Text you retype constantly — a build command, an endpoint, your student number. Snippets
        stay on this device and are never sent anywhere.
      </p>

      <h3 className="settings__subtitle">Quick paste</h3>

      <Field
        label="Shortcut"
        hint="Opens a searchable list of what you have copied, plus your snippets, over whatever app you are in. It works while this window is closed."
      >
        <div className="row">
          <button
            className={recording ? 'input shortcut-record is-recording' : 'input shortcut-record'}
            onClick={() => setRecording(true)}
            onKeyDown={recording ? onRecordKey : undefined}
          >
            {recording ? 'Press a combination…' : state.settings.quickPasteShortcut || 'Off'}
          </button>
          {state.settings.quickPasteShortcut ? (
            <Button size="sm" onClick={() => onUpdateSettings({ quickPasteShortcut: '' })}>
              Turn off
            </Button>
          ) : null}
        </div>
      </Field>

      <SwitchRow
        title="Paste automatically"
        description="After you pick something, press paste in the app you were using. Off means it is only copied and you paste it yourself."
        checked={state.settings.quickPasteAutoPaste}
        onChange={(next) => onUpdateSettings({ quickPasteAutoPaste: next })}
      />

      <h3 className="settings__subtitle">{editingId ? 'Edit snippet' : 'New snippet'}</h3>

      <Field label="Name" hint="Optional. The content is used when this is blank.">
        <input
          className="input"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. Dev server"
          maxLength={60}
        />
      </Field>

      <Field label="Content">
        <textarea
          className="input input--area"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="npm run dev -- --host"
          rows={3}
        />
      </Field>

      <div className="row row--end" style={{ marginTop: 'var(--space-3)' }}>
        {editingId ? <Button onClick={reset}>Cancel</Button> : null}
        <Button variant="primary" onClick={submit} disabled={!content.trim()}>
          {editingId ? 'Save changes' : 'Add snippet'}
        </Button>
      </div>

      <h3 className="settings__subtitle">
        Saved · {state.snippets.length}
      </h3>

      {state.snippets.length === 0 ? (
        <p className="text-secondary text-sm">
          Nothing saved yet. Anything in your clipboard history can be kept as a snippet from the
          Clipboard tab.
        </p>
      ) : (
        <div className="blocklist">
          {state.snippets.map((snippet) => (
            <div key={snippet.id} className="blocklist__row">
              <span className="blocklist__icon">
                <BookmarkIcon size={15} />
              </span>
              <span className="blocklist__body">
                <span className="blocklist__name">{snippet.label || snippet.content}</span>
                <span className="blocklist__meta">
                  {snippet.label ? `${oneLine(snippet.content)} · ` : ''}
                  {snippet.useCount === 0
                    ? 'Not used yet'
                    : `Used ${snippet.useCount} time${snippet.useCount === 1 ? '' : 's'}`}
                </span>
              </span>
              <Button size="sm" onClick={() => onCopy(snippet.id)} title="Copy to the clipboard">
                <CopyIcon size={14} />
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditingId(snippet.id);
                  setLabel(snippet.label);
                  setContent(snippet.content);
                }}
              >
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => onDelete(snippet.id)} title="Delete">
                <TrashIcon size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Snippets keep their line breaks; a one-line preview must not. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

// --------------------------------------------------------------- phone access

/**
 * Serving one room to a phone browser.
 *
 * The section is written to make the trade explicit before anyone switches it
 * on, not after. What a phone gets is plaintext, because a browser cannot hold
 * the room key — so the honest thing is to say that plainly next to the switch
 * rather than let it be discovered.
 */
function PhoneSection({
  state,
  onStart,
  onStop,
  onRevoke,
  onQr
}: {
  state: AppState;
  onStart: () => void;
  onStop: () => void;
  onRevoke: (connectedAt: number) => void;
  onQr: () => Promise<string | null>;
}) {
  const phone = state.phone;
  const [qr, setQr] = React.useState<string | null>(null);

  // Pinned to a ref: onQr arrives as a fresh closure every render, and asking
  // for the code depends only on the address it encodes. Depending on the
  // function itself would re-render a new QR image on every state tick.
  const qrRef = React.useRef(onQr);
  qrRef.current = onQr;

  React.useEffect(() => {
    if (!phone.active) {
      setQr(null);
      return;
    }
    let cancelled = false;
    qrRef.current().then((image) => !cancelled && setQr(image));
    return () => {
      cancelled = true;
    };
  }, [phone.active, phone.url]);

  return (
    <section className="settings__section">
      <h2 className="settings__title">Phone</h2>
      <p className="settings__lede">
        Use this computer from your phone's browser, on the same WiFi. No app to install — scan
        the code and the phone gets the same interface you are looking at now.
      </p>

      {phone.active ? (
        <>
          <div className="phone-live">
            <div className="phone-live__qr">
              {qr ? (
                <img src={qr} alt={`QR code for ${phone.url}`} />
              ) : (
                <span className="text-sm text-tertiary">Generating…</span>
              )}
            </div>
            <div className="phone-live__body">
              <div className="phone-live__room">
                <strong>Phone access is on</strong>
              </div>
              <p className="field__hint" style={{ marginTop: 'var(--space-3)' }}>
                Scan this with the phone's camera. It pairs straight away — there is nothing to
                type, and the phone is remembered afterwards.
              </p>
              <p className="field__hint">
                <strong>Each code works once.</strong> A new one appears after a phone pairs, so
                scan again for a second device. Typing the address instead of scanning will not
                connect.
              </p>
              <div className="row" style={{ marginTop: 'var(--space-4)' }}>
                <Button variant="danger" onClick={onStop}>
                  <XIcon size={15} />
                  Switch phone access off
                </Button>
              </div>
            </div>
          </div>

          {phone.lockedUntil > 0 ? (
            <div className="callout callout--warning" style={{ marginTop: 'var(--space-4)' }}>
              <span className="callout__icon">
                <AlertIcon size={17} />
              </span>
              <div className="callout__body">
                <div className="callout__title">Too many wrong PINs</div>
                <div className="callout__text">
                  Something tried the PIN too many times, so it is locked for a few minutes. If
                  that was not you, switch phone access off — whatever is guessing is on this
                  network.
                </div>
              </div>
            </div>
          ) : null}

          <h3 className="settings__subtitle">Connected phones · {phone.clients.length}</h3>

          {phone.clients.length === 0 ? (
            <p className="text-secondary text-sm">
              Nothing has paired yet. A phone types the PIN once and is then remembered.
            </p>
          ) : (
            <div className="blocklist">
              {phone.clients.map((client) => (
                <div key={client.pairedAt} className="blocklist__row">
                  <span className="blocklist__icon">
                    <QrIcon size={15} />
                  </span>
                  <span className="blocklist__body">
                    <span className="blocklist__name">{client.label}</span>
                    <span className="blocklist__meta">
                      {client.address} · paired {relativeTime(client.pairedAt)}
                    </span>
                  </span>
                  <Button size="sm" variant="danger" onClick={() => onRevoke(client.pairedAt)}>
                    Unpair
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          <Button variant="primary" onClick={onStart}>
            <QrIcon size={15} />
            Switch phone access on
          </Button>
        </div>
      )}

      <div className="callout callout--warning" style={{ marginTop: 'var(--space-5)' }}>
        <span className="callout__icon">
          <AlertIcon size={17} />
        </span>
        <div className="callout__body">
          <div className="callout__title">What a phone gets, and what it does not</div>
          <div className="callout__text">
            A paired phone can do almost everything this computer can — every room, chat, members,
            settings. Only remote desktop, calls and installing updates are held back, because
            they either cannot work from a browser or should not happen from a pocket.
            <br />
            <br />
            A browser also cannot hold a room's encryption key, so this computer decrypts and
            serves as ordinary text over the local network. Anyone able to watch traffic on this
            WiFi could read what the phone reads — unlike traffic between two computers running
            Campus Connect, which stays sealed. Scanning is what grants access; unpairing is what
            takes it away. Switch it off when you are done.
          </div>
        </div>
      </div>
    </section>
  );
}
