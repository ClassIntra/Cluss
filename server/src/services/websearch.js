// 联网搜索（web search）
//
// 定位：给「AI 能真的去查一下」这件事提供一个**可控、可关、可配**的通道。
//
// 为什么要做成服务而不是在 turn-runner 里直接发请求：
//   1. 配置要能被管理员在管理台改（provider / key / 条数 / 超时），
//      而配置的读写必须和计费、模型配置一样有唯一入口；
//   2. 同一句话在一轮里可能被搜两次（模型重试、多轮工具调用），
//      缓存能省下真金白银的 API 调用；
//   3. 上游出错时的错因要能翻译成"人话"，而不是把 HTTP 401 丢给学生。
//
// 「搜得准」不靠调大条数，靠四层收口（2026-10-20 加强）：
//   ① 检索词：允许模型一次给 1~2 条不同角度的 query（官方口径 / 通俗说法），
//      并发拿到后再合并 —— 单条口语化 query 是"搜不准"的第一大来源；
//   ② 时效：天气/股价/比分这类强时效问题自动切 news 通道（Tavily topic / 博查 freshness），
//      否则会拿三个月前的页面回答"今天"；
//   ③ 重排：关键词命中率 + 域名可信度 + 发布时间 三项加权排序，并丢掉完全不相关的噪声；
//   ④ 呈现：每条结果标出「来源类型 · 域名 · 时间」，模型才知道该信谁、该怎么引用。
//
// 配置优先级：cluss_meta（管理台写入） > .env（部署默认值）。
// 为什么不只读 .env：老师换一家搜索服务不该需要登录服务器改文件；
// 为什么还要 .env：首次部署、容器重建、以及"管理台还没人登过"的空窗期，
// 需要一个不用点界面就能起来的口子。

var axios = require('axios');
var db = require('../utils/db');
var nodeUrl = require('url');

// 支持的搜索服务。加新家只要在这里补一条 + 下面的 callProvider 分支。
//
// 为什么先是这两家：Tavily 的中文召回可用且单价低（本机实测 1~2 秒返回），
// 博查是国内合规的商业搜索接口，学校网络访问更稳。两家都不需要额外自建服务。
var PROVIDERS = {
  tavily: {
    id: 'tavily',
    label: 'Tavily',
    endpoint: 'https://api.tavily.com/search',
    doc: 'https://tavily.com'
  },
  bocha: {
    id: 'bocha',
    label: '博查 Bocha',
    endpoint: 'https://api.bochaai.com/v1/web-search',
    doc: 'https://bochaai.com'
  }
};

var DEFAULTS = {
  maxResults: 5,
  timeoutMs: 12000,
  depth: 'basic'
};

// 一次工具调用最多并行几条 query。
// 为什么是 2 而不是 5：每多一条就是一次真金白银的上游调用 + 一份要消化的正文；
// 实测 2 条（一条主检索 + 一条官方口径）已经把"搜不到"的占比压下去了，
// 再往上加主要是增加延迟和费用，不是增加准确率。
var MAX_QUERIES_PER_CALL = 2;

// 缓存：同一轮里重复查询、以及"学生连着问同一件事"都会被挡在这里。
// 为什么用内存而不是落库：搜索结果的有效期以分钟计，落库反而要处理过期清理。
// 进程重启后缓存空掉是可接受的（第一次慢一点，不会错）。
var CACHE_MAX = 200;
var cache = new Map();

// 最近一次失败：管理台的"测试"按钮之外，老师在课堂上更常问的是
// "它到底还活着吗"，所以把最近一次错误留在内存里给 GET /admin/search 透出。
var lastError = '';
var lastErrorAt = '';

function metaGet(key) {
  try {
    var row = db.prepare('SELECT value FROM cluss_meta WHERE key = ?').get(key);
    return row ? String(row.value) : null;
  } catch (e) {
    // 表还没建（极早期的库）也不该把整个搜索链路打挂
    return null;
  }
}

function metaSet(patch) {
  var stmt = db.prepare(
    'INSERT INTO cluss_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  var tx = db.transaction(function() {
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) stmt.run(keys[i], patch[keys[i]]);
  });
  tx();
}

function envStr(name) {
  return String(process.env[name] || '').trim();
}

function clampInt(v, min, max, fallback) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// 脱敏：只露头尾，够老师确认"是我那把 Key"就行，泄露了也没用
function maskKey(key) {
  var k = String(key || '');
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 2) + '••••';
  return k.slice(0, 6) + '••••' + k.slice(-4);
}

function getSearchConfig() {
  var rawEnabled = metaGet('search_enabled');
  var provider = (metaGet('search_provider') || envStr('SEARCH_PROVIDER') || 'tavily').toLowerCase();
  var apiKey = metaGet('search_api_key');
  if (apiKey === null || apiKey === '') apiKey = envStr('SEARCH_API_KEY');

  // enabled 的判定顺序：管理台显式设过就用它；否则看 .env；都没有则**关闭**。
  // 刻意不默认开启：没配 Key 就开着，学生每问一句都会走一次注定失败的请求，
  // 表现为"AI 慢半拍"，比直接没有联网更糟。
  var enabled;
  if (rawEnabled !== null) {
    enabled = rawEnabled === '1';
  } else {
    var envEnabled = envStr('SEARCH_ENABLED');
    enabled = envEnabled === '1' || envEnabled === 'true';
  }

  var maxResults = clampInt(
    metaGet('search_max_results') || envStr('SEARCH_MAX_RESULTS'),
    1, 10, DEFAULTS.maxResults
  );
  var timeoutMs = clampInt(
    metaGet('search_timeout_ms') || envStr('SEARCH_TIMEOUT_MS'),
    3000, 30000, DEFAULTS.timeoutMs
  );
  var depth = (metaGet('search_depth') || envStr('SEARCH_DEPTH') || DEFAULTS.depth).toLowerCase();
  if (depth !== 'basic' && depth !== 'advanced') depth = DEFAULTS.depth;
  if (!PROVIDERS[provider]) provider = 'tavily';

  return {
    enabled: enabled,
    provider: provider,
    apiKey: apiKey || '',
    maxResults: maxResults,
    timeoutMs: timeoutMs,
    depth: depth
  };
}

