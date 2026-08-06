import { randomUUID } from 'node:crypto';
import { deriveRoomKey, generateJoinCode, generateSalt } from './crypto';
import type {
  DiscoveredRoom,
  RoomAdvert,
  RoomInfo,
  RoomMember,
  RoomType
} from '../shared/types';

/** A room advert is forgotten once its owner stops announcing. */
const ADVERT_TTL_MS = 20000;

/**
 * Where rooms and their derived keys are kept between runs. Implemented in
 * main.ts on top of electron-store; kept as an interface so RoomManager stays
 * testable and free of Electron imports.
 */
export interface RoomPersistence {
  readRooms(): RoomInfo[];
  writeRooms(rooms: RoomInfo[]): void;
  readKeys(): Record<string, string>;
  writeKeys(keys: Record<string, string>): void;
}

export type CreateRoomOptions = {
  name: string;
  type: RoomType;
  password: string;
  ownerId: string;
  ownerName: string;
};

export class RoomManager {
  private rooms = new Map<string, RoomInfo>();
  /** roomId -> derived AES key. Never leaves the main process. */
  private keys = new Map<string, Buffer>();
  private adverts = new Map<string, DiscoveredRoom>();

  constructor(private readonly persistence: RoomPersistence) {
    for (const room of persistence.readRooms()) {
      this.rooms.set(room.roomId, room);
    }

    for (const [roomId, hex] of Object.entries(persistence.readKeys())) {
      this.keys.set(roomId, Buffer.from(hex, 'hex'));
    }
  }

  // --- rooms ---------------------------------------------------------------

  createRoom({ name, type, password, ownerId, ownerName }: CreateRoomOptions): RoomInfo {
    const keySalt = generateSalt();
    const encrypted = password.length > 0;

    const room: RoomInfo = {
      roomId: randomUUID(),
      name,
      type,
      ownerId,
      ownerName,
      keySalt,
      encrypted,
      createdAt: Date.now(),
      joinCode: generateJoinCode(),
      members: [
        {
          deviceId: ownerId,
          deviceName: ownerName,
          status: 'accepted',
          role: 'owner',
          joinedAt: Date.now()
        }
      ]
    };

    this.rooms.set(room.roomId, room);
    if (encrypted) {
      this.keys.set(room.roomId, deriveRoomKey(password, keySalt));
    }

    this.persist();
    return room;
  }

  getRooms(): RoomInfo[] {
    return Array.from(this.rooms.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  getRoom(roomId: string): RoomInfo | undefined {
    return this.rooms.get(roomId);
  }

  findRoomByCode(joinCode: string): RoomInfo | undefined {
    for (const room of this.rooms.values()) {
      if (room.joinCode === joinCode) {
        return room;
      }
    }
    return undefined;
  }

  deleteRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.keys.delete(roomId);
    this.persist();
  }

  /**
   * Adopt the owner's copy of a room. The owner is the single source of truth
   * for the roster, so a non-owner never edits its own copy.
   */
  saveRoom(room: RoomInfo): void {
    this.rooms.set(room.roomId, room);
    this.persist();
  }

  // --- keys ----------------------------------------------------------------

  getKey(roomId: string): Buffer | undefined {
    return this.keys.get(roomId);
  }

  setKey(roomId: string, key: Buffer): void {
    this.keys.set(roomId, key);
    this.persist();
  }

  /**
   * Forgets a room's key without leaving the room.
   *
   * What happens on this device when the owner changes the password: the room
   * stays, its history stays, and it reports as locked until the new password is
   * entered. That is the whole point of changing a password — a device that
   * carried on reading would make the change meaningless.
   */
  dropKey(roomId: string): void {
    if (this.keys.delete(roomId)) {
      this.persist();
    }
  }

  /** True when the room needs a key we do not hold — i.e. we cannot read it. */
  isLocked(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return Boolean(room?.encrypted) && !this.keys.has(roomId);
  }

  // --- membership ----------------------------------------------------------

  isAcceptedMember(roomId: string, deviceId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    return room.members.some(
      (member) => member.deviceId === deviceId && member.status === 'accepted'
    );
  }

  isOwner(roomId: string, deviceId: string): boolean {
    return this.rooms.get(roomId)?.ownerId === deviceId;
  }

  /**
   * Whether a `room-leave` naming this device should be acted on.
   *
   * A device id on the wire is a claim, not a fact — nothing in the protocol
   * binds a message to the identity it names. The owner used to remove
   * whoever a leave pointed at, which meant any device on the network that
   * knew a room id could evict any member of it, without the password and
   * without ever being in the room.
   *
   * `provedKey` is the caller's answer to "did this message carry a proof
   * that opens with the room key?" — passed in rather than checked here so
   * this file stays free of anything that needs a Buffer of key material,
   * and so the rule itself can be tested on its own.
   *
   * An unencrypted room has no key and so no proof to demand; membership is
   * the whole of what is available there, and its traffic is plain text by
   * definition anyway.
   *
   * This still does not prove the sender *is* the device it names — a member
   * holding the key can name another member. Closing that needs per-device
   * signing keys and a wire-format change.
   */
  mayLeave(roomId: string, deviceId: string, provedKey: boolean): boolean {
    const room = this.rooms.get(roomId);
    if (!room) {
      return false;
    }

    if (!room.members.some((member) => member.deviceId === deviceId)) {
      return false;
    }

    return room.encrypted ? provedKey : true;
  }

  getMembers(roomId: string, status?: RoomMember['status']): RoomMember[] {
    const members = this.rooms.get(roomId)?.members ?? [];
    return status ? members.filter((member) => member.status === status) : members;
  }

  /**
   * Records an incoming join request. Returns undefined when the device is
   * already a member, so the caller can skip re-notifying the owner.
   */
  addPendingMember(
    roomId: string,
    deviceId: string,
    deviceName: string,
    publicKey?: string
  ): RoomInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }

