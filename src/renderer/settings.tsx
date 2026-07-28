import React from 'react';
import type { AppSettings, AppState, ConnectivityResult } from '../shared/types';
import { APP_INFO, FONT_SCALES, MAX_FONT_SCALE, MIN_FONT_SCALE, RETENTION_CHOICES, STORAGE_CHOICES } from '../shared/types';
import { Button, Field, SwitchRow } from './ui';
import { formatBytes, relativeTime } from './format';
import { listSystemFonts } from './fonts';
import {
  AlertIcon,
  BellIcon,
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

type SectionId = 'device' | 'appearance' | 'sync' | 'notifications' | 'storage' | 'network' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ReactNode }> = [
  { id: 'device', label: 'This device', icon: <UserIcon size={15} /> },
  { id: 'appearance', label: 'Appearance', icon: <TypeIcon size={15} /> },
  { id: 'sync', label: 'Sharing', icon: <ClipboardIcon size={15} /> },
  { id: 'notifications', label: 'Notifications', icon: <BellIcon size={15} /> },
  { id: 'storage', label: 'Storage', icon: <DatabaseIcon size={15} /> },
  { id: 'network', label: 'Network', icon: <SignalIcon size={15} /> },
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
  onOpenExternal,
  onCompactStorage,
  onTestConnection
}: {
  state: AppState;
  onRename: (name: string) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConnectPeer: (host: string) => void;
  onOpenExternal: (url: string) => void;
  onCompactStorage: () => void;
  onTestConnection: (host: string) => Promise<ConnectivityResult>;
}) {
  const [section, setSection] = React.useState<SectionId>('device');
  const [name, setName] = React.useState(state.deviceName);
  const [peerHost, setPeerHost] = React.useState('');
  const [testHost, setTestHost] = React.useState('');
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState<ConnectivityResult | null>(null);
  const [fonts, setFonts] = React.useState<string[] | null>(null);

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
            <p className="settings__lede">How this machine appears to everyone else.</p>

            <Field label="Device name" hint="Shown next to everything you share.">
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

            <dl className="facts">
              <div>
                <dt>Address</dt>
                <dd className="mono">
                  {state.localAddress}:{state.listenPort}
                </dd>
              </div>
              <div>
                <dt>Device id</dt>
                <dd className="mono truncate">{state.deviceId}</dd>
              </div>
              <div>
                <dt>Rooms</dt>
                <dd>{state.rooms.length}</dd>
              </div>
            </dl>
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
              title="Share my clipboard"
              description="Send what you copy to the room you have selected."
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
              title="System notifications"
              description="Show a notification for new messages, clipboard items, join requests and invitations."
              checked={settings.notifications}
              onChange={(next) => onUpdateSettings({ notifications: next })}
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
                  else.
                </div>
              </div>
            </div>
          </section>
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

            <h3 className="h3" style={{ margin: 'var(--space-6) 0 var(--space-3)' }}>
              Network adapters
            </h3>
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
                <h3 className="h3" style={{ margin: 'var(--space-6) 0 var(--space-3)' }}>
                  Devices on this network
                </h3>
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

            <h3 className="h3" style={{ margin: 'var(--space-6) 0 var(--space-3)' }}>
              Test a connection
            </h3>
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
              <h3 className="h3" style={{ marginBottom: 'var(--space-3)' }}>
                Keyboard shortcuts
              </h3>
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
