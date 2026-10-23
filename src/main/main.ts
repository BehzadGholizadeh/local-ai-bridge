import path from 'node:path';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron';
import type {
  AgentDecision,
  AgentMode,
  AgentStartInput,
  AppState,
  ProviderAction,
  ProviderId,
  SendInput,
  Settings,
} from '../shared/types';
import { Bridge } from '../core/bridge';
import { defaultDataDir } from '../core/paths';
import { AgentService } from './agent-service';

const isDev = process.argv.includes('--dev');
const DEV_URL = 'http://localhost:5173';

// Same data directory as the headless server, so both share logins and history.
app.setPath('userData', defaultDataDir());

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: Bridge;
let agents: AgentService;
let quitting = false;

const iconPath = () => path.join(app.getAppPath(), 'assets', 'icon.png');

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Local AI Bridge',
    icon: iconPath(),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171d' : '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win?.show();
  });
  // Links in replies open in the user's normal browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!(isDev && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (!quitting && bridge.settings.get().minimizeToTray && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  if (isDev) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function createTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('Local AI Bridge');
  const rebuild = () => {
    const info = bridge.apiInfo();
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Local AI Bridge', click: showWindow },
        { label: info.running ? `API: ${info.url}` : 'API: not running', enabled: false },
        { label: 'Copy API URL', enabled: info.running, click: () => clipboard.writeText(info.url) },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
  };
  rebuild();
  bridge.on('api', rebuild);
  tray.on('click', showWindow);
}

function applySystemSettings(s: Settings): void {
  nativeTheme.themeSource = s.theme;
  if (process.platform !== 'linux' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: s.startOnBoot, args: ['--hidden'] });
  }
}

/** ipcMain.handle wrapper: errors travel as plain messages instead of Electron's wrapped text. */
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

function registerIpc(): void {
  handle('state:get', (): AppState => ({
    settings: bridge.settings.get(),
    statuses: bridge.statuses(),
    api: bridge.apiInfo(),
    version: app.getVersion(),
    dataDir: bridge.dataDir,
    selectorsDir: bridge.selectors.dir,
  }));
  handle('settings:update', (patch: Partial<Settings>) => bridge.settings.update(patch));
  handle('provider:action', (id: ProviderId, action: ProviderAction) => bridge.providerAction(id, action));
  handle('history:list', () => bridge.history.list());
  handle('history:get', (id: string) => bridge.history.get(id) ?? null);
  handle('history:delete', (id: string) => {
    bridge.chat.stop(id);
    bridge.history.delete(id);
    send('history:changed');
  });
  handle('history:rename', (id: string, title: string) => {
    bridge.history.rename(id, title);
    send('history:changed');
  });
  handle('chat:send', (input: SendInput) => bridge.chat.send(input));
  handle('chat:stop', (id: string) => bridge.chat.stop(id));
  handle('open:path', (which: 'data' | 'selectors') =>
    shell.openPath(which === 'selectors' ? bridge.selectors.dir : bridge.dataDir),
  );
  handle('selectors:reload', () => bridge.selectors.reload());
  handle('clipboard:write', (text: string) => clipboard.writeText(String(text)));
  handle('logs:get', () => bridge.log.entries);

  handle('agent:defaults', () => ({ workspace: app.getPath('desktop') }));
  handle('agent:pick-folder', async (current?: string) => {
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose the agent workspace',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current || app.getPath('desktop'),
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle('agent:start', (input: AgentStartInput) => agents.start(input));
  handle('agent:stop', (id: string) => agents.stop(id));
  handle('agent:approve', (requestId: string, decision: AgentDecision) => agents.approve(requestId, decision));
  handle('agent:set-mode', (id: string, mode: AgentMode) => agents.setMode(id, mode));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    bridge = new Bridge(defaultDataDir());
    agents = new AgentService(bridge, (p) => send('agent:event', p));
    bridge.on('status', (s) => send('status', s));
    bridge.on('api', (a) => send('api', a));
    bridge.chat.on('message', (p) => send('message', p));
    bridge.chat.on('history', () => send('history:changed'));
    bridge.settings.on('change', (s: Settings) => {
      applySystemSettings(s);
      send('settings', s);
    });
    applySystemSettings(bridge.settings.get());
    registerIpc();
    createWindow();
    createTray();
    await bridge.start();
  });

  app.on('activate', showWindow);

  app.on('window-all-closed', () => {
    if (!tray || !bridge?.settings.get().minimizeToTray) app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting || !bridge) return;
    quitting = true;
    e.preventDefault();
    agents?.stopAll();
    bridge
      .stop()
      .catch(() => undefined)
      .finally(() => app.exit(0));
  });
}
