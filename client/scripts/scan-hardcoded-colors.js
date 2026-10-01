// 扫描：还有哪些硬编码颜色没走令牌
//
// 用途：深色模式下，任何一处未令牌化的浅色都会变成刺眼的白色方块。
// 这个脚本是「改完自己检查一遍」的那一步，也是后续防止回退的守卫。
//
// 用法：node scripts/scan-hardcoded-colors.js
// 退出码非 0 表示有遗漏（可用于 CI）

var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, '..', 'src');

// 允许出现硬编码的文件与理由（必须写明，避免这里变成垃圾桶）
var ALLOWLIST = {
  'styles/global.css': '设计令牌的定义处（:root 与 html[data-theme]）本身必须是字面量',
  'components/ClussLogo.vue': '品牌 logo 的 SVG 填充色，两种主题下保持一致',
  'views/Login.vue': null,      // 仅允许 global.css 与 logo
  'views/Register.vue': null
};

// logo 的 SVG 允许这些值
var LOGO_ALLOW = ['#ffffff', '#5b9bff', '#2f6bdd'];

var PATTERNS = [
  { re: /rgba\(\s*31\s*,\s*41\s*,\s*72/, label: '墨色阶漏令牌' },
  { re: /rgba\(\s*255\s*,\s*255\s*,\s*255/, label: '白色面阶漏令牌' },
  { re: /rgba\(\s*20\s*,\s*24\s*,\s*38/, label: '遮罩漏令牌' },
  { re: /rgba\(\s*16\s*,\s*19\s*,\s*30/, label: '深层遮罩漏令牌' },
  { re: /rgba\(\s*47\s*,\s*107\s*,\s*221/, label: '强调色淡化漏令牌' },
  { re: /rgba\(\s*214\s*,\s*69\s*,\s*69/, label: '危险色淡化漏令牌' }
];

function walk(dir, out) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(vue|css)$/.test(e.name)) out.push(full);
  }
  return out;
}

function isVarDefinition(line) {
  return /^\s*--[\w-]+\s*:/.test(line);
}

var files = walk(SRC, []);
var problems = [];

for (var f = 0; f < files.length; f++) {
  var rel = path.relative(SRC, files[f]).replace(/\\/g, '/');
  var isGlobalCss = rel === 'styles/global.css';
  var isLogo = rel === 'components/ClussLogo.vue';

  var lines = fs.readFileSync(files[f], 'utf8').split('\n');

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // global.css 里只允许「变量定义行」出现字面量
    if (isGlobalCss && isVarDefinition(line)) continue;

    for (var p = 0; p < PATTERNS.length; p++) {
      if (PATTERNS[p].re.test(line)) {
        problems.push({
          file: rel, line: i + 1, label: PATTERNS[p].label, text: line.trim()
        });
        break;
      }
    }

    // logo 的 SVG 色单独放行
    if (isLogo) {
      var onlyLogoColors = true;
      var hexes = line.match(/#[0-9a-fA-F]{6}/g) || [];
      for (var h = 0; h < hexes.length; h++) {
        if (LOGO_ALLOW.indexOf(hexes[h].toLowerCase()) === -1) onlyLogoColors = false;
      }
      if (onlyLogoColors) {
        problems = problems.filter(function(x) { return !(x.file === rel && x.line === i + 1); });
      }
    }
  }
}

if (!problems.length) {
  console.log('✓ 没有发现未令牌化的硬编码颜色');
  process.exit(0);
}

console.log('✗ 发现 ' + problems.length + ' 处未令牌化的硬编码颜色：\n');
problems.forEach(function(p) {
  console.log('  ' + p.file + ':' + p.line + '  [' + p.label + ']');
  console.log('    ' + p.text);
});
process.exit(1);
