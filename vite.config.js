import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const root = new URL('.', import.meta.url).pathname;

// 构建时写进前端的版本号：页面与服务端版本不一致时提示刷新（见 ServerStaleBanner）
const APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
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