function saveSearchConfig(patch) {
  var out = {};
  if (patch.enabled !== undefined) out.search_enabled = patch.enabled ? '1' : '0';
  if (patch.provider !== undefined) {
    var p = String(patch.provider || '').toLowerCase();
    if (!PROVIDERS[p]) {
      var err = new Error('不支持的搜索服务：' + patch.provider);
      err.status = 400;
      throw err;
    }
    out.search_provider = p;
  }
  // 空字符串表示"清空 Key"；undefined 表示"别动它"
  if (patch.api_key !== undefined) out.search_api_key = String(patch.api_key || '').trim();
  if (patch.max_results !== undefined) {
    out.search_max_results = String(clampInt(patch.max_results, 1, 10, DEFAULTS.maxResults));
  }
  if (patch.timeout_ms !== undefined) {
    out.search_timeout_ms = String(clampInt(patch.timeout_ms, 3000, 30000, DEFAULTS.timeoutMs));
  }
  if (patch.depth !== undefined) {
    var d = String(patch.depth || '').toLowerCase();
    out.search_depth = (d === 'advanced') ? 'advanced' : 'basic';
  }
  if (Object.keys(out).length) metaSet(out);
  // 换服务/换 Key 之后旧缓存可能来自另一家，留着会误导
  clearCache();
  return getSearchConfig();
}

// 「现在能不能真的搜」——工具定义要不要下发给模型，就看它
function isReady() {
  var cfg = getSearchConfig();
  return !!(cfg.enabled && cfg.apiKey && PROVIDERS[cfg.provider]);
}

function clearCache() {
  cache.clear();
}

function cacheGet(key) {
  var hit = cache.get(key);
  if (!hit) return null;
  if (hit.expire < Date.now()) { cache.delete(key); return null; }
  // Map 的插入顺序即 LRU 顺序：命中后挪到队尾
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX) {
    var oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { value: value, expire: Date.now() + ttlMs });
}

// ---------------------------------------------------------------------------
// 结果加工：去噪、去重、打分、排序
// ---------------------------------------------------------------------------

// 把各家返回的字段差异收敛成同一种形状。
// snippet 留长一点（Tavily 的 content 常有几百字、advanced 更长），模型才有东西可引用；
// 但也不能无限长 —— 5 条 × 上千字会把上下文预算挤爆，反而挤掉对话历史。
var SNIPPET_MAX = 600;

// 标题尾部的站点后缀（"-资讯"、"| 教育服务"、"_新闻频道_央视网"）对模型没用，
// 但删错了会把"北京-天津"这种正常标题切坏，所以只在尾段含站点词时才删。
var SITE_TAIL_RE = /\s*[-_|｜]\s*([^-_|｜]{2,16})$/;
var SITE_WORD_RE = /(网|频道|资讯|新闻|官方|门户|首页|网站|官网|博客|论坛|百科|社区|平台|客户端|APP)/i;

function cleanTitle(t) {
  var s = String(t || '').trim();
  for (var i = 0; i < 2; i++) {
    s = s.replace(SITE_TAIL_RE, function(m, tail) {
      return SITE_WORD_RE.test(tail) ? '' : m;
    }).trim();
  }
  return s.slice(0, 160);
}

// 页面模板噪声。搜索引擎返回的 content 常把导航、版权、推荐位一起抓进来，
// 不洗的话模型会把"关于我们 联系我们 版权声明"当成正文，甚至据此作答。
var BOILER_RE = /(版权所有|联系我们|用户反馈|版权声明|网站律师|营销中心|商务合作|广告服务|媒资合作|客服电话|客服邮箱|京ICP|京公网|增值电信|营业执照|分享到|加载全文|加载更多|点击查看|扫码|关注我们|推荐阅读|相关链接|上一篇|下一篇|责任编辑|编辑：|原标题：|未经授权|转载请注明|网站地图|隐私政策|服务条款|违法和不良信息)/;

