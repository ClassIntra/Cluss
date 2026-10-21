import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';
import path from 'path';

// 构建目标对齐 ClassIntra 的兼容基线：
// Chrome 80 / Android 9 平板 / 微信 X5 内核都能跑，所以不做过于激进的语法降级
export default defineConfig({
  plugins: [vue()],
  // 资源全部走相对路径，让**同一份构建产物**既能挂在域根（http://<host>:9003/），
  // 也能被 ClassIntra 的 HTTPS 站点以 /cluss/ 反代挂载。
  // 若写死 '/'，反代到子路径时 index.html 会去要 /assets/... —— 那是宿主
  // （ClassIntra）自己的资源路径，Cluss 的 js/css 全部 404，页面白屏。
  // 代价：深路径下的相对解析会变，而 Cluss 用 hash 路由（路径恒定），不受影响。
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // 前后端共用的常量（学生偏好档位）放在项目根的 shared/ 下。
      // 前端从这里读、服务端 prompt-registry 也 require 同一份文件 ——
      // 一份真源，避免"改了一端忘了另一端"的漂移。
      '@shared': path.resolve(__dirname, '..', 'shared')
    }
  },
  // 统一按设备基线降级，避免出现"打包后能用、开发时不能用"（或反过来）这种
  // 只有真机能暴露的差别。设备基线：Chrome 80 / Android 9 / 微信 X5。
  esbuild: {
    target: 'chrome80'
  },
  // 预打包的依赖同样按 chrome80 降级：Vite 的依赖优化器默认目标是更新的语法，
  // 不改这里的话，依赖里带的新语法会在旧内核上解析失败（白屏，且控制台只报语法错）。
  optimizeDeps: {
    esbuildOptions: {
      target: 'chrome80'
    }
  },
  server: {
    // 监听全部网卡，内网其它设备（平板 / 手机 / 另一台电脑）才能用本机 IP 直接打开。
    // 为什么不能省：Vite 默认 host 是 `localhost`，在本机解析到的是 `::1`（IPv6 回环），
    // 于是连 `127.0.0.1` 都连不上，更别说内网 IP —— 表现是"服务起来了但别人打不开"。
    // 只想留本机看：`VITE_DEV_HOST=localhost npm run dev`。
    host: process.env.VITE_DEV_HOST || true,
    // 开发服务器自身端口。必须与服务端端口（server/src/config 的默认 9003）区分开，
    // 两者共用同一个 PORT 环境变量，这里写死避免误读成服务端端口。
    port: 9102,
    // 端口被占时**直接失败**而不是悄悄换到 9103：一旦漂移，内网那台设备
    // 按约定 IP:9102 访问就会连不上，而错误只出现在没人看的那台机器上。
    strictPort: true,
    // 开发服务器默认只允许读工作区（client/）内的文件；@shared 指向上一层的
    // shared/，这里显式放行，否则 dev 下会报"文件不在允许目录内"。
    // （只影响 dev；构建时由 rollup 解析，不受此限）
    fs: {
      allow: [path.resolve(__dirname), path.resolve(__dirname, '..', 'shared')]
    },
    // 开发期一律不做强缓存。Vite 默认会给预打包依赖（/node_modules/.vite/deps/*）
    // 发 `max-age=31536000, immutable`，于是平板那边会攥着旧依赖不放 ——
    // 改了依赖版本或配置后，设备上跑的还是老代码，且现象是"我明明改好了它没变"。
    // no-store 是最强的一档：连再验证都省掉，任何一次加载都拿新的。
    // 代价是每次刷新都要重下依赖（本机走回环无感；内网设备会稍慢），
    // 调试期要"肯定是新的"比省这点流量重要。
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    },
    proxy: {
      '/api': {
        // 服务端默认端口已统一为 9003（见 server/src/config/index.js 与 server/.env）
        target: 'http://127.0.0.1:9003',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 关闭 sourcemap 减小产物体积（低端设备上加载更快）
    sourcemap: false,
    // 语法降级到 ES2015。注意 esbuild 只降级**语法**，不补运行时 API ——
    // 缺的那几个由 src/legacy/polyfills.js 补齐（见该文件说明）。
    target: 'es2015',
    // CSS 也按 Chrome 80 定目标，且**必须显式写**。
    // 不写或写 es2015 时，压缩器会把 `top:0;right:0;bottom:0;left:0` 合并成
    // `inset:0` —— 那是 Chrome 87 的属性，Chrome 80 整条忽略。
    // 实测踩到：图表查看器浮层 `.chart-viewer` 因此失去定位，点开图表不铺屏。
    // 写 chrome80 后 esbuild 才肯保留四条属性（实测确认）。
    cssTarget: 'chrome80'
  },
});