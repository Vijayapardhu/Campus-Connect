import os from 'node:os';

export function getSystemDeviceName(): string {
  return os.hostname();
}

export function getSystemUsername(): string {
  return os.userInfo().username;
}
