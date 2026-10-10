/**
 * 旧内核垫片：Chrome 80 / Android 9 / 微信 X5
 *
 * 为什么需要：构建目标 `es2015` 只保证**语法**能被旧内核解析，
 * esbuild **不会**补运行时 API。而 mermaid 11（图表引擎，按需加载）内部用了
 * 若干 Chrome 85~98 才有的方法，且就落在渲染热路径上：
 *   - `mermaid.core` 的 block 词法器里直接写着 `o.at(-1)`（Array.prototype.at，Chrome 92）
 *   - 同一份代码里有 `e instanceof AggregateError`，而 AggregateError 是 Chrome 85 的全局
 *     —— 旧内核上这一行直接抛 ReferenceError
 * 结果就是**流程图在旧平板上画不出来**，且不报语法错、只留一片空白。
 *
 * 为什么补这几个就够：把 dist 全量扫过一遍（含所有懒加载分片），超出 Chrome 80 的
 * 运行时 API 只有下面这几个，是一次**有界补齐**而不是打地鼠。两个看似命中的已排除：
 *   - `crypto.randomUUID` —— mermaid 自己写了 `crypto.randomUUID ? … : 回退`，无需插手
 *   - 主包里的 `AggregateError` —— 只是 `e.name || "AggregateError"` 里的字符串字面量
 *
 * 每个垫片都带特性探测，新浏览器上整段是空操作。
 * 必须在**入口最前面**执行（见 main.js 第一行）—— 按需加载的图表分片一定在
 * 入口求值完之后才加载，所以这里补上就是全局生效。
 *
 * 刻意不引入 core-js：只需要 4 个方法，为它背一整套 polyfill 的包体和副作用不值当。
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------- Array.prototype.at
  // Chrome 92。mermaid 的 block 词法器用它取末元素，属于渲染热路径。
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', {
      value: function at(index) {
        var len = this.length >>> 0;
        var i = Math.trunc(Number(index)) || 0;
        if (i < 0) i += len;
        return i < 0 || i >= len ? undefined : this[i];
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }

  // ------------------------------------------------- String.prototype.replaceAll
  // Chrome 85。
  if (!String.prototype.replaceAll) {
    Object.defineProperty(String.prototype, 'replaceAll', {
      value: function replaceAll(search, replacement) {
        var str = String(this);
        if (search instanceof RegExp) {
          if (!search.global) {
            throw new TypeError('replaceAll must be called with a global RegExp');
          }
          return str.replace(search, replacement);
        }
        // 走全局 RegExp 而不是 split().join()：只有 replace 才会按规范解释替换串里的
        // `$&`、`$1`、`$'` 这些占位符，split/join 会把它们原样塞进去，与原生行为不一致。
        return str.replace(new RegExp(escapeRegExp(String(search)), 'g'), replacement);
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ---------------------------------------------------------------- Object.hasOwn
  // Chrome 93。
  if (!Object.hasOwn) {
    Object.defineProperty(Object, 'hasOwn', {
      value: function hasOwn(obj, prop) {
        if (obj === null || obj === undefined) {
          throw new TypeError('Cannot convert undefined or null to object');
        }
        return Object.prototype.hasOwnProperty.call(Object(obj), prop);
      },
      writable: true,
      enumerable: false,
      configurable: true
    });
  }

  // ---------------------------------------------------------------- structuredClone
  // Chrome 98。mermaid 的 dagre / cytoscape / pie 用它深拷贝配置，传的都是纯数据。
  // 这是**够用版**而不是完整规范实现：不处理 Blob / File / ImageData / transferable，
  // 也不抛 DataCloneError（宁可宽松地拷过去，也不要给 mermaid 一个意外的异常）。
  // 循环引用靠 seen 表处理 —— 图表配置里嵌套引用是常见的。
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = function structuredClone(value) {
      return cloneValue(value, []);
    };
  }

  function cloneValue(value, seen) {
    if (value === null || typeof value !== 'object') return value;

    for (var s = 0; s < seen.length; s++) {
      if (seen[s][0] === value) return seen[s][1];
    }

    var tag = Object.prototype.toString.call(value);
    var out;
    var i;

    if (tag === '[object Date]') return new Date(value.getTime());
    if (tag === '[object RegExp]') {
      out = new RegExp(value.source, value.flags);
      out.lastIndex = value.lastIndex;
      return out;
    }
    if (tag === '[object ArrayBuffer]') return value.slice(0);

    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
      // DataView 没有可复制的元素数组，只能从底层 buffer 重建
      if (tag === '[object DataView]') {
        return new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
      }
      return new value.constructor(value);
    }

    if (tag === '[object Map]') {
      out = new Map();
      seen.push([value, out]);
      value.forEach(function (v, k) { out.set(cloneValue(k, seen), cloneValue(v, seen)); });
      return out;
    }

    if (tag === '[object Set]') {
      out = new Set();
      seen.push([value, out]);
      value.forEach(function (v) { out.add(cloneValue(v, seen)); });
      return out;
    }

    if (tag === '[object Error]' || value instanceof Error) {
      out = new Error(value.message);
      out.name = value.name;
      out.stack = value.stack;
      for (var k in value) {
        if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = cloneValue(value[k], seen);
      }
      return out;
    }

    // 数组与普通对象。刻意不复制原型链上的方法：
    // structuredClone 的语义就是"拷数据不拷行为"，图表配置里也没有需要保留行为的对象。
    if (Array.isArray(value)) {
      out = [];
      seen.push([value, out]);
      for (i = 0; i < value.length; i++) out[i] = cloneValue(value[i], seen);
      return out;
    }

    out = {};
    seen.push([value, out]);
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        out[key] = cloneValue(value[key], seen);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- AggregateError
  // Chrome 85。mermaid 用它做 `e instanceof AggregateError` 的类型判定；
  // 缺了这个全局，那一行会抛 ReferenceError 而不是"判定为 false"。
  // 必须是**真正的构造函数**（把原型链接到 Error.prototype），
  // 否则 instanceof 判定恒为 false，等于没补。
  if (typeof global.AggregateError !== 'function') {
    function AggregateError(errors, message, options) {
      this.name = 'AggregateError';
      this.message = message === undefined ? '' : String(message);
      this.errors = errors === undefined ? [] : errors;
      if (options && 'cause' in options) this.cause = options.cause;
      if (Error.captureStackTrace) Error.captureStackTrace(this, AggregateError);
    }
    AggregateError.prototype = Object.create(Error.prototype);
    AggregateError.prototype.constructor = AggregateError;
    global.AggregateError = AggregateError;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
