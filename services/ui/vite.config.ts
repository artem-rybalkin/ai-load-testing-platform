import { defineConfig, type Plugin, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Docker/WSL2 bind mounts emit EIO on scandir when Windows writes a file mid-scan.
// Two paths need guarding:
//   1. FSWatcher 'error' event — caught via server.watcher.on('error')
//   2. readdirp scandir EIO arrives asynchronously via process.processTicksAndRejections
//      *after* Vite's graceful shutdown clears all FSWatcher listeners, so it becomes
//      an unhandled 'error' event that crashes Node. Caught via process.uncaughtException.
const resilientWatcher: Plugin = {
  name: 'resilient-watcher',
  configureServer(server) {
    server.watcher.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EIO' || err.code === 'ENOENT') {
        console.warn(`[vite] watcher ${err.code} on ${err.path ?? '?'} — ignored`);
        return;
      }
      throw err;
    });
    // Guard against the async path. Add only once — configureServer runs on every
    // Vite restart and we must not stack duplicate handlers.
    if (process.listenerCount('uncaughtException') === 0) {
      process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EIO' || err.code === 'ENOENT') {
          console.warn(`[vite] process ${err.code} on ${err.path ?? '?'} — ignored`);
          return;
        }
        console.error(err);
        process.exit(1);
      });
    }
  },
};

export default defineConfig({
  // Cast needed: npm hoists a different `vite` major for the root workspace (vitest/plugin-react@6)
  // than the one declared here, so plugin factories resolve to structurally-incompatible Plugin<any> types.
  plugins: [tailwindcss(), react(), resilientWatcher] as unknown as PluginOption[],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  optimizeDeps: {
    // Disable source-file crawling so esbuild never reads .tsx files from the
    // WSL2 bind mount during startup (those reads trigger intermittent EIO).
    // All real deps are listed explicitly and still get pre-bundled normally.
    noDiscovery: true,
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'recharts'],
  },
  server: {
    port: 3006,
    host: true,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 1000,
      // Exclude dirs that don't contain source code — scanning them every 1s
      // on a WSL2 bind mount overwhelms virtio-fs and causes cascade EIO errors.
      ignored: [
        '**/.next/**', '**/public/**', '**/dist/**', '**/coverage/**',
        // src/tsconfig.json exists only to give esbuild a stable stat target (avoids EIO
        // on the non-existent path during directory-walk). It never actually changes, but
        // WSL2 reports inconsistent mtimes on new files — ignore it so the watcher doesn't
        // trigger spurious full-reloads every second.
        path.resolve(__dirname, 'src/tsconfig.json'),
      ],
    },
    // Proxy all backend services through Vite so cookies are same-origin.
    // Use Docker service names — inside the container, localhost:<port> is unreachable.
    proxy: {
      '/api':        { target: process.env.API_SERVICE_URL  || 'http://api-service:3000',     rewrite: (path: string) => path.replace(/^\/api/, '') },
      '/data':       { target: process.env.RESULTS_SERVICE_URL || 'http://results-service:3004', rewrite: (path: string) => path.replace(/^\/data/, ''), ws: true },
      '/viewer':     process.env.RECORDER_SERVICE_URL || 'http://recorder-service:3007',
      '/recordings': process.env.RECORDER_SERVICE_URL || 'http://recorder-service:3007',
    },
  },
});
