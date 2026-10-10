# 怎么验证

> 本文是 [README](../README.md) 的分册：改完怎么知道没坏。配套脚本都在 `server/scripts/`。

```bash
cd server

# 1) 起一个 mock 上游（不需要真实 API Key）
node scripts/mock-ai-server.js

# verify-v2 / verify-v3 只清理**自己造的数据**，不动真实账号。
#   它们用 net_name='v2test' / 'v3test' 标记自己的测试学生，
#   只删这些账号及其名下的会话、用量、额度、错题、作文、云盘文件；
#   模型表在跑之前自动快照、跑完自动还原（中途失败也会还原）。
#   所以可以直接在真实库上跑，不需要 --force。
#
#   （曾经不是这样：早期实现是 `DELETE FROM users WHERE is_admin = 0`，
#    在真实库上跑就删光过学生的账号 —— 包括一个用户刚注册、正要拿去试用的。
#    中途加过"库里有数据就拒绝执行"的防呆，但它拦不住使用者顺手加 --force
#    而每次跑验证都正好需要绕过它。防呆解决"误操作"，这里的问题是
#    "设计上就不该删别人的数据" —— 所以改成了按归属删除。）
#
# 仍建议先备份 database/（正确姿势见 [deploy.md](deploy.md)）。

# 1.5) 用**真实浏览器**验证「点历史能切换」（对话 / 作文 / 拍题）
#      为什么单列一项：这三个页面渲染的是**预计算好的 HTML**
#      （m.html / resultHtml / answerHtml，为了避免每次重渲染都重解析 Markdown），
#      于是存在「原文 + 它的 HTML」两份状态 —— 只要有一条路径只改原文、
#      忘了改 HTML，页面就"点了没反应"：不报错、接口正常，只看后端数据发现不了。
#      这个 bug 真实发生过（openPiece / openConversation 漏了），所以留一道永久防线。
#      零 npm 依赖（Node 22 内置 WebSocket 直连 CDP），自动塞数据并清理。
node scripts/verify-ui-history.cjs

# 1.6) 用**真实浏览器**验证渲染层（公式 + 流程图/思维导图/甘特图/时序图）
#      为什么必须真浏览器：这一层的失败模式全长在 DOM 里 —— KaTeX 生成的树、
#      DOMPurify 放不放行 SVG、mermaid 的异步渲染与主题重绘，Node 里一概断言不了。
#      探针页 client/render-probe.html 走的是**项目真实模块图**（同一份 markdown.js /
#      mermaid.js / mixin / global.css），所以它过了就等于线上过了。
#
#      它会把 prefers-reduced-motion 显式钉成 reduce。两个理由：① 无头 Chrome
#      默认就是 reduce，不钉住等于悄悄换了一条代码路径在测；② 那正是线上最危险的一条。
#        （真实事故：global.css 的 reduced-motion 块把 * 的 transition-duration
#          写成 0.01ms。非零时长让 Chrome 把每一次属性变化都当成"进行中的 transition"，
#          而 mermaid 靠"插入 DOM 后立刻同步测量"来定布局，于是读到的是起始值 ——
#          四节点流程图的 viewBox 从 250×334 变成 3184×4245，节点只剩 18px，
#          整张图等于废掉。只有开了系统"减弱动态效果"的学生会中招。）
#
#      断言除了"有 SVG / 文字在"，还盯着**画布有没有被撑大**与**主体元素的实际像素尺寸**
#      （健康值：流程图节点 240px、思维导图 147px、甘特任务条 345px、时序参与者 217px）。
#      只断言"尺寸非零"是拦不住上面那类事故的 —— 它当时是 39 项全绿。
#
#      阴性对照：探针页带 ?badcss=1 可把那条毒规则注回去，
#      实测 47 项断言里会精确红 4 项（两张图的画布尺寸 + 两个图的节点宽度）。
cd client && npm run dev
node ../.tmp-qa/verify-render.mjs
#
# 1.7) 验证**旧内核兼容性**（Chrome 80 / Android 9 / 微信 X5）
#      有两类问题只在旧内核上出现，而且**源码是对的、坏在构建产物上**，光看代码发现不了：
#        ① CSS 压缩器把 `top/right/bottom/left:0` 合并成 `inset:0`（Chrome 87+）。
#           实测踩到：图表查看器浮层 `.chart-viewer` 因此失去定位，点开图表不铺屏。
#           修法是 build.cssTarget 显式写 'chrome80' —— 写 es2015 也拦不住，
#           esbuild 把 es2015 当成"支持 ES2015 的现代浏览器集合"，照样合并。
#        ② 打包器把垫片模块当成"无副作用"摇掉（源码里明明写着，产物里没了）。
#      两条命令，都不需要真机：
node client/scripts/check-legacy-compat.cjs
#        A. 垫片功能自测：把原生 API 删掉再执行垫片源码，验 Array.at 的负索引与越界、
#           replaceAll 的 $ 占位符解释（用 split/join 实现会错在这）、Object.hasOwn 的
#           原型边界、structuredClone 的循环引用与 Map/Date、AggregateError 的 instanceof
#           （它是 mermaid 唯一的用法，不是真构造函数就恒为 false）；并断言
#           "原生都在时垫片是空操作"，挡住忘写特性探测。
#        B. 源码接线：main.js 的第一条 import 必须是垫片。
#        C. 产物扫描：dist 的 CSS 里不许有 inset 简写；入口包里五个垫片必须在；
#           并清点剩余的新 API（预期只剩懒加载的 mermaid 分片，运行时由全局垫片覆盖）。
node .tmp-qa/verify-legacy.mjs
#        在真浏览器里用 Page.addScriptToEvaluateOnNewDocument **把原生 API 删掉**，
#        模拟 Chrome 80 的缺失环境，再跑五类图表（流程图/思维导图/甘特图/时序图/饼图）。
#        这一步不能省：本地 Chrome 天生带着这些 API，不主动删就永远测不到那条路径。
#        区分度靠一条断言 —— Array.prototype.at 必须存在（否则垫片没装）且**不是
#        native code**（否则说明删除没生效、测的还是原生实现）。少了后半句，
#        这个测试就是"全绿但其实什么都没验"。
#        还多一层**承重证明**：给垫片挂计数器后渲染图表，实测 Object.hasOwn 被调用
#        十万次量级、Array.at 8 次、structuredClone 2 次 —— 没垫片时旧内核第一次调用就抛。
#    若 Vite 只监听了 [::1]（curl 127.0.0.1:9102 连不上），改用 localhost：
#    PROBE_URL=http://localhost:9102/render-probe.html node ../.tmp-qa/verify-render.mjs
#    截图落在 .tmp-qa/shots-render/
#    纯 Node 的公式解析回归（不起浏览器，秒级）：
node ../.tmp-qa/test-markdown.mjs

# 2) 一键跑端到端断言（可重复运行，只清理自己造的测试数据）
#    覆盖：注册/闸门/充值/扣费、云盘上传与安全边界、视觉 native 与 relay 双路径、
#          拍题三模式与批改、**错题自动收录与存档剥离**、用量统计（学生端口径裁剪）、
#          模型管理、越权与非法入参、**画像/余额/时间是否真的进了提示词**
node scripts/verify-v2.js

# 3) 验证两套「展示层」没被改坏
node scripts/verify-points.cjs    # 积分换算 / 学生端不含元 / 管理端保留元 / 闸门文案
node scripts/verify-profile.cjs   # 学生画像 / 上下文截断说明 / 画像注入不破坏缓存前缀

# 3.5) 积分策略计费（纯函数级，不需要起服务）
#      覆盖：缓存拆分回归、限免生效/到期自动恢复、倍率万分比换算、
#            峰谷跨午夜与边界（右开区间）、倍率×折扣叠加、限免优先于一切
node scripts/verify-pricing.cjs

# 4) 准备一个可直接点开就用的演示环境（清数据 + 配模型 + 建已充值学生 + 传一张题图）
node scripts/prepare-demo.js
#    之后用 250301 / test1234（学生）或 999999 / admin12345（管理员）登录
```

