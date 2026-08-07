import React from 'react';
import type { AppState, DiscoveredRoom, RoomInfo, RoomInvite } from '../shared/types';
import { Button } from './ui';
import { initials } from './format';
import {
  AlertIcon,
  ChatIcon,
  ClipboardIcon,
  GlobeIcon,
  KeyIcon,
  LockIcon,
  MailIcon,
  PaperclipIcon,
  PlusIcon,
  SettingsIcon
} from './icons';

function roomMeta(room: RoomInfo, locked: boolean): string {
  if (locked) {
    return 'Locked — password needed';
  }

  const accepted = room.members.filter((member) => member.status === 'accepted').length;
  return `${accepted} ${accepted === 1 ? 'device' : 'devices'}`;
}

export function Sidebar({
  header,
  state,
  lockedRoomIds,
  onSelectRoom,
  onCreateRoom,
  onJoinByCode,
  onJoinDiscovered,
  onOpenInvite,
  onOpenFiles,
  filesOpen,
  showFiles,
  runningTransfers,
  onOpenMessages,
  messagesOpen,
  showMessages,
  unreadMessages,
  onOpenSettings,
  settingsOpen
}: {
  /** Rendered above everything else. The phone puts its two actions here. */
  header?: React.ReactNode;
  state: AppState;
  lockedRoomIds: Set<string>;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onJoinByCode: () => void;
  onJoinDiscovered: (room: DiscoveredRoom) => void;
  onOpenInvite: (invite: RoomInvite) => void;
  onOpenFiles: () => void;
  filesOpen: boolean;
  /** False on a phone: file transfer is between two computers' disks. */
  showFiles: boolean;
  /** Transfers under way right now, in either direction. */
  runningTransfers: number;
  onOpenMessages: () => void;
  messagesOpen: boolean;
  /** False on a phone: direct messages are between two computers, like files. */
  showMessages: boolean;
  unreadMessages: number;
  onOpenSettings: () => void;
  settingsOpen: boolean;
}) {
  const online = state.settings.online !== false;

  // Reachable, but speaking a protocol this build cannot talk to.
  const outdated = state.peers.filter(
    (peer) =>
      peer.protocolVersion !== undefined &&
      peer.protocolVersion !== state.diagnostics.protocolVersion
  );

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">
          <ClipboardIcon size={15} />
        </span>
        <span className="sidebar__name">Campus Connect</span>
      </div>

      <div className="sidebar__scroll">
        {header}
        {outdated.length > 0 && (
          <section className="sidebar__section">
            <button className="room-item is-warning" onClick={onOpenSettings} title="Open network settings">
              <span className="room-item__icon">
                <AlertIcon size={13} />
              </span>
              <span className="room-item__body">
                <span className="room-item__name">Version mismatch</span>
                <span className="room-item__meta">
                  {outdated.length === 1
                    ? `${outdated[0].name} runs another version`
                    : `${outdated.length} devices run another version`}
                </span>
              </span>
            </button>
          </section>
        )}

        {state.invites.length > 0 && (
          <section className="sidebar__section">
            <div className="sidebar__label">
              <span>Invitations</span>
              <span className="room-item__badge">{state.invites.length}</span>
            </div>

            {state.invites.map((invite) => (
              <button
                key={invite.roomId}
                className="room-item is-invite"
                onClick={() => onOpenInvite(invite)}
                title={`Respond to ${invite.ownerName}'s invitation`}
              >
                <span className="room-item__icon">
                  <MailIcon size={13} />
                </span>
                <span className="room-item__body">
                  <span className="room-item__name">{invite.roomName}</span>
                  <span className="room-item__meta">from {invite.ownerName}</span>
                </span>
              </button>
            ))}
          </section>
        )}

        <section className="sidebar__section">
          <div className="sidebar__label">
            <span>Your rooms</span>
            <span>{state.rooms.length}</span>
          </div>

          {state.rooms.length === 0 ? (
            <p className="sidebar__empty">You are not in any room yet.</p>
          ) : (
            state.rooms.map((room) => {
              const locked = lockedRoomIds.has(room.roomId);
              const pending =
                room.ownerId === state.deviceId
                  ? room.members.filter((member) => member.status === 'pending').length
                  : 0;

              return (
                <button
                  key={room.roomId}
                  className={room.roomId === state.currentRoomId ? 'room-item is-active' : 'room-item'}
                  onClick={() => onSelectRoom(room.roomId)}
                  aria-current={room.roomId === state.currentRoomId}
                >
                  <span className="room-item__icon">
                    {room.type === 'private' ? <LockIcon size={13} /> : <GlobeIcon size={13} />}
                  </span>
                  <span className="room-item__body">
                    <span className="room-item__name">{room.name}</span>
                    <span className="room-item__meta">{roomMeta(room, locked)}</span>
                  </span>
                  {pending > 0 ? <span className="room-item__badge">{pending}</span> : null}
                </button>
              );
            })
          )}
        </section>

        {state.discovered.length > 0 && (
          <section className="sidebar__section">
            <div className="sidebar__label">
              <span>On this network</span>
              <span>{state.discovered.length}</span>
            </div>

            {state.discovered.map((room) => (
              <button
                key={room.roomId}
                className="room-item"
                onClick={() => onJoinDiscovered(room)}
                title={`Join ${room.name}`}
              >
                <span className="room-item__icon">
                  {room.type === 'private' ? <LockIcon size={13} /> : <GlobeIcon size={13} />}
                </span>
                <span className="room-item__body">
                  <span className="room-item__name">{room.name}</span>
                  <span className="room-item__meta">
                    {room.ownerName}
                    {room.encrypted ? ' · encrypted' : ''}
                  </span>
                </span>
              </button>
            ))}
          </section>
        )}

        <section className="sidebar__section">
          <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <Button block onClick={onCreateRoom}>
              <PlusIcon size={15} />
              New room
            </Button>
            <Button block variant="ghost" onClick={onJoinByCode}>
              <KeyIcon size={15} />
              Join a room
            </Button>
          </div>
        </section>
      </div>

      <div className="sidebar__footer">
        {/* Sending a file to one machine belongs to no room — it has no
            history, no members and nobody else sees it — so it sits beside
            Settings rather than inside a room, and works with none selected. */}
        {showFiles ? (
        <button
          className={filesOpen ? 'room-item is-active' : 'room-item'}
          onClick={onOpenFiles}
          title="Send files to a nearby device"
          aria-current={filesOpen}
        >
          <span className="room-item__icon">
            <PaperclipIcon size={13} />
          </span>
          <span className="room-item__body">
            <span className="room-item__name">Files</span>
            <span className="room-item__meta">
              {runningTransfers > 0
                ? `${runningTransfers} in progress`
                : online
                  ? 'Send to a nearby device'
                  : 'Switched off'}
            </span>
          </span>
          {runningTransfers > 0 ? <span className="room-item__badge">{runningTransfers}</span> : null}
        </button>
        ) : null}

        {/* Same reasoning as Files: a direct message belongs to no room
            either, so it sits beside it rather than inside one. */}
        {showMessages ? (
        <button
          className={messagesOpen ? 'room-item is-active' : 'room-item'}
          onClick={onOpenMessages}
          title="Message a nearby device directly"
          aria-current={messagesOpen}
        >
          <span className="room-item__icon">
            <ChatIcon size={13} />
          </span>
          <span className="room-item__body">
            <span className="room-item__name">Messages</span>
            <span className="room-item__meta">
              {unreadMessages > 0
                ? `${unreadMessages} unread`
                : online
                  ? 'Message a nearby device'
                  : 'Switched off'}
            </span>
          </span>
          {unreadMessages > 0 ? <span className="room-item__badge">{unreadMessages}</span> : null}
        </button>
        ) : null}

        <button
          className={settingsOpen ? 'device-card is-active' : 'device-card'}
          onClick={onOpenSettings}
          title="Settings"
        >
          <span className="device-card__avatar">{initials(state.deviceName)}</span>
          <span className="device-card__body">
            <span className="device-card__name">{state.deviceName}</span>
            <span className="device-card__status">
              <span className={online && state.settings.syncEnabled ? 'status-dot' : 'status-dot is-off'} />
              {!online ? 'Switched off' : state.settings.syncEnabled ? 'Sharing on' : 'Sharing paused'}
              {online && state.peers.length > 0 ? ` · ${state.peers.length} nearby` : ''}
            </span>
          </span>
          <SettingsIcon size={15} />
        </button>
      </div>
    </aside>
  );
}
