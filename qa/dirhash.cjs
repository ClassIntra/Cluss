// 目录指纹清单：输出每个文件的相对路径 + md5（排序），用于两端比对。
// 用法：node dirhash.cjs <目录> > out.txt
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var root = process.argv[2];
if (!root) { console.error('用法: node dirhash.cjs <目录>'); process.exit(1); }

var out = [];
(function walk(dir, rel) {
  var names = fs.readdirSync(dir).sort();
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    var abs = path.join(dir, n);
    var r = rel ? rel + '/' + n : n;
    var st;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (st.isDirectory()) walk(abs, r);
    else if (st.isFile()) {
      var h = crypto.createHash('md5').update(fs.readFileSync(abs)).digest('hex');
      out.push(r + '  ' + h);
    }
  }
})(root, '');

for (var i = 0; i < out.length; i++) console.log(out[i]);
console.error('文件数: ' + out.length);
