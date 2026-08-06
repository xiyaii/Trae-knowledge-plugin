import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dashboard 前端构建配置
// 输出到 ../static/ 供 Go 通过 go:embed 打包进二进制
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    // 开发时代理到后端服务
    proxy: {
      '/dashboard': 'http://localhost:8080',
      '/track': 'http://localhost:8080',
    },
  },
});
