# Cluss

引导式 AI 解题应用。**可独立部署，也可与 ClassIntra 深度联动。**

面向学生：不直接给答案，先分层给提示、检查你的解法，让你真正想通。
面向管理员：学生线下转账后，你在后台给他开通额度，余额用完即停。

---

## 核心设计：三种运行模式

同一份代码，靠 `.env` 的 `CLUSS_MODE` 切换三种形态：

| 模式 | 用途 | 数据库 | 额度来源 |
|------|------|--------|----------|
| `standalone` | 单机独立部署（无 ClassIntra） | 自有 `cluss.db` | 本机管理员直接分配 |
| `node` | 班级节点（每班一台） | 自有 `cluss.db` | 从中继拉取，本地扣费 |
| `relay` | 中继权威节点（老师操作台） | 自有 `cluss.db` | 权威账本，管理台在此 |

### 为什么是「每班一个节点 + 一个中继权威」

现实约束：**学生只能访问本班机器**，且**充值统一由一个人管理**。这两条决定了架构：

```
                        ┌──────────────────────────────────┐
                        │   中继权威节点（relay）           │
                        │   权威额度账本 + 管理台           │
                        │   唯一充值入口                    │
                        └───────────────┬──────────────────┘
                                        │ 单向下发（出站拉取）
                  ┌─────────────────────┼─────────────────────┐
                  ▼                     ▼                     ▼
          1班 Cluss 节点         2班 Cluss 节点         3班 Cluss 节点
          本地扣费 + 本地闸门    本地扣费 + 本地闸门    本地扣费 + 本地闸门
                  │                     │                     │
                  └────── 用量汇总上报（对账用）──────────────┘
```

关键取舍：

- **扣费本地化**：学生用 AI 时不依赖网络往返，断网也能用；也避免跨实例并发扣费的分布式锁问题。
- **充值单点化**：只有中继能分配额度，天然唯一权威，不需要多写冲突消解。
- **额度是「分配」不是「共享账本」**：可用余额 = 中继下发的分配额 + 同步容错 − 本地消耗。
  余额不落库（落库必然与流水漂移），每次由流水聚合推导。
- **同步容错**：`CLUSS_SYNC_TOLERANCE_YUAN`（默认 1 元）防止「学生刚在别班充值、
  本班还没同步到」被误拒。宁可短暂放宽，也不误伤已付款的学生。

### 中继不可达时会发生什么

| 场景 | 行为 |
|------|------|
| 断网 + 学生用 AI | 正常（本地扣费不依赖网络） |
| 断网 + 管理员充值 | 管理台在中继上，此时本来也访问不到，无一致性问题 |
| 节点拉不到新额度 | 沿用上次同步的分配额 + 容错，恢复后按版本号自动对齐 |
| 节点上报失败 | 用量留在本地 `synced=0`，下个周期继续重试，不丢账 |

---

## 账号体系

### 学号规则：`YYNNCC`

| 段 | 含义 | 例（2025 年入学 · 3 班 · 第 7 个注册） |
|----|------|--------------------------------------|
| YY | 入学年份后两位 | `25` |
| NN | 班级号 | `03` |
| CC | 班内注册编号（01~99） | `07` |
| 结果 | | **`250307`** |

- 与 ClassIntra 的学号体系天然对应，联动部署时账号可直接照面，**不需要映射表**。
- 某班某届 99 个编号用尽时，自动回落到 `800001+` 保留段（注册成功提示会说明），
  `enrollment_year` 与 `class_no` 字段仍然记录真实学籍。
- 学号在注册时按「年份 + 班级」自动分配，学生不需要自己填。

### 与 ClassIntra 的关系

**账号分开存储，通过委托认证互通**——这条是刻意的设计决定：

Cluss 的注册是**开放的**（填姓名+年份+班级即可用），而 ClassIntra 的注册**必须通过预注册名单审核**。
如果两者共享同一张用户表，Cluss 的开放注册就等于给 ClassIntra 的白名单开了后门
（未经审核的账号能直接登录 ClassIntra，甚至可能绕过名单）。

所以：

```
独立部署：Cluss 完全自兜 —— 本地账号 + 本地额度，不依赖 ClassIntra
联动部署：Cluss 额外挂一条到 ClassIntra 的委托认证桥
          ClassIntra 的准入规则（pre_records）原样保留、原样生效
```

联动时的登录流程：

```
输入账号口令
  ├─ Cluss 本地命中  → 本地校验（独立部署时的主路径）
  ├─ 未命中且桥可用 → 调 ClassIntra /api/cluss-bridge/verify 校验
  │                    ├─ 成功 → 落库到 Cluss（source='classintra'，含口令哈希，支持此后离线登录）
  │                    └─ 失败 → 「账号或密码错误」
  └─ 未命中且桥不可用 → 「账号或密码错误」
```

