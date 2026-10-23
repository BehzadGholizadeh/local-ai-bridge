// Sandboxed preload: kept as a plain script (no import/export) so it compiles to code
// that only needs the sandbox's `require('electron')`.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value: T; error?: string };
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function subscribe<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const listener = (_e: unknown, payload: T) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const bridgeApi: import('../shared/types').BridgeApi = {
  getState: () => invoke('state:get'),
  updateSettings: (patch) => invoke('settings:update', patch),
  providerAction: (id, action) => invoke('provider:action', id, action),
  listConversations: () => invoke('history:list'),
  getConversation: (id) => invoke('history:get', id),
  deleteConversation: (id) => invoke('history:delete', id),
  renameConversation: (id, title) => invoke('history:rename', id, title),
  send: (input) => invoke('chat:send', input),
  stop: (id) => invoke('chat:stop', id),
  openPath: (which) => invoke('open:path', which),
  reloadSelectors: () => invoke('selectors:reload'),
  copy: (text) => invoke('clipboard:write', text),
  getLogs: () => invoke('logs:get'),
  onStatus: subscribe('status'),
  onSettings: subscribe('settings'),
  onApi: subscribe('api'),
  onMessage: subscribe('message'),
  onHistoryChanged: subscribe('history:changed'),
  agentDefaults: () => invoke('agent:defaults'),
  agentPickFolder: (current) => invoke('agent:pick-folder', current),
  agentStart: (input) => invoke('agent:start', input),
  agentStop: (id) => invoke('agent:stop', id),
  agentApprove: (requestId, decision) => invoke('agent:approve', requestId, decision),
  agentSetMode: (id, mode) => invoke('agent:set-mode', id, mode),
  onAgentEvent: subscribe('agent:event'),
};

contextBridge.exposeInMainWorld('bridge', bridgeApi);
