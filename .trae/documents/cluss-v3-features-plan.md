# Cluss v3 功能方案（深色模式 / 现拍 / 记录 / 错题本 / 作文）

## Context

v2 已把 Cluss 做成「能拍题、能批改、能按用量计费」的可用产品（后端 64 项断言全绿）。这一轮补的是**长期使用**才暴露出来的缺口：

1. **深色模式**——教室里晚上用、或者学生自己偏好深色，现在只有浅色一套
2. **现拍**——学生做题时题就在手边，让他先「存到相册 → 再回云盘选」是多余的一步
3. **记录查看**——做完一次拍题/批改，除了当前会话没有地方回看
4. **错题本**——批改出来的错题看完就没了，这是最该沉淀的学习资产
5. **作文**——目前只有解题，写作是另一个高频场景，且需要风格/类型/语言/字数这些参数

预期结果：学生能「拍下来就问 → 错题自动进本子 → 想复习时翻记录与错题本」形成闭环；作文能生成范文、能批改自己的稿子、能先要提纲。

### 已确定的决策

| 决策点 | 结论 |
|--------|------|
| 深色模式切换 | **仅手动切换**（界面里选，不读系统设置） |
| 现拍 | **调系统相机**（`<input capture>`，不依赖 HTTPS 与摄像头权限） |
| 错题来源 | **AI 自动提取 + 可手动补充** |
| 作文功能 | **生成 + 批改 + 提纲** 三种用途 |

---

## 一、深色模式

### 现状与难点

`client/src/styles/global.css` 已有 20 多个语义变量（`--bg-base`、`--glass-bg`、`--text-primary`…），
但**各组件里还散着 156 处硬编码颜色**（`rgba(31, 41, 72, 0.05)` 这类"墨色"淡填充与
`rgba(255,255,255,0.8)` 这类白色玻璃面）。只覆盖 `:root` 变量是**不够**的——
那些硬编码会让深色下出现"白色补丁"。

所以第一步不是加主题，而是**先把硬编码令牌化**。

### 令牌化方案

把散落的 `rgba(31,41,72,α)`（墨色阶）与 `rgba(255,255,255,α)`（白色面阶）归纳成两族变量：

```css
:root {
  /* 墨色阶：浅色下作为「淡填充 / 分隔线 / 描边」，深色下整体反转成白色系 */
  --ink-1: rgba(31, 41, 72, 0.04);   /* 极浅填充（表单行、代码块底） */
  --ink-2: rgba(31, 41, 72, 0.06);   /* 浅填充（分段控件轨道、徽章底） */
  --ink-3: rgba(31, 41, 72, 0.10);   /* 分隔线 / 输入框边框 */
  --ink-4: rgba(31, 41, 72, 0.16);   /* 较强描边 / 滚动条 */
  --ink-5: rgba(31, 41, 72, 0.26);   /* 滚动条 hover */

  /* 面阶：卡片内的浅色/白色表面 */
  --surface-1: rgba(255, 255, 255, 0.66);
  --surface-2: rgba(255, 255, 255, 0.80);
  --surface-3: rgba(255, 255, 255, 0.93);
}
```

深色主题只需覆盖这两族与既有的语义变量：

```css
html[data-theme="dark"] {
  --bg-base: #14161d;
  --bg-gradient: linear-gradient(135deg, #151822 0%, #1a1626 45%, #141a24 100%);
  --glass-bg: rgba(38, 42, 54, 0.68);
  --glass-bg-strong: rgba(44, 49, 62, 0.88);
  --glass-border: rgba(255, 255, 255, 0.10);
  --text-primary: #eef1f7;
  --text-secondary: #a8b0c2;
  --text-tertiary: #737d92;
  --accent: #5b9bff;          /* 深色底上要提亮，否则对比不足 */
  --accent-soft: rgba(91, 155, 255, 0.16);
  --ink-1: rgba(255, 255, 255, 0.045);
  --ink-2: rgba(255, 255, 255, 0.07);
  --ink-3: rgba(255, 255, 255, 0.11);
  --ink-4: rgba(255, 255, 255, 0.18);
  --ink-5: rgba(255, 255, 255, 0.30);
  --surface-1: rgba(255, 255, 255, 0.05);
  --surface-2: rgba(255, 255, 255, 0.08);
  --surface-3: rgba(255, 255, 255, 0.12);
  --shadow-card: 0 10px 30px rgba(0, 0, 0, 0.34);
  --shadow-inset: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
```