// 一句话值不值得给模型看：命中检索词 + 长度像正文 - 模板味
//
// 关键细节：搜索引擎把 HTML 的块级元素压成**空格**，所以很多页面抓回来整页
// 没有一个中文句号（实测"受冷空气影响…"那条就是），只按标点切会切出 500 字的"一句"，
// 清洗等于没做。这里对超长片段再按 `#`（markdown 标题残留）、连续空格、竖线切一刀。
function splitSentences(text) {
  var cleaned = String(text || '').replace(/\[\.{3}\]|\[…\]|［\.{3}］/g, ' ');
  var byPunc = cleaned.split(/[\n。！？!?；;]+/);
  var out = [];
  for (var i = 0; i < byPunc.length; i++) {
    var seg = byPunc[i];
    if (seg.length <= 120) { out.push(seg); continue; }
    var chunks = seg.split(/\s*#{1,6}\s*|\s{2,}|\s*[|｜]\s*/);
    for (var j = 0; j < chunks.length; j++) out.push(chunks[j]);
  }
  return out;
}

// 纯日期/纯数字/纯英文导航（"2026-09-30 07:03:42"、"首页"）——没有回答价值
function isNoiseLine(s) {
  if (!s) return true;
  if (/^[\d\s\-:/.年月日]+$/.test(s)) return true;
  if (/^[A-Za-z\s:.,-]+$/.test(s) && s.length < 24) return true;
  return false;
}

// 摘要清洗：从整页正文里挑出与问题最相关的几句话。
// 为什么必须做：Tavily 的 content 是整段抓取，实测天气页的摘要里 70% 是
// "分享到/推荐阅读/关于我们"，模型读到的有效信息被稀释，还会把导航词当事实。
function condenseSnippet(text, tokens) {
  var raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  // 本来就短、又没有模板味：原样返回，别把一句好好的导语洗没了
  if (raw.length <= 160 && !BOILER_RE.test(raw)) return raw;

  var parts = splitSentences(raw);
  var scored = [];
  var fallback = [];

  for (var i = 0; i < parts.length; i++) {
    var s = parts[i].replace(/^[#>*\s\-—·|]+/, '').replace(/\s+/g, ' ').trim();
    // 12 字以下基本是栏目名/按钮（"首页""天气资讯""北京天气一天一变"），留着只会误导
    if (!s || s.length < 12) continue;
    if (isNoiseLine(s)) continue;
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(s)) continue;
    if (BOILER_RE.test(s)) continue;
    // 纯导航串（"首页 预报 预警 雷达 云图…"）整句丢掉。
    // 以前这段只喂给模型，模型看得出它不是正文；现在摘要要**展示给学生**
    // （参考来源点开即读），留着只会让人觉得答案在糊弄。
    // 注意这里只丢整句，不做词级删除 —— "语音播报 进入频道" 那种前缀后面
    // 常常就是真正文，整句删掉等于把正文一起扔了。
    if (looksLikeNav(s)) continue;

    var hit = 0;
    for (var t = 0; t < tokens.length; t++) {
      if (s.toLowerCase().indexOf(tokens[t]) >= 0) hit++;
    }
    // 开头几句通常是导语，检索词没命中也要留一手
    if (fallback.length < 3) fallback.push(s);

    if (!hit) continue;
    var score = hit * 2;
    if (s.length >= 20 && s.length <= 140) score += 1;   // 有信息量又不冗长
    if (s.length > 220) score -= 1;                       // 太长多半是拼起来的整段
    scored.push({ s: s, score: score, i: i });
  }

  if (!scored.length) {
    // 一句都没命中：退回开头导语，至少不是导航栏；一条都没有就返回空，
    // 表示"这页没有可用正文"——留给上层降权，而不是把版权信息喂给模型。
    return fallback.join('。').slice(0, 420);
  }

  scored.sort(function(a, b) { return b.score - a.score || a.i - b.i; });
  var picked = scored.slice(0, 4).sort(function(a, b) { return a.i - b.i; });
  var out = [];
  for (var p = 0; p < picked.length; p++) {
    out.push(picked[p].s);
    if (out.join('。').length > 420) break;
  }
  return out.join('。').slice(0, 480);
}

// 页面模板噪声的**残留**检测。
// condenseSnippet 已经把整句的模板文字删掉了，但有些页面抓回来的整段就是推荐位列表，
// 没有一句像正文 —— 这类结果要么降权要么排到最后，不能和带数字的正文同权。
var NAV_WORD_RE = /(视频|热点|推荐|专题|图给你看|更多|点击|关注|直播|图集|专题报道|大家都在看)/g;

function looksLikeNav(s) {
  var t = String(s || '');
  if (!t) return true;
  var navHits = (t.match(NAV_WORD_RE) || []).length;
  if (navHits >= 2) return true;
  // 全是短句拼接（导航/列表的典型形态）
  var segs = t.split(/[。！？]/).filter(function(x) { return x.trim(); });
  if (segs.length >= 2) {
    var shortCnt = 0;
    for (var i = 0; i < segs.length; i++) if (segs[i].trim().length < 10) shortCnt++;
    if (shortCnt / segs.length > 0.6) return true;
  }
  return false;
}

function normalizeItem(title, url, snippet, published) {
  return {
    title: cleanTitle(title),
    url: String(url || '').trim(),
    snippet: String(snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX),
    published: String(published || '').trim().slice(0, 40)
  };
}

// 域名 → 来源类型 + 可信度。
// 这不是"权威排名"，只是给模型一个**该不该采信**的提示：
// 学生问政策条文时，"某论坛网友说"和"教育部官网"不该同权。
// 分值刻意压在 0.5~1.0 之间：可信度是排序的调节项，不该盖过"这条到底相不相关"。
var DOMAIN_RULES = [
  { re: /(^|\.)gov\.cn$|(^|\.)gov$/, type: '政府/官方', score: 1.00 },
  { re: /(^|\.)edu\.cn$|(^|\.)edu$|(^|\.)ac\.cn$/, type: '高校/学术', score: 0.95 },
  { re: /^(docs|developer|developers|learn|support|help|manual)\./, type: '官方文档', score: 0.92 },
  { re: /(^|\.)(wikipedia\.org|baike\.baidu\.com|encyclopedia)/, type: '百科', score: 0.78 },
  { re: /(^|\.)(zhihu\.com|stackoverflow\.com|stackexchange\.com|v2ex\.com)/, type: '问答社区', score: 0.70 },
  { re: /(^|\.)(csdn\.net|cnblogs\.com|juejin\.cn|segmentfault\.com)/, type: '技术博客', score: 0.66 },
  { re: /(^|\.)(xinhuanet\.com|people\.com\.cn|cctv\.com|chinadaily\.com\.cn|thepaper\.cn|bjnews\.com\.cn|bjd\.com\.cn|gmw\.cn|ce\.cn|youth\.cn)/, type: '新闻媒体', score: 0.85 },
  // 中国天气网是气象局公共气象服务门户，天气类问题里它就是一手来源
  { re: /(^|\.)weather\.com\.cn$/, type: '政府/官方', score: 0.95 },
  { re: /(^|\.)(sohu\.com|sina\.com\.cn|sina\.cn|163\.com|qq\.com|ifeng\.com|toutiao\.com|baijiahao\.baidu\.com)/, type: '门户/聚合', score: 0.58 },
  { re: /(^|\.)(douyin\.com|kuaishou\.com|bilibili\.com|xigua\.com|haokan\.baidu\.com)/, type: '短视频平台', score: 0.52 }
];

function domainOf(url) {
  try {
    return new nodeUrl.URL(String(url || '')).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function classifyDomain(url) {
  var host = domainOf(url);
  if (!host) return { type: '未知来源', score: 0.50, host: '' };
  for (var i = 0; i < DOMAIN_RULES.length; i++) {
    if (DOMAIN_RULES[i].re.test(host)) {
      return { type: DOMAIN_RULES[i].type, score: DOMAIN_RULES[i].score, host: host };
    }
  }
  return { type: '其他网站', score: 0.60, host: host };
}

// 检索词拆成可匹配的 token：英文/数字按词，中文按 2-gram。
// 为什么不引入分词库：这里只需要"命中率"这个粗指标，2-gram 够用且零依赖；
// 引入词典反而会让"新词/专有名词"漏判。
var CN_STOP = {};
('的 了 是 吗 呢 吧 啊 和 与 在 有 就 都 而 及 其 这 那 什么 怎么 如何 为什么 可以 一个 我们 你们 他们 它们 请问 帮我 一下 以及 还是 或者 关于 对于 现在 目前')
  .split(/\s+/).forEach(function(w) { CN_STOP[w] = 1; });

function tokenizeQuery(q) {
  var s = String(q || '').toLowerCase();
  var out = [];
  var seen = {};

  function push(t) {
    if (!t || seen[t]) return;
    seen[t] = 1;
    out.push(t);
  }

  // 英文/数字/型号：整体保留（如 iphone17、http2、b760）
  var latin = s.match(/[a-z0-9][a-z0-9.+#_-]*/g) || [];
  for (var i = 0; i < latin.length; i++) {
    if (latin[i].length >= 2 && !CN_STOP[latin[i]]) push(latin[i]);
  }

  // 中文：按非汉字切段，段内只取 2-gram。
  // 为什么**不**把整段当一个 token：模型给的是一句话（"今天北京天气"），
  // 整串几乎不可能原样出现在标题里，放进分母会把所有结果的相关性一起压低
  //（实测官方气象台那条只有 0.33）。整串的精确匹配改由 exactBonus 单独加分。
  var segs = s.split(/[^\u4e00-\u9fa5]+/);
  for (var j = 0; j < segs.length; j++) {
    var seg = segs[j];
    if (!seg) continue;
    for (var k = 0; k + 2 <= seg.length; k++) {
      var bi = seg.slice(k, k + 2);
      if (CN_STOP[bi] || CN_STOP[bi.charAt(0)] || CN_STOP[bi.charAt(1)]) continue;
      push(bi);
    }
  }
  return out;
}

// 整句命中：标题或摘要里出现了完整检索词，是"就是这条"的强信号。
// 单独加分而不是混进 token 分母，两种信号才不互相干扰。
function exactBonus(query, item) {
  var q = String(query || '').toLowerCase().replace(/\s+/g, '');
  if (q.length < 4) return 0;
  var hay = (String(item.title || '') + ' ' + String(item.snippet || ''))
    .toLowerCase().replace(/\s+/g, '');
  return hay.indexOf(q) >= 0 ? 0.28 : 0;
}

function relevanceOf(tokens, item) {
  if (!tokens || !tokens.length) return 0.5;
  var hay = (String(item.title || '') + ' ' + String(item.snippet || '')).toLowerCase();
  if (!hay) return 0;
  var hit = 0;
  for (var i = 0; i < tokens.length; i++) {
    if (hay.indexOf(tokens[i]) >= 0) hit++;
  }
  return hit / tokens.length;
}

function parsePublished(s) {
  var str = String(s || '').trim();
  if (!str) return NaN;
  var m = str.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  m = str.match(/^(\d{4})$/);
  if (m) return new Date(Number(m[1]), 0, 1).getTime();
  var t = Date.parse(str);
  return isFinite(t) ? t : NaN;
}

// 新鲜度：越新越高；时间缺失给中性分（不能因为没写日期就判死）
//
// strict = 强时效问题（天气/股价/比分）的陡衰减：
// 一周之外就明显掉档，否则"今天天气"会被上个月的旧预报按词面相似度顶到第一
//（实测 9-30 的旧闻 rel=1.0 压过 10-19 的新闻 rel=0.8）。
function freshnessOf(published, strict) {
  var t = parsePublished(published);
  if (!isFinite(t)) return 0.5;
  var days = (Date.now() - t) / 86400000;
  if (days < -1) return 0.9;          // 未来的日期大概率是"预告/计划"，不算错
  if (!strict) {
    if (days <= 7) return 1.00;
    if (days <= 30) return 0.88;
    if (days <= 180) return 0.70;
    if (days <= 365) return 0.55;
    return 0.32;
  }
  if (days <= 1) return 1.00;
  if (days <= 3) return 0.95;
  if (days <= 7) return 0.88;
  if (days <= 14) return 0.72;
  if (days <= 30) return 0.55;
  if (days <= 90) return 0.35;
  return 0.15;
}

// 同一篇文章会被不同聚合站转载、带一堆跟踪参数，归一化后才能去重
function normalizeUrl(url) {
  var u = String(url || '').trim();
  if (!u) return '';
  try {
    var parsed = new nodeUrl.URL(u);
    parsed.hash = '';
    var drop = [];
    parsed.searchParams.forEach(function(v, k) {
      if (/^(utm_|spm|from|share_|ref|source$|src$|fr$|vd_source)/i.test(k)) drop.push(k);
    });
    for (var i = 0; i < drop.length; i++) parsed.searchParams.delete(drop[i]);
    var path = parsed.pathname.replace(/\/+$/, '');
    return (parsed.hostname + path + (parsed.search || '')).toLowerCase();
  } catch (e) {
    return u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  }
}

// 网站首页对"回答问题"几乎没有价值（只有导航和栏目名），
// 但它的域名往往很权威，不降权就会把真正的详情页挤下去。
function isHomepage(url) {
  try {
    var p = new nodeUrl.URL(String(url || ''));
    if (!p.pathname || p.pathname === '/') return true;
    return /^\/(index|home|default)\.\w+$/i.test(p.pathname);
  } catch (e) {
    return false;
  }
}

// 打分排序：相关性是门槛，可信度与时效是调节项。
// 权重为什么这么配：相关性 0.50 保证"跑题结果不可能因为来自官网就排第一"，
// 可信度 0.26 让官方口径在同等相关下上浮，时效 0.24 让"今天天气"不会被去年页面占位。
//
// newsWeights 是给强时效问题（天气/股价/比分）的另一套权重：
// 实测"今天天气"下，门户三个月前的旧预报靠词面更全（0.8 vs 0.4）压过气象台今早的发布，
// 把时效从 0.24 提到 0.30 才纠正 —— 这不是"偏好新内容"，而是这类问题的答案**本身**有时效。
var GENERAL_WEIGHTS = { rel: 0.50, auth: 0.26, fresh: 0.24, strictFresh: false };
var NEWS_WEIGHTS = { rel: 0.44, auth: 0.26, fresh: 0.30, strictFresh: true };

function rankResults(items, queryInfos, weights) {
  var w = weights || GENERAL_WEIGHTS;
  var byUrl = {};

  // 多路检索时把所有检索词的 token 合并，用于摘要清洗
  //（只按单条 query 洗会漏掉另一条相关的句子）
  var allTokens = [];
  var seenT = {};
  for (var qi = 0; qi < queryInfos.length; qi++) {
    var tk = queryInfos[qi].tokens || [];
    for (var ki = 0; ki < tk.length; ki++) {
      if (!seenT[tk[ki]]) { seenT[tk[ki]] = 1; allTokens.push(tk[ki]); }
    }
  }

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || !it.url) continue;

    // 摘要在打分之前洗：导航文字会虚高相关性，也会误导模型。
    // 允许洗成空串 —— 那表示"这页抓回来的全是导航/版权"，宁可不给摘要，
    // 让 looksLikeNav 去降权，也不要给模型一段会误导的模板文字。
    it.snippet = condenseSnippet(it.snippet, allTokens);

    var rel = 0;
    var matched = 0;
    for (var q = 0; q < queryInfos.length; q++) {
      var r = relevanceOf(queryInfos[q].tokens, it) + exactBonus(queryInfos[q].q, it);
      if (r > 1) r = 1;
      if (r > rel) rel = r;
      if (r >= 0.30) matched++;
    }

    var cls = classifyDomain(it.url);
    var fresh = freshnessOf(it.published, w.strictFresh);

    // 完全跑题、又不是官方/学术来源 → 直接丢。
    // 放宽到 auth <= 0.66 才丢：官网即使词面没命中，也可能是"标准答案"。
    if (rel < 0.15 && cls.score <= 0.66) continue;

    // 强时效场景：一周之外的页面即使词面更贴，也不该排在今早的预报前面
    if (w.strictFresh && fresh < 0.80) rel = rel * 0.85;

    var score = w.rel * rel + w.auth * cls.score + w.fresh * fresh;
    // 抓回来就是推荐位/视频列表的结果：降权但不丢，有时官方栏目页只能给到这个
    if (looksLikeNav(it.snippet)) score -= 0.09;
    if (String(it.snippet || '').length < 40) score -= 0.05;
    // 多路检索交叉命中：两套检索词都能找到的内容，通常就是"事实本身"
    if (matched > 1) score += 0.10 * (matched - 1);
    if (isHomepage(it.url)) score -= 0.08;
    if (score > 1.2) score = 1.2;

    var norm = normalizeUrl(it.url);
    var prev = byUrl[norm];
    if (prev) {
      // 同一篇：留分高的；摘要取更长的那份（信息量更大）
      if (score > prev.score) {
        it.snippet = it.snippet.length >= prev.snippet.length ? it.snippet : prev.snippet;
        it.score = score;
        it.source_type = cls.type;
        it.host = cls.host;
        it.relevance = rel;
        it.matched = matched;
        byUrl[norm] = it;
      } else if (it.snippet.length > prev.snippet.length) {
        prev.snippet = it.snippet;
      }
      continue;
    }

    it.score = score;
    it.source_type = cls.type;
    it.host = cls.host;
    it.relevance = rel;
    it.matched = matched;
    byUrl[norm] = it;
  }

  var list = Object.keys(byUrl).map(function(k) { return byUrl[k]; });
  list.sort(function(a, b) { return b.score - a.score; });
  return list;
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

// 强时效问题才切 news 通道。
// 为什么不做成"永远 news"：news 通道只覆盖新闻站点，查 API 文档、百科、官网公告会漏；
// 反过来只走 general，"今天天气/股价"会被半年前的页面顶到前面。
var URGENT_RE = /(今天|今日|现在|最新|最近|这两天|本周|本月|今年|当前|实时|刚刚|天气|气温|降雨|台风|股价|行情|汇率|金价|油价|比分|赛果|赛程|排名|票房|新闻|发布会|版本|更新|价格|多少钱|涨|跌|新政|政策|通知|公告)/;
var HISTORY_RE = /(历史|往年|去年|前年|起源|由来|背景|原理|定义|是什么|介绍)/;

function isNewsQuery(q) {
  var s = String(q || '');
  return URGENT_RE.test(s) && !HISTORY_RE.test(s);
}

// 模型偶尔会把整句口语原样当检索词（"帮我查查最近有什么新闻"）。
// 各家的召回对"实词密度"很敏感，去掉客套前缀能明显提升命中，
// 顺带让缓存键更稳定（换个客套说法的同一个问题会撞上同一条缓存）。
var PREAMBLE_RE = /^(帮我|帮忙|请帮我|请|请问|麻烦|我想知道|我想问一下|想问问|能不能帮我|可以帮我|你能帮我)[\s，,、]*/;
var FILLER_RE = /(查一下|查一查|查查|搜一下|搜一搜|搜搜|搜索一下|找一下|告诉我|了解一下|是怎么回事|是什么情况)/g;

function cleanQuery(q) {
  var raw = String(q || '').trim();
  var s = raw.replace(PREAMBLE_RE, '');
  s = s.replace(FILLER_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // 洗没了就退回原串：宁可多带几个语气词，也不能把检索词清空
  return s || raw;
}

function callTavily(cfg, query, mode) {
  var body = {
    query: query,
    max_results: cfg.maxResults,
    search_depth: cfg.depth,
    // 让上游返回它自己的综合答案会诱导模型"抄一段成品"、丢掉引用编号，
    // 这里只要原始结果，综合交给模型自己做。
    include_answer: false,
    include_raw_content: false
  };
  // general 是 Tavily 默认值，显式传也无害；news 必须配 days 才有效
  if (mode === 'news') {
    body.topic = 'news';
    body.days = 30;
  }

  return axios.post(cfg.endpoint, body, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    },
    timeout: cfg.timeoutMs
  }).then(function(resp) {
    var data = resp.data || {};
    var list = Array.isArray(data.results) ? data.results : [];
    return list.map(function(x) {
      return normalizeItem(x.title, x.url, x.content, x.published_date);
    });
  });
}

function callBocha(cfg, query, mode) {
  var body = {
    query: query,
    summary: true,
    count: cfg.maxResults,
    page: 1
  };
  // 只在强时效时传 freshness：老接口对这个字段的取值集合比较敏感，
  // general 场景不传最稳（默认 noLimit）。
  if (mode === 'news') body.freshness = 'oneMonth';

  return axios.post(cfg.endpoint, body, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + cfg.apiKey
    },
    timeout: cfg.timeoutMs
  }).then(function(resp) {
    var data = resp.data || {};
    // 博查把业务码放在 body 里：HTTP 200 但 code != 200 是常见形态，
    // 不判就会静默返回空结果，看起来像"搜不到"。
    if (data.code && data.code !== 200) {
      throw new Error(data.msg || data.message || ('搜索服务返回 ' + data.code));
    }
    var pages = (data.data && data.data.webPages && data.data.webPages.value) || [];
    return pages.map(function(x) {
      return normalizeItem(x.name, x.url, x.summary || x.snippet, x.datePublished);
    });
  });
}

function callProvider(cfg, query, mode) {
  if (cfg.provider === 'bocha') return callBocha(cfg, query, mode);
  return callTavily(cfg, query, mode);
}

// 错误翻译：和 ai.js 的 normalizeUpstreamError 同一个思路 ——
// 学生/老师看到的应该是"下一步能做什么"，不是状态码。
function translateError(err, timeoutMs) {
  var status = err.response && err.response.status;
  var detail = '';
  if (err.response && err.response.data) {
    var d = err.response.data;
    if (typeof d === 'string') detail = d.slice(0, 160);
    else if (d.message) detail = String(d.message).slice(0, 160);
    else if (d.msg) detail = String(d.msg).slice(0, 160);
    else if (d.error && d.error.message) detail = String(d.error.message).slice(0, 160);
  }
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || '')) {
    return '搜索超时（' + Math.round(timeoutMs / 1000) + ' 秒）';
  }
  if (status === 401 || status === 403) return '搜索服务的 Key 无效或无权限';
  if (status === 429) return '搜索服务调用太频繁，请稍后再试';
  if (status >= 500) return '搜索服务暂时不可用';
  if (!err.response) return '连不上搜索服务，请检查网络';
  return detail || '搜索失败';
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

// 单条 query：带缓存。多查询并发时各自独立命中缓存，互不影响。
function searchOne(cfg, q, mode) {
  var cacheKey = [cfg.provider, cfg.maxResults, cfg.depth, mode, q].join('|');
  var cached = cacheGet(cacheKey);
  if (cached) return Promise.resolve(Object.assign({}, cached, { cached: true }));

  var started = Date.now();
  var providerCfg = Object.assign({}, cfg, PROVIDERS[cfg.provider]);

  return callProvider(providerCfg, q, mode).then(function(items) {
    var payload = {
      ok: true,
      provider: cfg.provider,
      provider_label: PROVIDERS[cfg.provider].label,
      query: q,
      mode: mode,
      results: items,
      took_ms: Date.now() - started,
      cached: false
    };
    cacheSet(cacheKey, payload, 5 * 60 * 1000);
    return payload;
  }).catch(function(err) {
    var msg = translateError(err, cfg.timeoutMs);
    console.warn('[Search] %s 查询失败（%s）：%s', cfg.provider, q, msg);
    return {
      ok: false,
      error: msg,
      provider: cfg.provider,
      query: q,
      mode: mode,
      results: [],
      took_ms: Date.now() - started
    };
  });
}

// 主入口：永远 resolve，不把异常抛给对话主链路。
// 为什么：搜索只是"锦上添花"，它挂掉不该让整轮回答失败——
// 模型拿不到结果时能靠自己的知识回答，学生至少还有答案。
//
// 入参可以是单条字符串，也可以是 1~2 条不同角度的字符串数组（详见文件头）。
function search(queries) {
  var cfg = getSearchConfig();
  var raw = Array.isArray(queries) ? queries : [queries];

  var list = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    // 先洗口语再截断：模型给的常是整句，"帮我查查……"这类前缀会直接拉低召回
    var q = cleanQuery(raw[i]).slice(0, 200);
    if (!q) continue;
    var key = q.toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    list.push(q);
  }
  if (list.length > MAX_QUERIES_PER_CALL) list = list.slice(0, MAX_QUERIES_PER_CALL);

  if (!list.length) {
    return Promise.resolve({
      ok: false, error: '搜索关键词为空', results: [], queries: [],
      provider: cfg.provider, query: ''
    });
  }
  if (!cfg.enabled) {
    return Promise.resolve({
      ok: false, error: '联网搜索未启用', results: [], queries: list,
      provider: cfg.provider, query: list[0]
    });
  }
  if (!cfg.apiKey) {
    return Promise.resolve({
      ok: false, error: '联网搜索还没配置 API Key', results: [], queries: list,
      provider: cfg.provider, query: list[0]
    });
  }

  var started = Date.now();
  // 并发：多等一条 query 的延迟是不必要的；两条 query 的总耗时 ≈ 一条（上游并行）。
  var tasks = list.map(function(q) {
    return searchOne(cfg, q, isNewsQuery(q) ? 'news' : 'general');
  });

  return Promise.all(tasks).then(function(payloads) {
    var okAny = false;
    var firstErr = '';
    var merged = [];
    var queryInfos = [];

    for (var p = 0; p < payloads.length; p++) {
      var pl = payloads[p];
      queryInfos.push({ q: pl.query, tokens: tokenizeQuery(pl.query), ok: !!pl.ok });
      if (pl.ok) okAny = true;
      else if (!firstErr) firstErr = pl.error || '搜索失败';
      var rs = pl.results || [];
      for (var r = 0; r < rs.length; r++) merged.push(rs[r]);
    }

    if (!okAny) {
      lastError = firstErr;
      lastErrorAt = new Date().toISOString();
      return {
        ok: false,
        error: firstErr,
        provider: cfg.provider,
        query: list[0],
        queries: list,
        results: [],
        took_ms: Date.now() - started
      };
    }

    var anyNews = queryInfos.some(function(x) { return isNewsQuery(x.q); });
    var ranked = rankResults(merged, queryInfos, anyNews ? NEWS_WEIGHTS : GENERAL_WEIGHTS)
      .slice(0, cfg.maxResults);

    lastError = '';
    lastErrorAt = '';

    return {
      ok: true,
      provider: cfg.provider,
      provider_label: PROVIDERS[cfg.provider].label,
      query: list[0],
      queries: list,
      mode: isNewsQuery(list[0]) ? 'news' : 'general',
      // total_before_rank 让管理台的"测试"能看出上游给了多少、被丢掉多少
      total_before_rank: merged.length,
      results: ranked,
      took_ms: Date.now() - started,
      cached: payloads.every(function(x) { return !!x.cached; })
    };
  });
}

