import React from 'react';
import type { FileShareFileState, FileShareState, FileShareTransfer, PeerInfo } from '../shared/types';
import type { StatusTone } from '../shared/bridge';
import { Badge, Button, EmptyState, Modal } from './ui';
import { formatBytes, initials } from './format';
import {
  AlertIcon,
  CheckIcon,
  DownloadIcon,
  FileIcon,
  PaperclipIcon,
  SearchIcon,
  SendIcon,
  UsersIcon,
  XIcon
} from './icons';

import { api } from './api';

/**
 * Peer-to-peer file sharing, in the window.
 *
 * The main process owns the transfers; this owns how they are asked for and
 * what they look like while they run. The one piece of behaviour that lives
 * here rather than there is the picker: it opens by itself the moment a peer
 * accepts, because the request deliberately carried no files and there is
 * nothing else the sender could possibly want to do next.
 */

/** `formatBytes` returns nothing for zero, which reads badly mid-transfer. */
function bytes(count: number): string {
  return count > 0 ? formatBytes(count) : '0 B';
}

export type FileShareController = {
  /** Asks a peer to receive files. Nothing is picked or read until they agree. */
  request: (peerId: string, peerName: string) => Promise<void>;
  respond: (transferId: string, accept: boolean) => Promise<void>;
  cancel: (transferId: string) => Promise<void>;
  dismiss: (transferId: string) => void;
  openFolder: () => void;
};

export function useFileShare({
  fileShare,
  push
}: {
  fileShare: FileShareState | undefined;
  push: (message: string, tone?: StatusTone) => void;
}): FileShareController {
  const stateRef = React.useRef(fileShare);
  stateRef.current = fileShare;
  const pushRef = React.useRef(push);
  pushRef.current = push;

  /** Transfers whose picker has already been opened once, and must not be again. */
  const prompted = React.useRef(new Set<string>());

  /*
   * A sender transfer that is active but still has no files is one the peer has
   * just accepted. Joined into a string so the effect only re-runs when the set
   * of them actually changes, rather than on every progress tick.
   */
  const awaiting = (fileShare?.transfers ?? [])
    .filter((transfer) => transfer.role === 'sender' && transfer.status === 'active' && transfer.files.length === 0)
    .map((transfer) => transfer.transferId)
    .join(',');

  React.useEffect(() => {
    for (const transferId of awaiting ? awaiting.split(',') : []) {
      if (prompted.current.has(transferId)) {
        continue;
      }
      prompted.current.add(transferId);

      void (async () => {
        // This resolves only once every file has finished streaming.
        const result = await api.fileSharePick(transferId);
        pushRef.current(result.message, result.ok ? 'success' : 'error');

        /*
         * A picker closed without choosing anything leaves the receiver sitting
         * on an accepted transfer that will never carry a byte, so the transfer
         * goes with the dialog.
         */
        const stranded = stateRef.current?.transfers.find((transfer) => transfer.transferId === transferId);
        if (stranded && stranded.status === 'active' && stranded.files.length === 0) {
          await api.fileShareCancel(transferId);
        }
      })();
    }
  }, [awaiting]);

  const request = React.useCallback(async (peerId: string, peerName: string) => {
    const result = await api.fileShareRequest(peerId, peerName);
    pushRef.current(result.message, result.ok ? 'info' : 'error');
  }, []);

  const respond = React.useCallback(async (transferId: string, accept: boolean) => {
    const result = await api.fileShareRespond(transferId, accept);
    pushRef.current(result.message, result.ok ? 'info' : 'error');
  }, []);

  const cancel = React.useCallback(async (transferId: string) => {
    const result = await api.fileShareCancel(transferId);
    if (!result.ok) {
      pushRef.current(result.message, 'error');
    }
  }, []);

  const dismiss = React.useCallback((transferId: string) => {
    void api.fileShareDismiss(transferId);
  }, []);

  const openFolder = React.useCallback(() => {
    void api.fileShareOpenFolder();
  }, []);

  return { request, respond, cancel, dismiss, openFolder };
}

// ------------------------------------------------------------ accept dialog

/**
 * The dialog that stands between someone asking and anything landing on disk.
 *
 * It cannot say what is coming, because at this point nothing has been picked —
 * so it says exactly that, and says who is asking and where the files would go.
 * Those are the three things worth knowing before answering.
 */