**深色玻璃拟态不是把浅色反相**：浅色靠「白卡 + 柔和阴影」分层，深色必须改靠
「深色卡 + 微光描边（`--glass-border` 用白 10%）」，否则卡片会糊成一片。

### 需要额外处理的几处

| 位置 | 问题 | 处理 |
|------|------|------|
| `body::before/::after` 背景光球 | 浅色的两个柔和渐变色球在深色底上会变成脏斑 | 深色下换成低透明度的高饱和光球 |
| 滚动条 | 用 `--ink-4/5` 即可 | 顺带令牌化 |
| KaTeX 公式 | 默认黑色，深色下看不见 | 给 `.katex` 设 `color: inherit`；`\color{}` 由 KaTeX 自己管 |
| 代码块 | 目前是 `pre/code` 纯样式 | 背景走 `--ink-1`，文字 `--text-primary` |
| 图片预览遮罩 | 已是固定深色，深色下反而更协调 | 不动 |
| 输入框 | 聚焦时的白底会闪 | 走 `--surface-3` |
| 主题色 meta | `<meta name="theme-color">` 是写死的浅色 | 切主题时用 JS 同步更新 |

### 切换与持久化

- `store/modules/theme.js`（新建）：`state.theme = 'light' | 'dark'`
- 初始化：读 `localStorage.cluss_theme`；无值时默认 `light`（按你的决定，不读系统设置）
- 应用：`document.documentElement.setAttribute('data-theme', theme)` + 同步 `theme-color`
- 入口：`AppNav` 用户菜单里加一项「深色模式 / 浅色模式」切换（带当前态指示）
- **防闪烁**：在 `client/index.html` 的 `<head>` 里内联一小段脚本，在 Vue 挂载前就把
  `data-theme` 设好。否则深色用户每次刷新都会先闪一下白屏

### 改动范围

`global.css`（令牌定义 + 深色覆盖 + 令牌化）、`index.html`（防闪烁脚本 + theme-color）、
`store/modules/theme.js`（新建）、`store/index.js`、`AppNav.vue`（切换入口），
以及**所有含硬编码颜色的组件**（`Chat/Study/Cloud/Usage/Admin/CloudPicker/ModelForm/
AttachmentChips/UsageChart/App/Login/Register`）——把 156 处逐一替换成令牌。

这是本轮里最"钝"但最不能省的一步：漏掉一处，深色下就是一个刺眼的白色方块。

---

## 二、现拍

### 做法

不引入 `getUserMedia`（要 HTTPS、旧内核与微信里受限、代码量大），
用系统相机：

```html
<input type="file" accept="image/*" capture="environment">
```

- 手机/平板：直接唤起后置相机，拍完回到页面
- 桌面浏览器：`capture` 被忽略，退化为普通文件选择（可接受，桌面本来也没后置相机）
- **单张限制**：多数设备带 `capture` 时只能拍一张，所以「拍照」与「从相册/云盘多选」做成两个入口

### 落点

| 位置 | 改动 |
|------|------|
| `CloudPicker.vue` | 上传行改成两个按钮：`拍照`（capture，拍完即上传并自动选中）、`上传文件`（现有，多选） |
| `Study.vue` | 图片区空态与已有图片时都提供「拍照」快捷入口，省掉「打开选择器 → 拍照」两步 |

`CloudPicker` 加一个 `enableCamera` 属性，默认 `true`。拍照流程复用现有的 `onPick` 上传逻辑，
只是 input 上多一个 `capture` 属性、且 `multiple` 关掉。

### 注意

- 拍照产生的图通常 3~8MB，**已由服务端 sharp 缩图兜住**（v2 已实现），这条链路不用改
- 上传后要自动选中该图（现在的上传逻辑已这么做），否则学生拍完还得再点一下

---

## 三、记录查看

### 现状

`Study.vue` 左侧已有历史列表（读 `/api/study/conversations`），但只显示标题，
分不清是拍题还是批改，也没有图，回看时看不到当时的题图缩略图。

### 新增：记录页 `/#/records`

顶栏导航变成 6 项：**对话 | 学习 | 作文 | 记录 | 错题本 | 云盘**
（把「消耗」收进用户菜单——它已是低频页，这样导航不会挤成 7 项）

记录页三个标签：

| 标签 | 内容 |
|------|------|
| 解题与批改 | 会话列表：类型徽章（拍题 / 批改）、题图缩略图、助手回复摘要、时间；点击进入完整回看 |
| 错题本 | 见下一节 |
| 作文记录 | 见第四节 |

### 后端：`GET /api/records`