// ---------------------------------------------------------------------------
// 给模型看的文本
// ---------------------------------------------------------------------------

// 下发给模型的结果文本。
// 编号是必须的：模型要能写出「[1]」这种引用，学生才可能去核对；
// 不带编号的裸链接列表，模型通常会吞掉出处。
// 「来源类型 + 域名 + 时间」也是必须的：不标注的话，模型会把论坛帖和官网通知
// 当成同等可信，学生看到的就是"两种说法"而不是"哪个更有依据"。
// startIndex：本轮结果在整轮对话里的编号起点。
// 为什么要连续编号：一轮里可能检索两次，如果每次都从 [1] 开始，
// 正文里的 [1] 到底指哪一条就说不清了 —— 来源清单也就没法对应。
function formatForModel(payload, startIndex) {
  if (!payload || !payload.ok) {
    return '联网搜索没有成功：' + ((payload && payload.error) || '未知原因') +
      '。请基于你已经知道的内容回答，并明确说明这部分信息可能不是最新的。';
  }
  var items = payload.results || [];
  var queries = payload.queries || [payload.query];
  var base = Number(startIndex) || 0;

  if (!items.length) {
    return '联网搜索没有找到相关结果（检索词：' + queries.join(' / ') + '）。' +
      '请直接说明"没有查到相关资料"，再基于你已经知道的内容谨慎回答；' +
      '不要为了填满答案而编造事实或链接。';
  }

  var lines = [];
  lines.push('联网搜索结果（' + (payload.provider_label || payload.provider) + '，' +
    (queries.length > 1 ? queries.length + ' 组检索词' : '检索词「' + queries[0] + '」') +
    '，共 ' + items.length + ' 条，已按相关度排序）：');
  if (queries.length > 1) {
    for (var qi = 0; qi < queries.length; qi++) {
      lines.push('  检索词 ' + (qi + 1) + '：' + queries[qi]);
    }
  }
  if (base > 0) {
    lines.push('  编号从 [' + (base + 1) + '] 开始（延续本轮上一批检索），引用时沿用这些编号。');
  }
  lines.push('');

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    lines.push('[' + (base + i + 1) + '] ' + (it.title || '(无标题)'));
    var meta = [];
    if (it.source_type) meta.push(it.source_type);
    if (it.host) meta.push(it.host);
    if (it.published) meta.push(it.published);
    if (meta.length) lines.push('来源：' + meta.join(' · '));
    if (it.url) lines.push('URL: ' + it.url);
    if (it.snippet) lines.push('摘要: ' + it.snippet);
    lines.push('');
  }

  lines.push('使用要求：');
  lines.push('1. 只采用与问题相关的内容；不要补充搜索结果里没有的事实、数字、日期和网址。');
  lines.push('2. 引用具体事实时在句末标注上面给出的编号（如 [1]）；同一句用了多条就写 [1][3]。');
  lines.push('3. 「政府/官方」「高校/学术」「官方文档」与「门户/聚合」「短视频平台」「问答社区」说法冲突时，以前者为准，并可以说明存在不同说法。');
  lines.push('4. 结果时间早于问题所指时间（例如问"今年"却只有往年的页面）时，要说明这是较早的信息，不要当成当前情况。');
  lines.push('5. 如果这些结果不足以回答，就直接说没查到，不要用记忆补全，也不要伪造出处。');
  return lines.join('\n');
}