    const existing = room.members.find((member) => member.deviceId === deviceId);
    if (existing) {
      existing.deviceName = deviceName;
      /*
       * The key is only recorded while a request is still pending. Letting a
       * re-request rewrite an accepted member's key would hand anybody who
       * learned the password a way to take over an existing membership,
       * which is the whole thing the key is here to prevent.
       */
      if (existing.status === 'accepted') {
        return undefined;
      }
      existing.publicKey = publicKey;
      this.persist();
      return room;
    }

    room.members.push({
      deviceId,
      deviceName,
      status: 'pending',
      role: 'member',
      joinedAt: Date.now(),
      publicKey
    });

    this.persist();
    return room;
  }

  addAcceptedMember(roomId: string, deviceId: string, deviceName: string): RoomInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room) {
      return undefined;
    }

    const existing = room.members.find((member) => member.deviceId === deviceId);
    if (existing) {
      existing.deviceName = deviceName;
      existing.status = 'accepted';
    } else {
      room.members.push({
        deviceId,
        deviceName,
        status: 'accepted',
        role: 'member',
        joinedAt: Date.now()
      });
    }

    this.persist();
    return room;
  }

  approveMember(roomId: string, deviceId: string): RoomInfo | undefined {
    const room = this.rooms.get(roomId);
    const member = room?.members.find((candidate) => candidate.deviceId === deviceId);
    if (!room || !member) {
      return undefined;
    }

    member.status = 'accepted';
    this.persist();
    return room;
  }

  /** Also used to kick: an owner can never be removed from their own room. */
  removeMember(roomId: string, deviceId: string): RoomInfo | undefined {
    const room = this.rooms.get(roomId);
    if (!room || room.ownerId === deviceId) {
      return undefined;
    }

    room.members = room.members.filter((member) => member.deviceId !== deviceId);
    this.persist();
    return room;
  }

  // --- adverts -------------------------------------------------------------

  toAdvert(room: RoomInfo): RoomAdvert {
    return {
      roomId: room.roomId,
      name: room.name,
      type: room.type,
      ownerId: room.ownerId,
      ownerName: room.ownerName,
      keySalt: room.keySalt,
      encrypted: room.encrypted,
      memberCount: room.members.filter((member) => member.status === 'accepted').length,
      createdAt: room.createdAt
    };
  }

  recordAdvert(advert: RoomAdvert, host: string): void {
    this.adverts.set(advert.roomId, { ...advert, host, lastSeen: Date.now() });
  }

  getAdvert(roomId: string): DiscoveredRoom | undefined {
    const advert = this.adverts.get(roomId);
    if (advert && Date.now() - advert.lastSeen > ADVERT_TTL_MS) {
      this.adverts.delete(roomId);
      return undefined;
    }
    return advert;
  }

  /** Adverts for rooms we have not joined, freshest first. */
  getDiscoveredRooms(): DiscoveredRoom[] {
    const now = Date.now();
    const discovered: DiscoveredRoom[] = [];

    for (const [roomId, advert] of this.adverts) {
      if (now - advert.lastSeen > ADVERT_TTL_MS) {
        this.adverts.delete(roomId);
        continue;
      }
      if (!this.rooms.has(roomId)) {
        discovered.push(advert);
      }
    }

    return discovered.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  dropAdvert(roomId: string): void {
    this.adverts.delete(roomId);
  }

  /** Forgets every discovered room, for when the app stops listening entirely. */
  clearAdverts(): void {
    this.adverts.clear();
  }

  private persist(): void {
    this.persistence.writeRooms(this.getRooms());

    const keys: Record<string, string> = {};
    for (const [roomId, key] of this.keys) {
      keys[roomId] = key.toString('hex');
    }
    this.persistence.writeKeys(keys);
  }
}
