import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __filename = fileURLToPath (import.meta.url);
const __dirname = dirname (__filename);

export default defineConfig ({
  plugins: [ vue () ],

  base: './',

  root: resolve (__dirname, 'src'),

  build: {
    rollupOptions: {
      input: {
        home: resolve (__dirname, 'src/home/index.html'),
        overlay: resolve (__dirname, 'src/overlay/index.html'),
        ball: resolve (__dirname, 'src/ball/index.html'),
      }
    },
    outDir: resolve (__dirname, 'dist'),
    emptyOutDir: true
  },

  resolve: {
    alias: {
      '@': resolve (__dirname, 'src'),
      '@assets': resolve (__dirname, 'assets'),
    }
  },

  server: {
    hmr: false
  }
});
