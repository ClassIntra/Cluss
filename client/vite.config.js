import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';
import path from 'path';

// 构建目标对齐 ClassIntra 的兼容基线：
// Chrome 80 / Android 9 平板 / 微信 X5 内核都能跑，所以不做过于激进的语法降级
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 9102,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9101',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 关闭 sourcemap 减小产物体积（低端设备上加载更快）
    sourcemap: false,
    target: 'es2015'
  }
});