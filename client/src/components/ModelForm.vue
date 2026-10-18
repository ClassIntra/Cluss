<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal glass">
      <h3 class="modal-title">{{ isCreate ? '新增模型' : '编辑模型 · ' + form.label }}</h3>
      <p class="modal-sub tiny muted">
        任何 OpenAI 兼容端点都可以接入。地址填到 <code>/v1</code> 即可，系统会自动补全路径。
      </p>

      <div class="form-scroll">
        <label class="field">
          <span class="field-label">模型 ID（唯一标识，创建后不可改）</span>
          <input
            v-model="form.id"
            class="input"
            type="text"
            :disabled="!isCreate"
            placeholder="如 deepseek-chat"
          />
        </label>

        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="form.label" class="input" type="text" placeholder="如 DeepSeek Chat" />
        </label>

        <!-- 模型源：地址/密钥沉到源上共享。源可选 —— 不挂源的模型继续自带连接信息 -->
        <label class="field">
          <span class="field-label">模型源（可选）</span>
          <select v-model="form.source_id" class="input">
            <option value="">不使用源（本模型自带地址与密钥）</option>
            <option v-for="s in sources" :key="s.id" :value="s.id">
              {{ s.label || s.id }} · {{ s.api_url || '未配地址' }}{{ s.enabled ? '' : '（已停用）' }}
            </option>
          </select>
        </label>
        <p class="price-note tiny muted">
          一个上游常一次提供多个模型：把地址与密钥放到「源」上共享，换域名 / 换密钥只需改一处。
          选了源，本模型的地址与密钥就由源提供（改这里无效）。
        </p>

        <template v-if="!form.source_id">
          <label class="field">
            <span class="field-label">API 地址</span>
            <input v-model="form.api_url" class="input" type="text" placeholder="https://api.deepseek.com" />
          </label>

          <label class="field">
            <span class="field-label">API Key</span>
            <input
              v-model="form.api_key"
              class="input"
              type="password"
              :placeholder="hasKey ? '留空表示不修改（当前：' + maskedKey + '）' : '填写上游密钥'"
            />
          </label>
        </template>
        <div v-else class="inherited-note tiny muted">
          连接信息继承自模型源「{{ selectedSourceLabel }}」：
          <span class="mono">{{ selectedSourceUrl || '源未配置地址' }}</span>
          <span v-if="!selectedSourceHasKey"> · 源未配置密钥</span>
          <span v-if="selectedSourceDisabled"> · 该源已停用，本模型将不可用</span>
        </div>

        <label class="field">
          <span class="field-label">上游模型名（留空则用模型 ID）</span>
          <input v-model="form.model_name" class="input" type="text" placeholder="如 deepseek-chat" />
        </label>

        <!-- 基准单价：只有默认模型能编（它就是全站计费锚点）。
             非默认模型的三个单价字段对计费已无意义，藏掉以免造成"改了却没生效"的错觉。 -->
        <template v-if="isDefault">
          <div class="row-3">
            <label class="field">
              <span class="field-label">输入单价（基准）</span>
              <input v-model="form.price_in" class="input" type="number" min="0" step="0.01" />
            </label>
            <label class="field">
              <span class="field-label">输出单价（基准）</span>
              <input v-model="form.price_out" class="input" type="number" min="0" step="0.01" />
            </label>
            <label class="field">
              <span class="field-label">缓存命中（基准）</span>
              <input v-model="form.price_cache_hit" class="input" type="number" min="0" step="0.01" />
            </label>
          </div>

          <p class="price-note tiny muted">
            单位「元 / 百万 token」（如输入 2 表示 2 元/百万）。默认模型即「全站计费基准」：
            所有模型都按「基准 × 各自倍率」扣积分，改这里即全站调价。
          </p>

          <div class="base-note tiny muted">
            默认模型的倍率固定 ×1.00（它就是基准本身），下方只需关心限免设置。
          </div>
        </template>
        <template v-else>
          <label class="field">
            <span class="field-label">积分倍率（相对默认模型）</span>
            <input
              v-model="form.price_multiplier"
              class="input"
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              :disabled="form.is_free"
            />
          </label>

          <p class="price-note tiny muted">
            ×1.20 表示按默认模型单价的 1.2 倍扣积分，支持两位小数（计费基准可在默认模型的编辑页调整）。
            勾选「免费模型」时倍率不生效。
          </p>
        </template>

        <label class="field">
          <span class="field-label">限免截止（留空 = 不限免）</span>
          <input v-model="form.free_until_local" class="input" type="datetime-local" :disabled="form.is_free" />
        </label>

        <p class="price-note tiny muted">
          设置限免后学生免积分使用，到点自动恢复计费；与倍率无关（限免优先）。
        </p>

        <div class="switch-list">
          <label class="switch-row">
            <input type="checkbox" v-model="form.enabled" />
            <span>启用该模型（禁用后学生选不到）</span>
          </label>
          <label class="switch-row">
            <input type="checkbox" v-model="form.is_free" />
            <span>免费模型（不受额度闸门限制，也不计费）</span>
          </label>
          <label class="switch-row">
            <input type="checkbox" v-model="form.supports_stream" />
            <span>支持流式输出</span>
          </label>
          <label class="switch-row">
            <input type="checkbox" v-model="form.supports_vision" />
            <span>支持视觉（能直接接收图片，用于拍题与批改）</span>
          </label>
          <label class="switch-row">
            <input type="checkbox" v-model="form.supports_thinking" />
            <span>支持深度思考（先输出思维链；请实测有效后再勾选）</span>
          </label>
          <label class="switch-row">
            <input type="checkbox" v-model="form.has_offpeak" />
            <span>参与峰谷计费（谷时段按折扣扣积分；不勾则本模型全天原价）</span>
          </label>
        </div>

        <!-- 模型级峰谷：留空即回退「全局默认」（在模型列表下方的「峰谷时段」里配） -->
        <template v-if="form.has_offpeak">
          <div class="row-3">
            <label class="field">
              <span class="field-label">峰时段一 · 开始</span>
              <input v-model="form.offpeak_windows[0].start" class="input" type="time" />
            </label>
            <label class="field">
              <span class="field-label">峰时段一 · 结束</span>
              <input v-model="form.offpeak_windows[0].end" class="input" type="time" />
            </label>
            <label class="field">
              <span class="field-label">谷时折扣（折）</span>
              <input
                v-model="form.offpeak_discount"
                class="input"
                type="number"
                min="0"
                max="9.9"
                step="0.5"
                placeholder="留空 = 全局"
              />
            </label>
          </div>

          <div class="row-3">
            <label class="field">
              <span class="field-label">峰时段二 · 开始（可留空）</span>
              <input v-model="form.offpeak_windows[1].start" class="input" type="time" />
            </label>
            <label class="field">
              <span class="field-label">峰时段二 · 结束</span>
              <input v-model="form.offpeak_windows[1].end" class="input" type="time" />
            </label>
            <span></span>
          </div>

          <p class="price-note tiny muted">
            每个模型的峰谷政策可能不同（有的上游根本没有谷时价），所以逐模型声明。
            峰时段留空 → 用全局默认峰窗（{{ globalOffpeakText }}）；折扣留空或 0 → 用全局默认。
          </p>
        </template>

        <label class="field" v-if="form.supports_vision">
          <span class="field-label">单次最多图片数（0 = 跟随全局默认）</span>
          <input v-model="form.vision_max_images" class="input" type="number" min="0" max="6" />
        </label>

        <div v-if="testResult" class="alert" :class="testResult.ok ? 'alert-success' : 'alert-danger'">
          <span v-if="testResult.ok">
            连通正常（{{ testResult.elapsed_ms }}ms）：{{ testResult.reply || '(无回复内容)' }}
          </span>
          <span v-else>
            测试失败：{{ testResult.error }}（{{ testResult.elapsed_ms }}ms）
          </span>
        </div>

        <div v-if="error" class="alert alert-danger">{{ error }}</div>
      </div>

      <div class="modal-actions">
        <button v-if="!isCreate" class="btn btn-ghost" :disabled="testing" @click="test">
          {{ testing ? '测试中…' : '测试连通' }}
        </button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" @click="$emit('close')">取消</button>
        <button class="btn btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script>
