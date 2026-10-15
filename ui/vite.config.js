/**
 * Dev-server configuration for the dashboard. The only thing that has to be configured is the
 * proxy: in production the manager serves ui/dist itself, so the browser talks to one origin, and
 * this makes :5173 behave the same way during development.
 *
 * `npm start` sets PADDOCK_UI_TOKEN and loads this server inside Electron. Without that header the
 * dev server refuses the request, so opening the port in a browser does not open the app.
 * `npm run dev` leaves the token unset and stays a normal browser dev server.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PORT } from '../config.js';

// The manager's own configuration rather than a second copy of it: the port moves with
// PADDOCK_PORT or a .env, and a proxy pinned to the default would then point at nothing.
// `127.0.0.1`, never `localhost`: the manager binds loopback IPv4 by default while `localhost` can
// resolve to `::1` only, and the proxy hop would then fail to connect.
const API_TARGET = `http://127.0.0.1:${PORT}`;

/** @returns {import('vite').Plugin|null} */
function desktopOnly() {
  const token = process.env.PADDOCK_UI_TOKEN;
  if (!token) return null;
  const allowed = (req) => req.headers['x-paddock-desktop'] === token;
  return {
    name: 'paddock-desktop-only',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (allowed(req)) return next();
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end('Paddock runs in the desktop app.');
      });
      // After Vite has created the HTTP server. A browser can still open the socket; the page cannot.
      return () => {
        server.httpServer?.on('upgrade', (req, socket) => {
          if (!allowed(req)) socket.destroy();
        });
      };
    },
  };
}

export default defineConfig({
  plugins: [desktopOnly(), react()].filter(Boolean),
  server: {
    host: '127.0.0.1',
    port: 5173,
    // `/api` only. `/mcp` is deliberately not proxied: agents connect to the manager directly, and
    // a proxy hop would rewrite the Host header that the MCP transport validates.
    // The SSE endpoint needs no extra options here — there is no default proxy timeout to disable.
    proxy: { '/api': { target: API_TARGET } },
  },
});
