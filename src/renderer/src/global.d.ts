import type { BridgeApi } from '../../shared/types';

declare global {
  interface Window {
    bridge: BridgeApi;
  }
}

export {};
