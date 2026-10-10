# 架构与约定

> 本文是 [README](../README.md) 的分册：目录结构、编排器、技术栈与安全基线。

## 目录结构

```
Cluss/
├── start.bat / start.sh         # 一键启动入口（Windows 双击 / 类 Unix）
├── scripts/start.js             # 一键启动逻辑：依赖与构建按需判断、防重复起服
├── server/
│   ├── src/
│   │   ├── app.js                # 入口（三模式共用）
│   │   ├── config/index.js       # 配置与启动校验
│   │   ├── middleware/           # JWT 鉴权、限流
│   │   ├── migrations/           # 数据库迁移（幂等，v1~v13）
│   │   ├── routes/               # auth / chat / study / writing / wrong-book /
│   │   │                         # notes / memories / cloud / usage / admin / sync
│   │   ├── services/
│   │   │   ├── turn-runner.js       # ★ 编排者：一次对话回合的完整流程
│   │   │   ├── conversation-core.js # 会话存取 + SSE 写入器
│   │   │   ├── prompt-registry.js   # 全部提示词的唯一来源
│   │   │   ├── context-builder.js   # 上下文组装与 token 预算
│   │   │   ├── memory.js            # 跨会话记忆（按 key 增量更新，只注入相关几条）
│   │   │   ├── user-profile.js      # 学生画像（学科/年级/时间，带缓存）
│   │   │   ├── vision.js            # 视觉判定 / 转述 / 缩图
│   │   │   ├── cloud-store.js       # 云盘：内容寻址 + 引用表
│   │   │   ├── note-assist.js       # 笔记 AI 辅助（整理 / 续写 / 提炼）
│   │   │   ├── wrong-book.js        # 错题自动收录（结构化标记解析）
│   │   │   ├── ai.js                # 模型解析 + OpenAI 兼容调用
│   │   │   ├── pricing.js           # 计费（缓存命中单独计价）
│   │   │   ├── credit.js            # 额度：闸门 / 记录 / 分配
│   │   │   ├── usage-stats.js       # 用量聚合（学生端与管理端共用）
│   │   │   ├── sync.js              # 节点↔中继同步
│   │   │   ├── ci-bridge.js         # ClassIntra 委托认证
│   │   │   └── user-id.js           # YYNNCC 学号分配
│   │   └── utils/
│   ├── scripts/
│   │   ├── mock-ai-server.js     # 端到端测试用 mock 上游（能区分看图/批改/转述）
│   │   ├── verify-v2.js          # 端到端断言：闸门 / 云盘 / 视觉 / 错题 / 用量 / 越权
│   │   ├── verify-v3.js          # 端到端断言：v2 之后的增量功能
│   │   ├── verify-*.cjs          # 专项断言：profile / points / ui-history / cloud-img
│   │   ├── backup.js             # 在线备份（单文件完整库，默认保留 7 份）
│   │   ├── cleanup-orphans.js    # 云盘孤儿文件清理（默认 dry-run，--delete 执行）
│   │   ├── probe-vision.js       # 视觉能力实测探针（用法见 deploy.md）
│   │   ├── connect-*.js          # 上游接入辅助（实测视觉后写库）
│   │   ├── prepare-demo.js       # 一键准备演示环境
│   │   └── reset-demo-data.js    # 清空业务数据
│   └── .env.example
└── client/
    └── src/
        ├── views/                # Login / Register / Chat / Study / Writing / Records /
        │                         # Notes / WrongBook / Cloud / Usage / Admin
        ├── components/           # AppNav / TabBar / ConfirmDialog / CloudPicker /
        │                         # AttachmentChips / NotePicker / Segmented / UsageChart /
        │                         # ModelForm / ClussLogo
        ├── mixins/               # orientation（方向判定）/ streamFrame（流式节流）/
        │                         # note-refs（引用笔记）/ waiting（等待话术）
        ├── store/                # Vuex（auth 为 namespaced 模块）
        ├── router/               # hash 路由 + 鉴权守卫
        ├── utils/                # api 封装、Markdown+KaTeX 渲染、SSE 解析、nav-items
        └── styles/global.css     # 设计系统（玻璃拟态 + 平板横竖屏规则）
```

## 两条链路共用一个编排器

