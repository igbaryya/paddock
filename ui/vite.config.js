/**
 * Dev-server configuration for the dashboard. The only thing that has to be configured is the
 * proxy: in production the manager serves ui/dist itself, so the browser talks to one origin, and
 * this makes :5173 behave the same way during development.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { PORT } from '../config.js';

// The manager's own configuration rather than a second copy of it: the port moves with
// PADDOCK_PORT or a .env, and a proxy pinned to the default would then point at nothing.
// `127.0.0.1`, never `localhost`: the manager binds loopback IPv4 by default while `localhost` can
// resolve to `::1` only, and the proxy hop would then fail to connect.
const API_TARGET = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `/api` only. `/mcp` is deliberately not proxied: agents connect to the manager directly, and
    // a proxy hop would rewrite the Host header that the MCP transport validates.
    // The SSE endpoint needs no extra options here — there is no default proxy timeout to disable.
    proxy: { '/api': { target: API_TARGET } },
  },
});
