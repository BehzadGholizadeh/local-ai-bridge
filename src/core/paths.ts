import os from 'node:os';
import path from 'node:path';

const APP_DIR = 'local-ai-bridge';

/**
 * Where settings, history and browser profiles live. Shared by the desktop app
 * and the headless server so both use the same logins. Override with LAB_DATA_DIR.
 */
export function defaultDataDir(): string {
  if (process.env.LAB_DATA_DIR) return path.resolve(process.env.LAB_DATA_DIR);
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_DIR);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_DIR);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_DIR);
}
