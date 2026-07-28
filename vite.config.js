import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = new URL('.', import.meta.url).pathname;

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: `${root}index.html`,
        mobile: `${root}m/index.html`  // 移动版入口 → dist/m/index.html
      }
    }
  },
  server: {
    port: 5050,
    proxy: {
      '/api': {
        target: 'http://localhost:3928',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3928',
        changeOrigin: true,
        ws: true
      }
    },
    watch: {
      // 忽略这些目录的文件变化，避免触发页面刷新
      ignored: ['**/server/db/**', '**/.claude/**', '**/node_modules/**']
    }
  }
});