```
GET /api/records?type=solve|grade|all&page=1&limit=20
→ {
    items: [{
      conversation_id, type,            // 从 ai_messages.source 推断
      title, created_at,
      thumb_hash,                        // 该会话第一张题图的 hash，用于列表缩略图
      image_count,
      summary                            // 助手回复的前 60 字（剥掉 Markdown 与公式）
    }],
    total, page, total_pages
  }
```

类型判定：该会话里 `ai_messages.source` 出现 `grade` 即为批改，否则为拍题。
缩略图取该会话用户消息 `attachments` 里第一个 `kind='image'` 的 hash。

放在 `routes/study.js` 里（与它同源），实现为一条 JOIN 查询，不需要新表。

### 回看

`Study.vue` 的「打开历史记录」已能还原题图与解答内容（v2 已实现），
记录页复用同一跳转（`/#/study?conversation=<id>`），学习页 `mounted` 时若有该参数就直接打开。

---

## 四、错题本

### 数据模型（迁移 009）

```sql
wrong_questions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation_id TEXT DEFAULT '',   -- 来源会话（手动录入时为空）
  image_hash TEXT DEFAULT '',        -- 来源题图，回看用
  source TEXT DEFAULT 'ai',          -- ai（批改提取）| manual（手动录入）
  subject TEXT DEFAULT '',           -- 学科
  question TEXT NOT NULL,            -- 题干
  student_answer TEXT DEFAULT '',    -- 学生当时的答案
  correct_answer TEXT DEFAULT '',    -- 正确答案 / 解法要点
  reason TEXT DEFAULT '',            -- 错因
  tag TEXT DEFAULT '✗',              -- ✗ 或 △
  mastered INTEGER DEFAULT 0,        -- 已掌握
  note TEXT DEFAULT '',              -- 学生自己的补充笔记
  created_at TEXT, updated_at TEXT
)
CREATE INDEX idx_wrong_user ON wrong_questions(user_id, created_at DESC);
CREATE INDEX idx_wrong_mastered ON wrong_questions(user_id, mastered);
```

### 错题怎么自动进来（关键设计）

不能让前端去正则解析 Markdown 表格——模型表格格式一变就抓不到，而且流式过程中表格是半截的。

**做法：让模型额外输出一段带标记的结构化数据，后端解析、前端剥离。**

在 `prompt-registry.js` 的 GRADE 提示词末尾追加：

```
批改完表格与小结后，另起一段输出错题数据，用下面这对标记包裹（不要放进代码块）：

<wrong-items>
[{"subject":"数学","question":"题干","student_answer":"学生答案","correct_answer":"正确解法要点","reason":"错因","tag":"✗"}]
</wrong-items>

要求：
- 只包含判定为 ✗ 或 △ 的题；全对时输出 <wrong-items>[]</wrong-items>
- JSON 必须合法（字符串内换行写 \n、双引号转义）
- 标记内除了 JSON 不要有任何其它文字
```

配套三处改动：

1. **后端提取**（`turn-runner.js`，`source === 'grade'` 时）：
   从模型完整回复里用 `/<wrong-items>([\s\S]*?)<\/wrong-items>/` 提取，`JSON.parse`
   容错解析，逐条写入 `wrong_questions`（带 `conversation_id` 与题图 hash）。
   **解析失败只记日志、不报错**——错题本拿不到内容也不该让批改失败。

2. **存档剥离**：写入 `ai_messages` 前去掉该标记块，避免记录页里看到一坨 JSON。

3. **前端剥离**：`utils/markdown.js` 加 `stripStructured(text)`，在渲染前**截断到
   `<wrong-items>` 之前**（用截断而不是正则删除，因为流式过程中后半个标记还没到，
   正则匹配不上会导致 JSON 短暂显示出来）。对话页与学习页的渲染都走这个函数。

4. `done` 事件带上 `wrong_added: <新入错题数>`，前端提示「已收录 N 道错题到错题本」。

### 错题本页面（`/#/wrong-book`）

| 功能 | 说明 |
|------|------|
| 列表 | 按时间倒序；显示学科、题干、错因、来源徽章（AI 提取 / 手动）、题图缩略图 |
| 筛选 | 全部 / 未掌握 / 已掌握；按学科 |
| 标记掌握 | 单条切换；支持批量 |
| 编辑 | 改题干、错因、正确答案、补充笔记（AI 提取的可能有识别误差，必须可修） |
| 手动新增 | 表单：学科 / 题干 / 我的答案 / 正确答案 / 错因 |
| 删除 | 单条与批量 |
| 导出 | CSV（含题干与错因，便于打印） |

