import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5050,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3000',
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
