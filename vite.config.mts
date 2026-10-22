import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strict CSP for the packaged app only; the dev server needs inline scripts for hot reload.
const csp = (): Plugin => ({
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'" />`,
    ),
});

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), csp()],
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
});