import modalEsc from '@/mixins/modal-esc';

// 模型编辑弹窗

// 库存单位是「微元 / 千 token」，表单按管理员习惯的「元 / 百万 token」口径显示与提交：
// 1 元/百万 = 1000 微元/千（数值 ×1000），两位小数足够表达 0.04 元/百万这类缓存价
function yuanPerMToMicro(v) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000);
}

function microToYuanPerM(v) {
  var n = Number(v || 0) / 1000;
  return Number(n.toFixed(3));
}

// UTC ISO → datetime-local 控件需要的本地时间值（YYYY-MM-DDTHH:mm）
function isoToLocal(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export default {
  name: 'ModelForm',
  // Esc 关闭：与 AiPrefs 等表单弹窗保持一致（按 Esc = 点「取消」）
  mixins: [modalEsc],
  props: {
    // 传入则为编辑，否则新增
    model: { type: Object, default: null },
    // 模型源清单（来自 GET /admin/models 的 sources）：模型可挂源共享地址与密钥
    sources: { type: Array, default: function() { return []; } },
    // 全局峰谷默认（含 peak_windows / discount）：用于「留空即用全局」的提示
    globalOffpeak: { type: Object, default: null }
  },
      data: function() {
        var m = this.model || {};
        // 模型级峰窗回传的是 [{start,end}]，非空时用于预填；否则留两个空槽
        var ow = (m.offpeak_peak_windows && m.offpeak_peak_windows.length) ? m.offpeak_peak_windows : [];
        return {
          form: {
            id: m.id || '',
            label: m.label || '',
            source_id: m.source_id || '',
            api_url: m.api_url || '',
            api_key: '',
            model_name: m.model_name || '',
            price_in: m.price_in === undefined ? 0 : microToYuanPerM(m.price_in),
            price_out: m.price_out === undefined ? 0 : microToYuanPerM(m.price_out),
            price_cache_hit: m.price_cache_hit === undefined ? 0 : microToYuanPerM(m.price_cache_hit),
            price_multiplier: m.price_multiplier === undefined ? 1 : m.price_multiplier,
            free_until_local: isoToLocal(m.free_until),
            enabled: m.enabled === undefined ? true : m.enabled === 1,
            is_free: m.is_free === 1,
            supports_stream: m.supports_stream === undefined ? true : m.supports_stream === 1,
            supports_vision: m.supports_vision === 1,
            supports_thinking: m.supports_thinking === 1,
            vision_max_images: m.vision_max_images === undefined ? 0 : m.vision_max_images,
            // ---- 峰谷（逐模型）----
            has_offpeak: m.has_offpeak === 1,
            offpeak_windows: [
              { start: (ow[0] && ow[0].start) || '', end: (ow[0] && ow[0].end) || '' },
              { start: (ow[1] && ow[1].start) || '', end: (ow[1] && ow[1].end) || '' }
            ],
            // 「折」口径；0 = 留空（回退全局）
            offpeak_discount: m.offpeak_discount ? m.offpeak_discount : ''
          },
          saving: false,
          testing: false,
          testResult: null,
          error: ''
        };
      },
  computed: {
    isCreate: function() { return !this.model; },
    hasKey: function() { return !!(this.model && this.model.has_api_key); },
    maskedKey: function() { return (this.model && this.model.api_key_masked) || ''; },
    // 默认模型 = 全站计费基准：编辑页只出基准单价，倍率恒 ×1
    isDefault: function() { return !!(this.model && this.model.is_default === 1); },
    // 当前选中的源（用于把"连接信息从哪来"讲清楚）
    selectedSource: function() {
      var self = this;
      if (!this.form.source_id) return null;
      for (var i = 0; i < this.sources.length; i++) {
        if (this.sources[i].id === self.form.source_id) return this.sources[i];
      }
      return null;
    },
    selectedSourceLabel: function() {
      return this.form.source_id ? ((this.selectedSource && (this.selectedSource.label || this.selectedSource.id)) || this.form.source_id) : '';
    },
    selectedSourceUrl: function() { return (this.selectedSource && this.selectedSource.api_url) || ''; },
    selectedSourceHasKey: function() { return !!(this.selectedSource && this.selectedSource.has_api_key); },
    selectedSourceDisabled: function() { return !!(this.selectedSource && !this.selectedSource.enabled); },
    // 全局默认峰谷的一句话说明（放在「留空 = 全局」旁边，省得管理员来回翻）
    globalOffpeakText: function() {
      var g = this.globalOffpeak;
      if (!g || !g.enabled) return '当前全局峰谷已关闭';
      var ws = (g.peak_windows || []).map(function(w) { return w.start + '–' + w.end; }).join('、');
      return (ws || '未配置峰时段') + '，' + (g.discount || 5) + ' 折';
    }
  },
  methods: {
    buildPayload: function() {
      var f = this.form;
      var payload = {
        label: f.label.trim(),
        source_id: f.source_id || '',
        model_name: f.model_name.trim(),
        // 倍率与限免**始终**上报：留空 / 恢复 1 也必须让服务端知道（否则清不掉）
        // datetime-local 值无时区语义，按浏览器本地时区转 UTC ISO 再上传
        free_until: f.free_until_local ? new Date(f.free_until_local).toISOString() : '',
        enabled: f.enabled,
        is_free: f.is_free,
        supports_stream: f.supports_stream,
        supports_vision: f.supports_vision,
        supports_thinking: f.supports_thinking,
        vision_max_images: Number(f.vision_max_images) || 0,
        has_offpeak: f.has_offpeak
      };

      // 挂了源的模型：地址与密钥由源提供，不上报自身字段（避免与源打架）
      if (!f.source_id) payload.api_url = f.api_url.trim();

      // 峰谷：不参与时显式清空（[] + 0 = 回退全局，语义与"没配"区分开）
      if (f.has_offpeak) {
        var wins = [];
        for (var i = 0; i < f.offpeak_windows.length; i++) {
          var s = String(f.offpeak_windows[i].start || '').trim();
          var e = String(f.offpeak_windows[i].end || '').trim();
          if (s || e) wins.push({ start: s, end: e });
        }
        payload.offpeak_peak_windows = wins;
        payload.offpeak_discount = Number(f.offpeak_discount) || 0;
      } else {
        payload.offpeak_peak_windows = [];
        payload.offpeak_discount = 0;
      }

      if (this.isDefault) {
        // 基准模型：三个单价就是全站锚点（表单元口径 → 库存微元/千，×1000）；
        // 倍率强制 ×1（计费侧同样强制，双保险）
        payload.price_in = yuanPerMToMicro(f.price_in);
        payload.price_out = yuanPerMToMicro(f.price_out);
        payload.price_cache_hit = yuanPerMToMicro(f.price_cache_hit);
        payload.price_multiplier = 1;
      } else {
        // 非默认模型：倍率是唯一价格杠杆，单价字段不上报（计费已不读它们）
        payload.price_multiplier = Number(f.price_multiplier) || 1;
      }
      // 编辑时留空表示不修改 Key；新增时必须带上（哪怕为空，由后端校验可用性）
      // 挂源时也不上报：连接信息整份交给源
      if (!f.source_id && (f.api_key.trim() || this.isCreate)) payload.api_key = f.api_key.trim();
      if (this.isCreate) payload.id = f.id.trim();
      return payload;
    },

    save: function() {
      var self = this;
      this.error = '';

      if (this.isCreate && !this.form.id.trim()) {
        this.error = '请填写模型 ID';
        return;
      }
      if (!this.form.label.trim()) {
        this.error = '请填写显示名称';
        return;
      }

      this.saving = true;
      var payload = this.buildPayload();
      var req = this.isCreate
        ? this.$http.post('/admin/models', payload)
        : this.$http.put('/admin/models/' + this.model.id, payload);

      req.then(function(r) {
        if (r.data.code !== 200) {
          self.error = r.data.message || '保存失败';
          return;
        }
        self.$store.dispatch('toast', { message: r.data.message || '已保存', type: 'success' });
        self.$emit('saved');
        self.$emit('close');
      }).catch(function(err) {
        self.error = err.message || '保存失败';
      }).then(function() {
        self.saving = false;
      });
    },

    test: function() {
      var self = this;
      this.testing = true;
      this.testResult = null;
      this.$http.post('/admin/models/' + this.model.id + '/test', {}, { timeout: 40000 })
        .then(function(r) { self.testResult = r.data.data; })
        .catch(function(err) { self.testResult = { ok: false, error: err.message || '测试失败', elapsed_ms: 0 }; })
        .then(function() { self.testing = false; });
    }
  }
};
</script>

<style scoped>
.modal-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 350;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--gap-lg);
  background: var(--mask);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}

.modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 540px;
  max-height: 90vh;
  padding: 24px;
  border-radius: var(--radius-xl);
}

.modal-title {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}

.modal-sub {
  margin: 0 0 var(--gap-md);
  line-height: 1.5;
}

.modal-sub code {
  padding: 1px 5px;
  border-radius: var(--radius-2xs);
  background: var(--ink-2);
  font-size: 11.5px;
}

.form-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -6px;
  padding: 0 6px;
}

.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.base-note {
  margin: -6px 0 var(--gap-md);
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  line-height: 1.5;
}

/* 挂源时替代地址/密钥输入框的说明块：位置与高度对齐上面的 field，避免表单跳动 */
.inherited-note {
  margin: 0 0 var(--gap-sm);
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  line-height: 1.6;
  word-break: break-all;
}

.price-note {
  margin: -6px 0 var(--gap-md);
  line-height: 1.5;
}

.switch-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin-bottom: var(--gap-md);
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
}
html.no-flex-gap .switch-list > * + * {
  margin-top: 9px;
}






.switch-row {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
}
html.no-flex-gap .switch-row > * + * {
  margin-left: 9px;
}






.switch-row input {
  margin-top: 3px;
  flex-shrink: 0;
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: var(--gap-md);
  padding-top: var(--gap-md);
  border-top: 1px solid var(--ink-2);
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
}






.spacer {
  flex: 1;
}

@media (max-width: 600px) {
  .modal-mask {
    padding: 0;
    align-items: flex-end;
  }

  .modal {
    max-height: 94vh;
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }

  .row-3 {
    grid-template-columns: 1fr;
    gap: 0;
  }
}
</style>