### 后端接口

```
GET    /api/wrong-book?mastered=&subject=&page=&limit=
POST   /api/wrong-book                       # 手动新增
PUT    /api/wrong-book/:id                   # 编辑（含标记掌握）
DELETE /api/wrong-book/:id
POST   /api/wrong-book/batch                 # { ids:[], action:'master'|'unmaster'|'delete' }
GET    /api/wrong-book/subjects              # 已出现过的学科（筛选下拉）
GET    /api/wrong-book/export.csv
```

全部限本人（`user_id` 取 `req.user.user_id`，忽略客户端传参）。

---

## 五、作文

### 数据模型（迁移 010）

```sql
writing_pieces(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  conversation_id TEXT DEFAULT '',
  mode TEXT NOT NULL,                -- generate | grade | outline
  language TEXT DEFAULT 'zh',        -- zh | en
  genre TEXT DEFAULT '',             -- 记叙文/议论文/说明文/书信/议论文…
  style TEXT DEFAULT '',             -- 平实/文艺/议论性强/幽默…
  word_limit INTEGER DEFAULT 0,      -- 0 = 不限
  topic TEXT DEFAULT '',             -- 题目 / 要求
  outline TEXT DEFAULT '',           -- 提纲（mode=outline 时）
  content TEXT DEFAULT '',           -- 生成的范文，或学生原稿
  feedback TEXT DEFAULT '',          -- 批改意见
  image_hashes TEXT DEFAULT '[]',    -- 看图作文的图 / 手写稿照片
  created_at TEXT, updated_at TEXT
)
CREATE INDEX idx_writing_user ON writing_pieces(user_id, created_at DESC);
```

### 三种用途

| 用途 | 输入 | 输出 |
|------|------|------|
| **生成范文** | 题目/要求 + 风格 + 类型 + 语言 + 字数 +（可选）图片 | 完整作文 + 一句写作思路 |
| **批改润色** | 学生原稿（粘贴或拍照）+（可选）题目 | 逐段点评表 + 亮点 + 问题 + 润色建议 + 一句总评 |
| **要提纲** | 题目/要求 + 类型 + 语言 + 字数 | 结构提纲（每段要点）+ 可用素材方向 + 开头结尾思路 |

三者的参数面板共用一套控件（语言 / 类型 / 风格 / 字数），只是按钮不同。

### 提示词（`prompt-registry.js` 新增四段）

| 场景 | 关键约束 |
|------|---------|
| 生成·中文 | 严格贴合题目要求；字数误差控制在 ±10% 内并**在末尾标注实际字数**；不写"作为一个 AI"；不空洞抒情；结构完整（开头/主体/结尾） |
| 生成·英文 | 母语者水平；不用中式英语；词数达标并标注实际词数；句式有变化 |
| 批改 | 逐段点评表（段落 / 优点 / 问题 / 建议）；维度评分只给「语言/结构/内容」三档定性（优/良/待改进），**不臆造百分制分数**；润色只改典型 2~3 处并对照展示原文与改后 |
| 提纲 | 只给提纲不写全文；每段给要点与可用素材；开头结尾各给 1~2 个思路；明确"写的时候按提纲自己展开" |

英文相关的提示词要单独写（不能靠"用中文回答"那条通则覆盖），
所以 `getSystemPrompt` 需要支持 `language` 参数，并在英文模式下替换掉 BASE 里的语言约束。

### 前端页面 `/#/writing`

**横屏**：左侧参数面板 + 右侧结果区
**竖屏**：上方参数面板（可折叠）+ 下方结果区

结果区支持流式输出；生成完成后：
- 「存入记录」（写 `writing_pieces`）
- 「复制全文」
- 批改模式下显示逐段对照

记录：作文页右侧（横屏）/底部（竖屏）列出历史作文，可回看与删除。

### 后端接口

```
POST /api/writing/generate/stream   { mode, language, genre, style, word_limit, topic, image_hashes[], content? }
POST /api/writing/grade/stream      { language, topic?, content?, image_hashes[] }
POST /api/writing/outline/stream    { language, genre, word_limit, topic, image_hashes[] }
GET  /api/writing/pieces?page=&limit=
GET  /api/writing/pieces/:id
DELETE /api/writing/pieces/:id
```

三个 stream 端点都走 `turn-runner`，只是 `task.kind` 不同
（`writing_generate` / `writing_grade` / `writing_outline`）、
`source` 不同（`writing`），并额外传 `writing` 参数组。

