/// <reference types="vite/client" />

import type { CampusConnectApi } from '../shared/bridge';

declare global {
  interface Window {
    campusConnect: CampusConnectApi;
  }
}

export {};
