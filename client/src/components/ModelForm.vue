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

        <label class="field">
          <span class="field-label">上游模型名（留空则用模型 ID）</span>
          <input v-model="form.model_name" class="input" type="text" placeholder="如 deepseek-chat" />
        </label>

        <div class="row-3">
          <label class="field">
            <span class="field-label">输入单价</span>
            <input v-model="form.price_in" class="input" type="number" min="0" step="0.01" />
          </label>
          <label class="field">
            <span class="field-label">输出单价</span>
            <input v-model="form.price_out" class="input" type="number" min="0" step="0.01" />
          </label>
          <label class="field">
            <span class="field-label">缓存命中</span>
            <input v-model="form.price_cache_hit" class="input" type="number" min="0" step="0.01" />
          </label>
        </div>

        <p class="price-note tiny muted">
          单位「元 / 百万 token」（如输入 2 表示 2 元/百万）。填写的价格会直接决定学生扣费。
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
        </div>

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
// 模型编辑弹窗
export default {
  name: 'ModelForm',
  props: {
    // 传入则为编辑，否则新增
    model: { type: Object, default: null }
  },
  data: function() {
    var m = this.model || {};
    return {
      form: {
        id: m.id || '',
        label: m.label || '',
        api_url: m.api_url || '',
        api_key: '',
        model_name: m.model_name || '',
        price_in: m.price_in === undefined ? 0 : m.price_in,
        price_out: m.price_out === undefined ? 0 : m.price_out,
        price_cache_hit: m.price_cache_hit === undefined ? 0 : m.price_cache_hit,
        enabled: m.enabled === undefined ? true : m.enabled === 1,
        is_free: m.is_free === 1,
        supports_stream: m.supports_stream === undefined ? true : m.supports_stream === 1,
        supports_vision: m.supports_vision === 1,
        vision_max_images: m.vision_max_images === undefined ? 0 : m.vision_max_images
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
    maskedKey: function() { return (this.model && this.model.api_key_masked) || ''; }
  },
  methods: {
    buildPayload: function() {
      var f = this.form;
      var payload = {
        label: f.label.trim(),
        api_url: f.api_url.trim(),
        model_name: f.model_name.trim(),
        price_in: Number(f.price_in) || 0,
        price_out: Number(f.price_out) || 0,
        price_cache_hit: Number(f.price_cache_hit) || 0,
        enabled: f.enabled,
        is_free: f.is_free,
        supports_stream: f.supports_stream,
        supports_vision: f.supports_vision,
        vision_max_images: Number(f.vision_max_images) || 0
      };
      // 编辑时留空表示不修改 Key；新增时必须带上（哪怕为空，由后端校验可用性）
      if (f.api_key.trim() || this.isCreate) payload.api_key = f.api_key.trim();
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