**注意**：三个端点的 `task.kind` 都不以 `solve`/`grade` 开头，
所以要确保 turn-runner 里「必须带图」的校验**不误伤它们**——
作文的图是可选的，这点要在实现时明确区分（用 `task.requiresImage` 显式声明，而不是靠 `task.kind` 推断）。

---

## 六、实施顺序

分 4 批，每批独立可验证可提交：

| 批次 | 内容 | 产出 |
|------|------|------|
| **1. 深色模式** | 令牌化 156 处硬编码 + 深色变量覆盖 + 切换与持久化 + 防闪烁 | 两套主题都正常，无白色补丁；刷新不闪白 |
| **2. 现拍** | `CloudPicker` 加拍照入口、`Study` 加拍照快捷入口 | 手机/平板能直接唤起相机并自动选中 |
| **3. 记录 + 错题本** | 迁移 009；`/api/records`；记录页；错题提取（提示词 + 解析 + 剥离）；错题本页 | 批改完错题自动进本子，可查看与编辑 |
| **4. 作文** | 迁移 010；四段作文提示词；三个 stream 端点；作文页 | 生成/批改/提纲三种用途可用 |

---

## 七、风险与应对

| 风险 | 应对 |
|------|------|
| **令牌化漏改导致深色下出现白色补丁** | 改完用脚本扫一遍：`grep -rn "rgba(31, 41, 72\|rgba(255, 255, 255" client/src`，只允许在 `global.css` 的变量定义处出现 |
| **主题切换闪白**（刷新时先渲染浅色再切深色） | `index.html` 内联脚本，在 Vue 挂载前设好 `data-theme`；CSS 里 `html[data-theme]` 优先级高于 `:root` |
| **`capture` 在部分设备只能拍一张** | 拍照入口与多选入口分开，不混用；拍照固定单张 |
| **模型不按要求输出 `<wrong-items>`** | 三层兜底：解析失败只记日志不影响批改；前端截断保证不显示 JSON；错题本支持手动补录。另加一条：`done` 事件里若 `wrong_added===0` 且批改结果里出现了 ✗，前端提示「可手动把错题加入错题本」 |
| **流式过程中 JSON 短暂显示** | 前端**截断**而非正则删除（`<wrong-items>` 之前的内容） |
| **英文作文被"用中文回答"的通则带偏** | `getSystemPrompt` 支持 `language`，英文模式下替换掉 BASE 里的语言约束与"中文回答"规则 |
| **作文端点被"必须有图"的校验误伤** | turn-runner 用显式的 `task.requiresImage` 声明是否需要图，不再靠 `task.kind` 推断 |
| **错题本题目识别有误差** | 编辑功能是必需的，不是可选项；列表上标出来源是 AI 提取 |
| **导航变 6 项后窄屏拥挤** | 顶栏导航已有 `overflow-x: auto`；另把「消耗」收进用户菜单，避免 7 项 |
| **作文生成 token 消耗大** | 字数要求会直接放大 completion token；按现有计费链路自动记账，不做特殊处理，但在参数面板提示「篇幅越长消耗越多」 |

---

## 八、验证方式

沿用 v2 已建立的流程（`mock-ai-server.js` + `verify-*.js` 断言脚本）：

1. **扩展 mock 上游**：增加三类可识别的固定回复——
   - 收到含 `<wrong-items>` 要求的批改请求 → 回一个带 2 道错题的批改表格 + `wrong-items` JSON
   - 作文生成请求 → 回一篇固定范文（带字数标注）
   - 作文批改请求 → 回逐段点评表
2. **新增 `verify-v3.js`**，覆盖：
   - 错题提取：批改后 `wrong_questions` 表确有 2 行，且 `ai_messages.content` 里**不含** `<wrong-items>`
   - 错题本 CRUD、筛选、批量标记、导出 CSV、越权（读别人的错题返回 404/403）
   - 记录接口：类型判定正确、缩略图 hash 正确、分页正确
   - 作文三个端点各自能通，且**不带图也能用**（验证 `requiresImage` 区分生效）
   - 深色模式：无后端逻辑，靠扫描脚本 + 人工确认
3. **前端**：浏览器跑「拍照上传 → 拍题 → 批改 → 错题本出现 2 条 → 编辑错题 → 作文生成」；
   切换深色后**逐页扫一遍**（对话/学习/作文/记录/错题本/云盘/消耗/管理台八页），确认无白色补丁与文字看不清
4. **回归**：重跑 `verify-v2.js`（64 项）确认未退化