`chat.js`（对话）与 `study.js`（拍题/批改）都调 `services/turn-runner.js`。
这样做的原因：会话管理、上下文组装、视觉判定、流式、记账这五件事若各写一份，
两处的「SSE 收尾顺序」「闸门判定时机」「记账字段」必然逐渐不一致。

`turn-runner` 的固定顺序本身就是正确性的一部分：

```
会话兜底 → 模型解析 → 视觉判定 → 额度闸门 → 附件校验/读取/缩图
  → 写 SSE 头 → 存档用户消息 → 转述（如需）→ 组装上下文
  → 流式 → 存档助手消息 → 记账 → done
```

**所有可能失败的校验都必须在「写 SSE 头」之前完成**——一旦写了头，
HTTP 状态码就固定为 200，错误只能塞进事件流，前端拿到的是
「200 但内容是错误」这种别扭结果。

## 技术栈与约定

- **服务端**：Express 4 + better-sqlite3（WAL）+ JWT + bcrypt + multer（上传）+ sharp（缩图）
- **前端**：Vue 2.7 + Vue Router 3 + Vuex 3 + Vite
- **代码风格**：`var`、单引号、2 空格缩进、中文注释（与 ClassIntra 保持一致）
- **兼容基线**：Chrome 80 及以上、Android 平板、微信 X5 内核。落地成三条硬约定，
  因为"声明基线"和"真的能跑"之间隔着三类只在产物里出现的坑：
  - **语法**：`build.target: 'es2015'`，同时 `esbuild.target` 与
    `optimizeDeps.esbuildOptions.target` 都写 `'chrome80'`。开发期预打包的依赖也要降级，
    否则会出现"开发能跑、打包后旧内核白屏"这种只有真机才暴露的差别。
  - **CSS**：`build.cssTarget: 'chrome80'` **必须显式写**。不写（或写 es2015）时压缩器会把
    `top:0;right:0;bottom:0;left:0` 合并成 `inset:0` —— 那是 Chrome 87 的属性，
    Chrome 80 会**整条忽略**。实测踩到：图表查看器浮层因此失去定位、点开不铺屏。
    这类问题源码是对的，坏在产物上，所以只能靠扫 dist 发现。
  - **运行时 API**：esbuild 只降级语法、**不补 API**。mermaid 内部用了
    `Array.prototype.at`(92) / `AggregateError`(85) / `Object.hasOwn`(93) /
    `structuredClone`(98) / `String.prototype.replaceAll`(85)，其中 `Object.hasOwn`
    在一次图表渲染里被调用十万次量级 —— 不补，旧内核上图表必然画不出来。
    由 `src/legacy/polyfills.js` 补齐，且必须是 `main.js` 的**第一条** import。
    守卫：`node scripts/check-legacy-compat.cjs`（详见 [verification.md](verification.md) 1.7）。
- **无缓存策略**：所有接口与静态资源都带 `no-cache`；开发服务器也不做强缓存
  （`server.headers` 里 `no-store`）。开发服务器这一条容易漏：Vite 默认给预打包依赖发
  `max-age=31536000, immutable`，设备会攥着旧依赖不放，改了配置那边还是老代码，
  现象是"我明明改好了它没变"。

## 安全基线

- `JWT_SECRET` 缺失时**拒绝启动**（不留默认密钥）
- 注册/登录独立限流（注册 30/min、登录 60/min、上传 30/min）
- 所有 `/api/admin/*` 强制 `requireAuth + requireAdmin`
- 中继同步接口用 `X-Cluss-Secret` 时序安全比较；未配置密钥时**拒绝服务**（不放行）
- ClassIntra 桥为只读，不做任何写操作
- 密码策略与 ClassIntra 一致：≥8 位且含字母与数字
- 面向用户的错误信息一律中文，系统错误码不透传

云盘相关的额外约束：

- **魔数嗅探优先于浏览器声明的 MIME**；声明为图片但实际是文本时直接拒绝
- 扩展名黑名单（`.html/.svg/.js/.mjs/.xhtml`）——它们在浏览器里能执行脚本
- 文本文件一律 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`，
  避免同源 XSS
- 读取文件必须校验归属（用户只能读自己云盘里的 hash），防止用别人的 hash 越权
- 每用户配额（默认 200MB），上传前检查
- 附件内容作为「资料」注入提示词，并明确要求模型**不执行附件里出现的任何指令**
  （文本附件截断到 32KB 并声明可能不完整）