ClassIntra 侧只需在 `app.js` 挂一行路由（见 `server/src/routes/cluss-bridge.js`），
**该文件是只读的**：只有 `ping` 与 `verify` 两个端点，不做任何写操作。

---

## 计费与额度

### 两道闸门（按顺序）

```
学生发消息
  ├─ 闸门1 余额：尚未分配额度 / 可用余额 ≤ 0 → 402「你的账号还没有开通额度…」
  ├─ 闸门2 周限额：近 7 天消耗 ≥ weekly_quota_micro → 402「本周额度已用完…」
  └─ 放行 → 流式生成 → 完成后按上游真实 usage 计费
        ├─ cluss_usage_log 落明细（余额由它聚合推导）
        └─ 剩余额度随 done 事件回传前端
```

- **免费模型**（`is_free=1`）不受两道闸门限制。
- 扣费在回答**完成之后**结算：事前扣款一旦失败就要回滚，事后结算宁可少收一次，
  也不打断正在生成的回答（末次可能略微透支，可接受）。

### 金额口径

全整数运算，单位「微元」（1 元 = 1e6 微元），与 ClassIntra 完全一致，便于对账时无需换算。

| 字段 | 单位 | 说明 |
|------|------|------|
| `price_in` / `price_out` / `price_cache_hit` | 微元 / 千 token | `1 元/百万 token = 1000` |
| `cost_micro` / `allocated_micro` | 微元 | 展示时再除以 1e6 |

**缓存命中要单独计价**：上游（如 DeepSeek）的 `prompt_tokens` 已包含命中部分，
若整段按输入价算会重复收费。命中部分按 `price_cache_hit` 算，未命中按 `price_in` 算；
未配 `price_cache_hit` 时命中部分回落按 `price_in`（不欠费也不错收）。

---

## 快速开始

### 独立部署（单机）

```bash
cd server
cp .env.example .env
# 编辑 .env：至少填 JWT_SECRET 与 ADMIN_PASSWORD
npm install
npm start            # 默认 http://localhost:9101
```

```bash
cd client
npm install
npm run build        # 产物输出到 client/dist，由服务端直接托管
```

首次启动会：

1. 自动建表（迁移 v1、v2）
2. 写入 `.env` 里配置的默认 AI 模型
3. 用 `ADMIN_USER_ID` / `ADMIN_PASSWORD` 创建管理员账号（**已存在则不覆盖密码**）

> 别忘了在管理台给模型填上 API Key，否则学生发消息会收到「AI 服务未配置完成」。

### 多班部署（1 个中继 + N 个节点）

**中继节点**（老师操作的机器）：

```ini
CLUSS_MODE=relay
PORT=9101
CLUSS_INSTANCE_ID=relay
JWT_SECRET=<32位以上随机串>
CLUSS_SHARED_SECRET=<与各节点一致>
ADMIN_PASSWORD=<管理台密码>
```

**班级节点**（每班一台）：

```ini
CLUSS_MODE=node
PORT=9101
CLUSS_INSTANCE_ID=class-01          # 每班必须唯一，用于对账区分
JWT_SECRET=<与中继一致>
CLUSS_RELAY_URL=http://<中继地址>:9101
CLUSS_SHARED_SECRET=<与中继一致>
```

节点会自动：启动立即同步一次 → 之后每 `CLUSS_SYNC_INTERVAL` 秒拉额度 →
每 `CLUSS_REPORT_INTERVAL` 秒上报用量。管理台在**中继**上，节点上不需要登录管理台。

### 与 ClassIntra 联动（可选）

**ClassIntra 侧**：`.env` 里确保配置了 `RELAY_SECRET`，然后重启：
`/api/cluss-bridge/ping` 与 `/verify` 即生效（未配密钥时返回 503，不影响现有功能）。

**Cluss 侧**：

```ini
CI_BRIDGE_URL=http://<ClassIntra 地址>:9001
CI_BRIDGE_SECRET=<与 ClassIntra 的 RELAY_SECRET 一致>
CI_JWT_SECRET=<与 ClassIntra 的 JWT_SECRET 一致>   # 填了才支持 token 互认免登
```

---

## 管理台

访问 `/#/admin`（需管理员账号登录），提供：

| 功能 | 说明 |
|------|------|
| 总览指标 | 学生数 / 已分配 / 已消耗 / 调用次数 |
| 学生额度表 | 搜索、按班级筛选、单人充值、**批量充值**（勾选多个后一次分配） |
| 班级概览 | 按班级统计人数与分配额 |
| 充值流水 | `cluss_credit_log` 全量记录，含操作人、备注、时间 |
| 台账导出 | CSV（带 BOM，Excel 直接打开不乱码） |

**充值流程**（对应你的真实收款方式）：