// 工具描述就是模型的"使用说明书"——
// 实测写清"什么时候该搜/不该搜 + 关键词怎么构造"比在 system 里重复三遍更有效，
// 因为模型在决定要不要调用工具时，看的就是这段。
function toolDefinition() {
  return {
    type: 'function',
    function: {
      name: 'web_search',
      description: [
        '联网搜索互联网上的实时信息，返回带编号、来源和时间的网页摘要。',
        '必须用：新闻时事、天气、价格、汇率、比分赛果、政策条文、招生/考试通知、软件版本、人物近况、',
        '以及任何你不确定或可能已经变化的数据；学生明确说"查一下/搜一下/最新"时也用。',
        '不要用：闲聊、写作创作、解题步骤、古诗文与课文默写、纯计算、学生刚发给你的题目原文（那些直接用你已有的知识）。',
        '关键词写法：像在搜索引擎里输入一样，用「主体 + 限定词（年份/地区/机构/单位/型号）」的实词组合，',
        '去掉"帮我查查""请问""是怎么回事"这类口语；',
        '不要把具体网站名当检索词（"某某网""某某天气网"），除非学生明确要求查那个站 —— 站点名只会把结果锁死在少数页面。'
      ].join(''),
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '主检索词。例：「2026 北京中考 体育 分值」「iPhone 17 国行 价格」「台风 路径 今天」。一次只查一个主题。'
          },
          queries: {
            type: 'array',
            items: { type: 'string' },
            description: '可选，最多 2 条。需要交叉验证或换个说法再查时填：第一条用通俗说法，第二条用官方/学术口径（例如「北京中考体育分值」+「北京市教育委员会 中考体育 实施方案」）。不填就只用 query。'
          }
        },
        required: ['query']
      }
    }
  };
}