mock 上游会按请求内容回不同答案（收到图 → 回「已收到图片」；system 含「批改」→ 回批改表格；
system 含「转述器」→ 回题目转述），所以能断言「模型到底收到了什么」，
而不是只看「有没有返回 200」。

mock 还提供 `GET /__last` 回放**最近一次**收到的完整请求。提示词类改动只能这样验——
比如「学生画像有没有注入」「批改产生错题后画像缓存有没有立刻刷新」，
光看接口返回 200 是看不出来的。

几条值得留意的断言（都是曾经"看起来在跑、其实没验"的地方）：

- **错题收录**：批改后错题本新增 2 条、带学科/判定/错因/来源会话/题图，
  且**存档正文里已剥离 `<wrong-items>`**——学生回看历史不该看到那坨 JSON。
  （注意：流式 delta 里保留原始标记是**符合设计**的，块还没传完，
  服务端无法中途判断边界；露不露给学生由渲染层 `stripStructured` 负责。）
- **学生端口径**：`done` 事件与用量接口里不能出现任何金额字段（元/微元），
  且不能出现 token 等技术字段。
- **画像刷新**：批改出错题后，下一条消息的 system prompt 里必须已经带上该学科——
  画像有 60s 缓存，漏调 `invalidate` 会滞后一分钟，人工试用几乎发现不了。

几个容易忽略但已覆盖的断言：

- **数据库里绝不能有 base64**：`LENGTH(attachments)` 与 `LENGTH(content)` 都被断言在阈值内
- **转述与主回答共享同一 `trace_id`**，且转述记的是转述模型（不是主模型）
- **伪装成图片的 HTML 被拒**、越权读别人的 hash 被拒、拍题不带图被拒
- **学生访问管理接口返回 403**
