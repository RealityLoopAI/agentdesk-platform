import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const PUBLIC_ENV_ALLOWLIST = new Set(['VITE_WEB_PROXY_TARGET']);
const SENSITIVE_NAME = /(SECRET|TOKEN|PASSWORD|PRIVATE|APP_KEY|APP_ID)/i;

function validatePublicEnvironment(mode: string): Plugin {
  return {
    name: 'validate-public-environment',
    config() {
      const publicValues = loadEnv(mode, process.cwd(), 'VITE_');
      for (const [key, value] of Object.entries(publicValues)) {
        if (!PUBLIC_ENV_ALLOWLIST.has(key) || SENSITIVE_NAME.test(key) || /BEGIN [A-Z ]+PRIVATE KEY/.test(value)) {
          throw new Error(`Unsafe public Vite environment variable: ${key}`);
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_WEB_PROXY_TARGET || 'http://127.0.0.1:3100';
  return {
    plugins: [validatePublicEnvironment(mode), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: false },
        '/auth': { target: proxyTarget, changeOrigin: false },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      restoreMocks: true,
    },
  };
});
