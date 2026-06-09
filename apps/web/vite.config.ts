import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3583';
const portlessUrl = process.env.VITE_PORTLESS_URL ?? 'https://deputies.localhost';
const allowedHosts = process.env.VITE_DEV_ALLOWED_HOSTS
  ? process.env.VITE_DEV_ALLOWED_HOSTS.split(',')
      .map((host) => host.trim())
      .filter(Boolean)
  : ['.localhost', '.ngrok-free.app', '.ngrok-free.dev', '.ngrok.io'];
const apiProxy = { target: apiProxyTarget };
const serviceProxy = {
  target: apiProxyTarget,
  ws: true,
  xfwd: true,
  bypass(request: {
    headers: {
      host?: string | undefined;
      'x-forwarded-host'?: string | string[] | undefined;
      'x-original-host'?: string | string[] | undefined;
    };
    url?: string | undefined;
  }) {
    return isServiceRequest(request.headers) ? undefined : request.url;
  },
};

function isServiceRequest(headers: {
  host?: string | undefined;
  'x-forwarded-host'?: string | string[] | undefined;
  'x-original-host'?: string | string[] | undefined;
}): boolean {
  return [headers.host, headers['x-forwarded-host'], headers['x-original-host']]
    .flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
    .some((host) => host.split(',').some((item) => item.trim().startsWith('s-')));
}

export default defineConfig({
  plugins: [react(), tailwindcss(), portlessUrlPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    hmr: { path: '/__deputies_vite_hmr' },
    allowedHosts,
    proxy: {
      '/health': apiProxy,
      '/auth': apiProxy,
      '/automations': apiProxy,
      '/sessions': apiProxy,
      '/events': apiProxy,
      '/groups': apiProxy,
      '/repositories': apiProxy,
      '/models': apiProxy,
      '/setup': apiProxy,
      '/users': apiProxy,
      '/webhooks': apiProxy,
      '/': serviceProxy,
    },
  },
});

function portlessUrlPlugin(): Plugin {
  return {
    name: 'deputies-portless-url',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        server.config.logger.info(`  Portless: ${portlessUrl}`);
      });
    },
  };
}
