import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __filename = fileURLToPath (import.meta.url);
const __dirname = dirname (__filename);

export default defineConfig ({
  plugins: [ vue () ],

  // Load files relative to index.html instead of relative to the local filesystem
  base: './',

  root: resolve (__dirname, 'ui/overlay'),

  build: {
    rollupOptions: {
      input: {
        overlay: resolve (__dirname, 'ui/overlay/index.html')
      }
    },
    outDir: 'dist',
    emptyOutDir: true 
  },

  resolve: {
    alias: {
      '@': resolve (__dirname, 'ui'),
      '@assets': resolve (__dirname, 'assets'),
    }
  },

  server: {
    hmr: false
  }
});