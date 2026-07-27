import type { SharedClipboardApi } from '../shared/bridge';

declare global {
  interface Window {
    sharedClipboard: SharedClipboardApi;
  }
}

export {};