export function FileRequestModal({
  request,
  downloadFolder,
  onRespond
}: {
  request: NonNullable<FileShareState['incoming']>;
  downloadFolder: string;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <Modal
      title="Incoming files"
      description={`${request.fromDeviceName} wants to send you files.`}
      onClose={() => onRespond(false)}
      footer={
        <>
          <Button variant="danger" onClick={() => onRespond(false)}>
            <XIcon size={15} />
            Decline
          </Button>
          <Button variant="primary" onClick={() => onRespond(true)}>
            <CheckIcon size={15} />
            Accept
          </Button>
        </>
      }
    >
      <div className="incoming-call">
        <span className="incoming-call__avatar">{initials(request.fromDeviceName)}</span>
        <div>
          <div className="incoming-call__name">{request.fromDeviceName}</div>
          <div className="text-sm text-secondary">Nothing is sent until you accept.</div>
        </div>
      </div>

      <div className="callout callout--warning" style={{ marginTop: 'var(--space-5)' }}>
        <span className="callout__icon">
          <AlertIcon size={17} />
        </span>
        <div className="callout__body">
          <div className="callout__title">What accepting means</div>
          <div className="callout__text">
            {request.fromDeviceName} chooses what to send only <em>after</em> you accept, so there is
            no way to see the files first. They are written to{' '}
            <span className="mono">{downloadFolder}</span> as they arrive, and you can stop the
            transfer at any point. Only accept from a device you recognise.
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- panel

/** What a transfer is doing, in the words its own side would use. */
function statusLine(transfer: FileShareTransfer): string {
  const sending = transfer.role === 'sender';

  switch (transfer.status) {
    case 'requested':
      return `Waiting for ${transfer.peerName} to accept…`;
    case 'active':
      if (sending && transfer.files.length === 0) {
        return 'Choose what to send…';
      }
      return sending ? `Sending to ${transfer.peerName}` : `Receiving from ${transfer.peerName}`;
    case 'done':
      return sending ? `Sent to ${transfer.peerName}` : 'Saved to your downloads';
    case 'cancelled':
      // A transfer the other side stopped says so; one stopped here needs no
      // explaining to the person who stopped it.
      return transfer.error ?? 'Stopped';
    case 'error':
      return transfer.error ?? 'Something went wrong';
  }
}

function statusTone(status: FileShareTransfer['status']): 'neutral' | 'accent' | 'success' | 'danger' {
  if (status === 'done') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'active') return 'accent';
  return 'neutral';
}

function TransferFile({ file }: { file: FileShareFileState }) {
  const share = file.size > 0 ? Math.min(1, file.moved / file.size) : file.status === 'done' ? 1 : 0;

  return (
    <div className="xfer-file">
      <span className="xfer-file__icon">
        {file.status === 'done' ? <CheckIcon size={14} /> : <FileIcon size={14} />}
      </span>
      <div className="xfer-file__body">
        <div className="xfer-file__name" title={file.savedPath ?? file.name}>
          {file.name}
        </div>
        <div className="meter__track xfer-file__track">
          <div
            className={file.status === 'error' ? 'meter__fill is-high' : 'meter__fill'}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
      </div>
      <span className="xfer-file__size">
        {file.status === 'done' ? bytes(file.size) : `${bytes(file.moved)} / ${bytes(file.size)}`}
      </span>
    </div>
  );
}

function Transfer({
  transfer,
  onCancel,
  onDismiss
}: {
  transfer: FileShareTransfer;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const running = transfer.status === 'requested' || transfer.status === 'active';
  const share = transfer.bytesTotal > 0 ? Math.min(1, transfer.bytesDone / transfer.bytesTotal) : 0;

  return (
    <div className={running ? 'xfer is-running' : 'xfer'}>
      <div className="xfer__head">
        <span className="xfer__icon">
          {transfer.role === 'sender' ? <SendIcon size={15} /> : <DownloadIcon size={15} />}
        </span>
        <div className="xfer__body">
          <div className="xfer__title">{statusLine(transfer)}</div>
          <div className="xfer__meta">
            {transfer.files.length > 0
              ? `${transfer.files.length} file${transfer.files.length === 1 ? '' : 's'} · ${bytes(
                  transfer.bytesDone
                )} of ${bytes(transfer.bytesTotal)}`
              : transfer.role === 'sender'
                ? 'Nothing has been sent yet'
                : 'Waiting for the first file'}
          </div>
        </div>
        <Badge tone={statusTone(transfer.status)}>
          {transfer.status === 'done'
            ? 'Done'
            : transfer.status === 'error'
              ? 'Failed'
              : transfer.status === 'cancelled'
                ? 'Stopped'
                : // A request nobody has answered is not a transfer in progress.
                  // It said "Sending" while nothing had been picked, let alone
                  // sent — the same is true one step later, accepted but
                  // still at the native picker, which `statusLine` above
                  // already renders as "Choose what to send…" and this used
                  // to contradict outright with "Sending".
                  transfer.status === 'requested' || (transfer.role === 'sender' && transfer.files.length === 0)
                  ? 'Waiting'
                  : transfer.role === 'sender'
                    ? 'Sending'
                    : 'Receiving'}
        </Badge>
        {running ? (
          <Button size="sm" variant="danger" onClick={onCancel}>
            <XIcon size={14} />
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            <XIcon size={14} />
            Clear
          </Button>
        )}
      </div>

      {transfer.bytesTotal > 0 ? (
        <div className="meter__track">
          <div
            className={transfer.status === 'error' ? 'meter__fill is-high' : 'meter__fill'}
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </div>
      ) : null}

      {transfer.files.length > 0 ? (
        <div className="xfer__files">
          {transfer.files.map((file) => (
            <TransferFile key={file.fileId} file={file} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Files tab.
 *
 * Devices first, because sending is the thing you came here to do, and whatever
 * is currently moving above them, because that is the thing you came back to
 * check on. Only one transfer runs at a time, so every "Send files" button goes
 * quiet together while one is under way rather than queueing up surprises.
 */
export function FilesPanel({
  peers,
  deviceId,
  blockedIds,
  protocolVersion,
  fileShare,
  onSend,
  onCancel,
  onDismiss,
  onOpenFolder
}: {
  peers: PeerInfo[];
  deviceId: string;
  blockedIds: Set<string>;
  protocolVersion: number;
  fileShare: FileShareState;
  onSend: (peerId: string, peerName: string) => void;
  onCancel: (transferId: string) => void;
  onDismiss: (transferId: string) => void;
  onOpenFolder: () => void;
}) {
  /*
   * A device is only worth offering if files could actually reach it: not this
   * machine, not one being ignored, and not one speaking a protocol this build
   * cannot talk to.
   */
  const reachable = peers.filter(
    (peer) =>
      peer.id !== deviceId &&
      !blockedIds.has(peer.id) &&
      (peer.protocolVersion === undefined || peer.protocolVersion === protocolVersion)
  );

  const [query, setQuery] = React.useState('');
  const needle = query.trim().toLowerCase();
  // Nobody is listed until something is typed — a name or device id, not a
  // browsable roster. The count badge still says how many are reachable, so
  // there is a reason to search in the first place, just not who they are.
  const matches = needle
    ? reachable.filter(
        (peer) => peer.name.toLowerCase().includes(needle) || peer.id.toLowerCase().includes(needle)
      )
    : [];

  const busy =
    fileShare.incoming !== undefined ||
    fileShare.transfers.some((transfer) => transfer.status === 'requested' || transfer.status === 'active');
  const partner = fileShare.transfers.find(
    (transfer) => transfer.status === 'requested' || transfer.status === 'active'
  );

  return (
    <div className="stack">
      {fileShare.transfers.length > 0 && (
        <section className="card">
          <div className="card__header">
            <div style={{ flex: 1 }}>
              <h3 className="card__title">Transfers</h3>
              <p className="card__desc">
                Nothing here is kept. Transfers disappear when the app closes; the files a transfer
                saved stay where they landed.
              </p>
            </div>
          </div>

          <div className="xfers">
            {fileShare.transfers.map((transfer) => (
              <Transfer
                key={transfer.transferId}
                transfer={transfer}
                onCancel={() => onCancel(transfer.transferId)}
                onDismiss={() => onDismiss(transfer.transferId)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Send to a device</h3>
            <p className="card__desc">
              Send files straight to another machine — no room, no history, nothing stored. They have
              to accept before you pick anything.
            </p>
          </div>
          <Badge>{reachable.length}</Badge>
        </div>

        {reachable.length === 0 ? (
          <EmptyState
            icon={<UsersIcon size={22} />}
            title="No devices in range"
            text="Devices appear here once Campus Connect is running on them and they are on the same network."
          />
        ) : (
          <>
            <div className="search">
              <SearchIcon size={14} />
              <input
                className="search__input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
                placeholder="Find a name or device id here"
                aria-label="Find a device to send files to"
                autoFocus
                spellCheck={false}
              />
              {query ? (
                <Button size="sm" icon variant="ghost" onClick={() => setQuery('')} aria-label="Clear search">
                  <XIcon size={13} />
                </Button>
              ) : null}
            </div>

            {!needle ? (
              <p className="text-sm text-tertiary" style={{ paddingTop: 'var(--space-2)' }}>
                {reachable.length} {reachable.length === 1 ? 'device is' : 'devices are'} reachable
                right now — type a name or id above to find one.
              </p>
            ) : matches.length === 0 ? (
              <p className="text-sm text-tertiary" style={{ paddingTop: 'var(--space-2)' }}>
                Nothing reachable matches “{query.trim()}”.
              </p>
            ) : (
              matches.map((peer) => (
                <div key={peer.id} className="member">
                  <span className="member__avatar">{initials(peer.name)}</span>
                  <div className="member__body">
                    <div className="member__name">{peer.name}</div>
                    <div className="member__meta">{peer.host}</div>
                  </div>
                  <div className="member__actions">
                    <Button
                      size="sm"
                      onClick={() => onSend(peer.id, peer.name)}
                      disabled={busy}
                      title={
                        busy
                          ? `One transfer at a time${partner ? ` — ${partner.peerName} is using it` : ''}.`
                          : undefined
                      }
                    >
                      <PaperclipIcon size={14} />
                      Send files
                    </Button>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="card__header">
          <div style={{ flex: 1 }}>
            <h3 className="card__title">Where received files land</h3>
            <p className="card__desc mono">{fileShare.downloadFolder}</p>
          </div>
          <Button size="sm" onClick={onOpenFolder}>
            <DownloadIcon size={14} />
            Open folder
          </Button>
        </div>
      </section>
    </div>
  );
}
