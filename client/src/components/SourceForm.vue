<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal glass">
      <h3 class="modal-title">{{ isCreate ? '新增模型源' : '编辑模型源 · ' + form.label }}</h3>
      <p class="modal-sub tiny muted">
        把地址与密钥放在「源」上，多个模型可共享 —— 上游换域名 / 换密钥时只改这里一处。
        不挂源的模型继续用它们自己的地址与密钥，不受影响。
      </p>

      <div class="form-scroll">
        <label class="field">
          <span class="field-label">源 ID（唯一标识，创建后不可改）</span>
          <input
            v-model="form.id"
            class="input"
            type="text"
            :disabled="!isCreate"
            placeholder="如 deepseek-official"
          />
        </label>

        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="form.label" class="input" type="text" placeholder="如 DeepSeek 官方" />
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
          <span class="field-label">接口风格</span>
          <select v-model="form.api_style" class="input">
            <option value="openai">OpenAI 兼容（默认）</option>
            <option value="deepseek">DeepSeek</option>
          </select>
        </label>

        <div class="switch-list">
          <label class="switch-row">
            <input type="checkbox" v-model="form.enabled" />
            <span>启用该源（停用后挂在它上面的模型全部不可用）</span>
          </label>
        </div>

        <div v-if="error" class="alert alert-danger">{{ error }}</div>
      </div>

      <div class="modal-actions">
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

// 模型源编辑弹窗（迁移 022）：一个上游常一次提供多个模型，地址/密钥放这里共享
export default {
  name: 'SourceForm',
  // Esc 关闭：与 AiPrefs 等表单弹窗保持一致（按 Esc = 点「取消」）
  mixins: [modalEsc],
  props: {
    // 传入则为编辑，否则新增
    source: { type: Object, default: null }
  },
  data: function() {
    var s = this.source || {};
    return {
      form: {
        id: s.id || '',
        label: s.label || '',
        api_url: s.api_url || '',
        api_key: '',
        api_style: s.api_style || 'openai',
        enabled: s.enabled === undefined ? true : s.enabled === 1
      },
      saving: false,
      error: ''
    };
  },
  computed: {
    isCreate: function() { return !this.source; },
    hasKey: function() { return !!(this.source && this.source.has_api_key); },
    maskedKey: function() { return (this.source && this.source.api_key_masked) || ''; }
  },
  methods: {
    save: function() {
      var self = this;
      this.error = '';

      if (this.isCreate && !this.form.id.trim()) {
        this.error = '请填写源 ID';
        return;
      }
      if (!this.form.label.trim()) {
        this.error = '请填写显示名称';
        return;
      }
      if (!this.form.api_url.trim()) {
        this.error = '请填写 API 地址';
        return;
      }

      var payload = {
        label: this.form.label.trim(),
        api_url: this.form.api_url.trim(),
        api_style: this.form.api_style,
        enabled: this.form.enabled
      };
      // 留空 = 不修改 Key（只改地址时不该把 Key 清掉）；新增时必带
      if (this.form.api_key.trim() || this.isCreate) payload.api_key = this.form.api_key.trim();
      if (this.isCreate) payload.id = this.form.id.trim();

      this.saving = true;
      var req = this.isCreate
        ? this.$http.post('/admin/sources', payload)
        : this.$http.put('/admin/sources/' + this.source.id, payload);

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
  max-width: 520px;
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

.form-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  margin: 0 -6px;
  padding: 0 6px;
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
}
</style>
