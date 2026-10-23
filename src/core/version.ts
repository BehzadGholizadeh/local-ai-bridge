import fs from 'node:fs';
import path from 'node:path';

/** Version from package.json (dist/core/version.js → ../../package.json). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