function statusForAdmin() {
  var cfg = getSearchConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.provider,
    provider_label: (PROVIDERS[cfg.provider] || {}).label || cfg.provider,
    has_key: !!cfg.apiKey,
    key_masked: maskKey(cfg.apiKey),
    max_results: cfg.maxResults,
    timeout_ms: cfg.timeoutMs,
    depth: cfg.depth,
    max_queries: MAX_QUERIES_PER_CALL,
    ready: isReady(),
    providers: Object.keys(PROVIDERS).map(function(id) {
      return { id: id, label: PROVIDERS[id].label, doc: PROVIDERS[id].doc };
    }),
    last_error: lastError,
    last_error_at: lastErrorAt
  };
}

module.exports = {
  PROVIDERS: PROVIDERS,
  getSearchConfig: getSearchConfig,
  saveSearchConfig: saveSearchConfig,
  isReady: isReady,
  search: search,
  formatForModel: formatForModel,
  toolDefinition: toolDefinition,
  statusForAdmin: statusForAdmin,
  clearCache: clearCache,
  maskKey: maskKey,
  // 供 turn-runner 合并多路检索时对齐上限（避免 status 与实际执行条数不一致）
  MAX_QUERIES: MAX_QUERIES_PER_CALL,
  // 暴露给测试/管理台排查，不参与对话主链路
  rankResults: rankResults,
  tokenizeQuery: tokenizeQuery,
  isNewsQuery: isNewsQuery
};
