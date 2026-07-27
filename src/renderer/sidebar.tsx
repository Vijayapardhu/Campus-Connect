import React from 'react';
import type { AppState, DiscoveredRoom, RoomInfo } from '../shared/types';
import { Button } from './ui';
import { initials } from './format';
import { ClipboardIcon, GlobeIcon, KeyIcon, LockIcon, PlusIcon, SettingsIcon } from './icons';

function roomMeta(room: RoomInfo, locked: boolean): string {
  if (locked) {
    return 'Locked — password needed';
  }

  const accepted = room.members.filter((member) => member.status === 'accepted').length;
  return `${accepted} ${accepted === 1 ? 'device' : 'devices'}`;
}

export function Sidebar({
  state,
  lockedRoomIds,
  onSelectRoom,
  onCreateRoom,
  onJoinByCode,
  onJoinDiscovered,
  onOpenSettings
}: {
  state: AppState;
  lockedRoomIds: Set<string>;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: () => void;
  onJoinByCode: () => void;
  onJoinDiscovered: (room: DiscoveredRoom) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark">
          <ClipboardIcon size={15} />
        </span>
        <span className="sidebar__name">Shared Clipboard</span>
      </div>

      <div className="sidebar__scroll">
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
        <button className="device-card" onClick={onOpenSettings} title="Settings">
          <span className="device-card__avatar">{initials(state.deviceName)}</span>
          <span className="device-card__body">
            <span className="device-card__name">{state.deviceName}</span>
            <span className="device-card__status">
              <span className={state.settings.syncEnabled ? 'status-dot' : 'status-dot is-off'} />
              {state.settings.syncEnabled ? 'Sharing on' : 'Sharing paused'}
              {state.peers.length > 0 ? ` · ${state.peers.length} nearby` : ''}
            </span>
          </span>
          <SettingsIcon size={15} />
        </button>
      </div>
    </aside>
  );
}
