/**
 * Working out where on the network to actually send things.
 *
 * This is the part that decides whether two machines on the same WiFi can see
 * each other at all, and it has two traps in it:
 *
 *  1. `255.255.255.255` — the *limited* broadcast address — is not sent out
 *     every interface. The routing table picks one. A Windows machine with
 *     WSL, Hyper-V, VirtualBox or Docker installed has several virtual
 *     adapters, and the one chosen is frequently not the WiFi adapter. The
 *     packets then go nowhere useful and discovery silently never works.
 *
 *  2. "the local IP address" is not well defined on such a machine either.
 *     Taking the first non-internal IPv4 usually lands on a virtual adapter,
 *     which then travels inside every message as the address to reply to.
 *
 * The answer to both is to look at the interfaces properly: broadcast to every
 * interface's own subnet broadcast address, and pick the reply address from a
 * real network rather than the first one enumerated.
 *
 * No Electron imports — this file is covered by `npm test`.
 */

export type NetworkInterface = {
  name: string;
  address: string;
  netmask: string;
  family: string;
  internal: boolean;
};

export type InterfaceReport = {
  name: string;
  address: string;
  broadcast: string | null;
  /** Whether this looks like a virtual adapter rather than a real network. */
  virtual: boolean;
  /** True for the interface chosen as this device's address. */
  chosen: boolean;
};

export const LIMITED_BROADCAST = '255.255.255.255';

/**
 * Adapters that exist on a developer machine but are not the network anyone
 * else is on. Matched by name, because their address ranges overlap with real
 * private networks and cannot be told apart by address alone.
 */
const VIRTUAL_PATTERNS = [
  /vethernet/i,
  /virtualbox/i,
  /vmware/i,
  /hyper-?v/i,
  /docker/i,
  /\bwsl\b/i,
  /loopback/i,
  /bluetooth/i,
  /tailscale/i,
  /zerotier/i,
  /openvpn/i,
  /\btap\b/i,
  /\btun[0-9]*\b/i,
  /npcap/i,
  /pseudo-interface/i
];

/** Interfaces whose name suggests a real wired or wireless network. */
const PHYSICAL_PATTERNS = [/wi-?fi/i, /wlan/i, /wireless/i, /^en[0-9]/i, /^eth[0-9]/i, /ethernet/i];

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_PATTERNS.some((pattern) => pattern.test(name));
}

function looksPhysical(name: string): boolean {
  return PHYSICAL_PATTERNS.some((pattern) => pattern.test(name));
}

function toInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function toAddress(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

/**
 * The directed broadcast address for an interface — 192.168.1.7/255.255.255.0
 * gives 192.168.1.255. Unlike the limited broadcast, this one is routed out
 * the interface it belongs to.
 */
export function subnetBroadcast(address: string, netmask: string): string | null {
  const host = toInt(address);
  const mask = toInt(netmask);
  if (host === null || mask === null || mask === 0) {
    return null;
  }

  // A /32 has no broadcast address of its own.
  if (mask === 0xffffffff) {
    return null;
  }

  return toAddress((host | (~mask >>> 0)) >>> 0);
}

/**
 * Everywhere a broadcast should go: each usable interface's own subnet
 * broadcast, then the limited broadcast as a fallback for anything the
 * enumeration missed.
 */
export function listBroadcastTargets(interfaces: NetworkInterface[]): string[] {
  const targets: string[] = [];

  for (const nic of usable(interfaces)) {
    const broadcast = subnetBroadcast(nic.address, nic.netmask);
    if (broadcast && !targets.includes(broadcast)) {
      targets.push(broadcast);
    }
  }

  targets.push(LIMITED_BROADCAST);
  return targets;
}

function usable(interfaces: NetworkInterface[]): NetworkInterface[] {
  return interfaces.filter(
    (nic) =>
      nic.family === 'IPv4' &&
      !nic.internal &&
      // Link-local: the interface never got an address.
      !nic.address.startsWith('169.254.')
  );
}

/**
 * This device's address, as told to everyone else. Prefers a real network
 * adapter over a virtual one, because that address is what other devices send
 * their replies to.
 */
export function pickLocalAddress(interfaces: NetworkInterface[]): string {
  const candidates = usable(interfaces);
  if (candidates.length === 0) {
    return '127.0.0.1';
  }

  const ranked = [...candidates].sort((a, b) => score(b) - score(a));
  return ranked[0].address;
}

function score(nic: NetworkInterface): number {
  let value = 0;
  if (!isVirtualInterface(nic.name)) value += 100;
  if (looksPhysical(nic.name)) value += 50;
  // Ordinary home and office networks.
  if (nic.address.startsWith('192.168.')) value += 10;
  if (nic.address.startsWith('10.')) value += 8;
  return value;
}

/** Everything the network diagnostics panel needs. */
export function describeInterfaces(interfaces: NetworkInterface[]): InterfaceReport[] {
  const chosen = pickLocalAddress(interfaces);

  return usable(interfaces).map((nic) => ({
    name: nic.name,
    address: nic.address,
    broadcast: subnetBroadcast(nic.address, nic.netmask),
    virtual: isVirtualInterface(nic.name),
    chosen: nic.address === chosen
  }));
}