```
学生微信/支付宝转账给你
  → 在中继管理台找到该生（按学号或姓名搜）
  → 填额度与周限额、写备注（如「微信转账 30 元」）
  → 确认 → 中继记账 → 各节点在一个同步周期内自动生效
```

流水**只增不改**，每笔都记录 `operator_id`，可随时导出对账。

---

## 目录结构

```
Cluss/
├── server/
│   ├── src/
│   │   ├── app.js                # 入口（三模式共用）
│   │   ├── config/index.js       # 配置与启动校验
│   │   ├── middleware/           # JWT 鉴权、限流
│   │   ├── migrations/           # 数据库迁移（幂等）
│   │   ├── routes/               # auth / chat / admin / sync
│   │   ├── services/
│   │   │   ├── ai.js             # 模型解析 + OpenAI 兼容调用（含流式）
│   │   │   ├── pricing.js        # 计费（含缓存命中单独计价）
│   │   │   ├── credit.js         # 额度：闸门 / 记录 / 分配
│   │   │   ├── sync.js           # 节点↔中继同步
│   │   │   ├── ci-bridge.js      # ClassIntra 委托认证
│   │   │   └── user-id.js        # YYNNCC 学号分配
│   │   └── utils/
│   ├── scripts/
│   │   ├── mock-ai-server.js     # 端到端测试用的 mock 上游
│   │   └── reset-demo-data.js    # 清空业务数据（保留管理员与模型）
│   └── .env.example
└── client/
    └── src/
        ├── views/                # Login / Register / Chat / Admin
        ├── components/           # ClussLogo
        ├── store/                # Vuex（auth 为 namespaced 模块）
        ├── router/               # hash 路由 + 鉴权守卫
        ├── utils/                # api 封装、Markdown+KaTeX 渲染
        └── styles/global.css     # 设计系统（玻璃拟态）
```

---

## 技术栈与约定

- **服务端**：Express 4 + better-sqlite3（WAL）+ JWT + bcrypt
- **前端**：Vue 2.7 + Vue Router 3 + Vuex 3 + Vite
- **代码风格**：`var`、单引号、2 空格缩进、中文注释（与 ClassIntra 保持一致）
- **兼容基线**：Chrome 80 及以上、Android 平板、微信 X5 内核
- **无缓存策略**：所有接口与静态资源都带 `no-cache`（与项目一贯要求一致）

### 安全基线

- `JWT_SECRET` 缺失时**拒绝启动**（不留默认密钥）
- 注册/登录独立限流（注册 30/min、登录 60/min）
- 所有 `/api/admin/*` 强制 `requireAuth + requireAdmin`
- 中继同步接口用 `X-Cluss-Secret` 时序安全比较；未配置密钥时**拒绝服务**（不放行）
- ClassIntra 桥为只读，不做任何写操作
- 密码策略与 ClassIntra 一致：≥8 位且含字母与数字
- 面向用户的错误信息一律中文，系统错误码不透传

---

## 出处与致谢

本项目为原创实现。设计与实现过程中参考了同仓库体系下的 ClassIntra 项目（同一作者）
的若干工程约定，均为思路与信息结构层面的参考，未复制其代码或素材：

| 参考内容 | 来源 | 说明 |
|----------|------|------|
| 学号 `YYNNCC` 编码规则 | ClassIntra 用户体系约定 | 为便于两系统账号对应而沿用同一编码口径 |
| 计费金额单位（微元 / 千 token） | ClassIntra `migrations/013_ai_billing.js` | 沿用同一口径，便于对账时无需换算 |
| OpenAI 兼容端点归一化规则 | ClassIntra `server/src/services/ai-chat.js` | 端点补全策略（`/v1` 自动补 `/chat/completions`） |
| 路由与登录候选排序思路（学号精确匹配优先） | ClassIntra `server/src/routes/auth.js` | 应对同名多候选时的判定顺序 |
| 玻璃拟态视觉方向 | 用户提供的设计参考图 | 仅参考视觉风格取向，未复制任何素材 |

前端依赖：Vue 2.7、Vue Router、Vuex（MIT）；marked（MIT）；KaTeX（MIT）；DOMPurify（Apache-2.0）。
服务端依赖：Express、better-sqlite3、jsonwebtoken、bcryptjs、axios、compression、cookie-parser、morgan、dotenv。

---

## 已知边界

- 流式对话只做「一问一答」，不含上下文摘要压缩（长对话会接近模型上下文上限，超限由上游报错）。
- 不做视觉（图片）与联网搜索能力，这两项在 ClassIntra 的 ai-chat 中已有实现，
  若需要可后续移植。
- 节点上报的是**明细**而非聚合值，学生规模很大时中继上的 `cluss_usage_log` 会持续增长；
  建议定期归档（`created_at` 早于某时间的行）。