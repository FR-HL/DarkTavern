import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __filename = fileURLToPath (import.meta.url);
const __dirname = dirname (__filename);

export default defineConfig ({
  plugins: [ vue () ],

  root: resolve (__dirname, 'ui/home'),
  base: './',

  resolve: {
    alias: {
      '@': resolve (__dirname, 'ui'),
      '@assets': resolve (__dirname, 'assets'),
    }
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true
  },

  server: {
    hmr: false
  }
});
