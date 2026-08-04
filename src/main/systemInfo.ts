import os from 'node:os';

export function getSystemDeviceName(): string {
  return os.hostname();
}

