<template>
  <div class="cloud-picker-overlay" @click.self="$emit('close')">
    <div class="cloud-picker-sheet">
      <div class="picker-header">
        <span>选择云盘文件</span>
        <div class="picker-header-actions">
          <button class="picker-fullscreen-btn" @click="openFullscreen" title="全屏浏览" aria-label="全屏浏览">
            <i class="fa-solid fa-expand" aria-hidden="true"></i>
          </button>
          <!-- aria-label 必须给：按钮内容是一个空的 <i> 图标，
               不给的话可访问名称是空的，读屏只会念出一个"按钮" -->
          <button class="picker-close" @click="$emit('close')" title="关闭" aria-label="关闭">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </div>
      <div class="picker-search">
        <i class="fa-solid fa-magnifying-glass picker-search-icon"></i>
        <input v-model="searchQuery" class="picker-search-input" placeholder="搜索文件..." />
      </div>
      <div class="picker-tabs">
        <button class="picker-tab" :class="{ active: mediaFilter === 'all' }" @click="mediaFilter = 'all'">全部</button>
        <button class="picker-tab" :class="{ active: mediaFilter === 'image' }" @click="mediaFilter = 'image'"><i class="fa-solid fa-image"></i> 图片</button>
        <button class="picker-tab" :class="{ active: mediaFilter === 'video' }" @click="mediaFilter = 'video'"><i class="fa-solid fa-video"></i> 视频</button>
        <button class="picker-tab" :class="{ active: mediaFilter === 'audio' }" @click="mediaFilter = 'audio'"><i class="fa-solid fa-music"></i> 音频</button>
      </div>
      <div v-if="folders.length > 0" class="picker-folder-tabs">
        <button class="picker-folder-tab" :class="{ active: folderFilter === 'all' }" @click="folderFilter = 'all'">全部分组</button>
        <button class="picker-folder-tab" :class="{ active: folderFilter === '__root__' }" @click="folderFilter = '__root__'">未分组</button>
        <button
          v-for="f in folders"
          :key="f.id"
          class="picker-folder-tab"
          :class="{ active: folderFilter === f.name }"
          @click="folderFilter = f.name"
        >{{ f.name }}</button>
      </div>
      <div class="picker-content">
        <div v-if="loading" class="picker-loading">
          <i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>
          <span>加载中...</span>
        </div>
        <!-- ⚠️ 失败态必须排在空态**之前**。
             原来这里是 loading → 空 → 列表，而请求失败时 files 停在初始的 []，
             于是屏幕上显示的是「云盘无文件」—— 学生以为自己的文件丢了。
             把"加载失败"伪装成"没有数据"是最容易误导人的一种错误处理：
             它让学生去怀疑数据本身，而不是去检查网络。
             排序即优先级：先告诉他真实发生了什么，再给一条重试的路。 -->
        <div v-else-if="loadError" class="picker-empty">
          <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
          <span>加载失败，请检查网络后重试</span>
          <button type="button" class="picker-retry-btn" @click="loadFiles">重试</button>
        </div>
        <div v-else-if="filteredFiles.length === 0" class="picker-empty">
          <i class="fa-solid fa-cloud" aria-hidden="true"></i>
          <span>{{ searchQuery ? '无匹配文件' : '云盘无文件' }}</span>
        </div>
        <div v-else class="picker-grid">
          <!-- 格子是选中文件的唯一入口：补 keyboard 可达（同其他列表项） -->
          <div
            v-for="file in filteredFiles"
            :key="file.hash || file.name"
            class="picker-item"
            role="button"
            tabindex="0"
            :aria-label="'选择文件：' + (file.display_name || file.name)"
            @click="selectFile(file)"
            @keydown.enter.self="selectFile(file)"
            @keydown.space.self.prevent="selectFile(file)"
          >
            <img v-if="getFileType(file) === 'image'" :src="file.url + '?w=300'" :alt="file.name" loading="lazy" class="picker-img" />
            <div v-else-if="getFileType(file) === 'video'" class="picker-icon-card">
              <span class="picker-icon-card-inner"><i class="fa-solid fa-video"></i></span>
            </div>
            <div v-else-if="getFileType(file) === 'audio'" class="picker-icon-card picker-audio-card">
              <span class="picker-icon-card-inner"><i class="fa-solid fa-music"></i></span>
            </div>
            <div class="picker-name">{{ file.display_name || file.name }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from '@/utils/api';
import modalEsc from '@/mixins/modal-esc';

export default {
  name: 'CloudImagePicker',
  // Esc 关闭（组件由 v-if 控制，存在即打开，见 mixin 说明）
  mixins: [modalEsc],
  data: function() {
    return {
      files: [],
      folders: [],
      loading: true,
      // 加载失败标记。与 loading 分开存：loading 结束不代表成功，
      // 而"失败"与"真的没有文件"在界面上必须是两种不同的呈现（见模板）。
      loadError: false,
      searchQuery: '',
      mediaFilter: 'all',
      folderFilter: 'all'
    };
  },
  computed: {
    filteredFiles: function() {
      var self = this;
      var result = self.files;
      // 分组筛选
      if (self.folderFilter === '__root__') {
        result = result.filter(function(f) { return !f.folder; });
      } else if (self.folderFilter !== 'all') {
        result = result.filter(function(f) { return f.folder === self.folderFilter; });
      }
      // 类型筛选
      if (self.mediaFilter !== 'all') {
        result = result.filter(function(file) {
          return self.getFileType(file) === self.mediaFilter;
        });
      }
      // 搜索筛选
      if (self.searchQuery) {
        var query = self.searchQuery.toLowerCase();
        result = result.filter(function(file) {
          var searchName = (file.display_name || file.name || '').toLowerCase();
          return searchName.indexOf(query) > -1;
        });
      }
      return result;
    }
  },
  watch: {
    folderFilter: function() {
      this.loadFiles();
    }
  },
  mounted: function() {
    this.loadFolders();
    this.loadFiles();
  },
  methods: {
    loadFolders: function() {
      var self = this;
      api.get('/cloud/folders').then(function(res) {
        var data = res.data && res.data.data;
        self.folders = (data && data.folders) || [];
      }).catch(function() {});
    },
    loadFiles: function() {
      var self = this;
      self.loading = true;
      // 每次重试先清掉上一次的失败标记，否则重试成功后错误态会残留
      self.loadError = false;
      var params = {};
      // 选择具体分组时，传 folder 参数让服务端绕过 hide_from_all 限制
      if (self.folderFilter !== 'all') {
        params.folder = self.folderFilter;
      }
      api.get('/cloud/files', { params: params }).then(function(res) {
        self.files = res.data.data.files || [];
        self.loading = false;
      }).catch(function(err) {
        console.error('加载云盘文件失败:', err);
        self.loading = false;
        // 必须把"失败"标出来。只 toast 是不够的：toast 几秒后消失，
        // 而列表留在空态上，学生回头看到的就是"我的云盘是空的"。
        self.loadError = true;
        self.$store.dispatch('toast', { message: '加载云盘文件失败', type: 'error' });
      });
    },
    getFileType: function(file) {
      // 优先使用服务端返回的 mime_type
      if (file && file.mime_type) {
        if (file.mime_type.indexOf('image/') === 0) return 'image';
        if (file.mime_type.indexOf('video/') === 0) return 'video';
        if (file.mime_type.indexOf('audio/') === 0) return 'audio';
      }
      // 回退到文件名解析
      var name = (file && (file.name || file.display_name)) || '';
      var lower = name.toLowerCase();
      var VID_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.3gp'];
      var AUD_EXTS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus'];
      var IMG_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      if (lower.indexOf('__audio') > -1) return 'audio';
      if (lower.indexOf('__video') > -1) return 'video';
      if (lower.indexOf('__image') > -1) return 'image';
      for (var v = 0; v < VID_EXTS.length; v++) { if (lower.indexOf(VID_EXTS[v]) > -1) return 'video'; }
      for (var a = 0; a < AUD_EXTS.length; a++) { if (lower.indexOf(AUD_EXTS[a]) > -1) return 'audio'; }
      for (var i = 0; i < IMG_EXTS.length; i++) { if (lower.indexOf(IMG_EXTS[i]) > -1) return 'image'; }
      return 'other';
    },
    openFullscreen: function() {
      // 保存父组件 UI 状态，返回时恢复（避免重新挂载后弹窗消失）。
      // 关键：/cloud-picker 是独立路由，而 App.vue 的 router-view 没有 keep-alive，
      // 跳转会把当前应用组件整个卸载，局部 data 全丢。所以这里必须把「回到哪一屏」
      // 全量快照下来——只存弹窗开关会导致返回后掉回默认列表页（帖子详情丢失）。
      var context = {};
      var parent = this.$parent;
      while (parent) {
        if (typeof parent.showPostModal !== 'undefined') context.showPostModal = parent.showPostModal;
        if (typeof parent.commentCloudTarget !== 'undefined') context.commentCloudTarget = parent.commentCloudTarget;
        // 详情页（帖子/会话等）：靠 showFullDetail + 帖子 id 在返回后重开
        if (typeof parent.showFullDetail !== 'undefined') context.showFullDetail = parent.showFullDetail;
        if (typeof parent.currentPostId !== 'undefined') context.currentPostId = parent.currentPostId;
        // 所在 tab 与草稿，避免返回后被打回默认页 / 丢掉已输入内容
        if (typeof parent.activeTab !== 'undefined') context.activeTab = parent.activeTab;
        if (typeof parent.commentText !== 'undefined') context.commentText = parent.commentText;
        if (typeof parent.replyToUser !== 'undefined') context.replyToUser = parent.replyToUser;
        if (parent.newPost && typeof parent.newPost === 'object') {
          try { context.newPost = JSON.parse(JSON.stringify(parent.newPost)); } catch (e) { /* 忽略不可序列化草稿 */ }
        }
        parent = parent.$parent;
      }
      try {
        sessionStorage.setItem('__cloudPickerContext', JSON.stringify(context));
      } catch (e) { /* 忽略写入失败 */ }
      this.$emit('close');
      this.$router.push('/cloud-picker');
    },
    selectFile: function(file) {
      this.$emit('select', file);
      this.$emit('close');
    }
  }
};
</script>

<style scoped>
.cloud-picker-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 10002;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.cloud-picker-sheet {
  background: var(--card-bg);
  width: 100%;
  max-height: 85vh;
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  display: flex;
  flex-direction: column;
  animation: slideUp 0.3s ease;
}

@keyframes slideUp {
  from {
    transform: translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
}

.picker-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
html.no-flex-gap .picker-header-actions > * + * {
  margin-left: 12px;
}

.picker-fullscreen-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 18px;
  padding: 4px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-standard);
  /* 命中区扩到 40px，视觉不变（原理见 styles/global.css「触控命中区」）。
     这是看图时的「全屏浏览」，触屏上属于高频操作。 */
  position: relative;
}

.picker-fullscreen-btn::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: 40px;
  height: 40px;
  transform: translate(-50%, -50%);
  background: transparent;
  z-index: 1;
}

/* :hover 必须收进 @media (hover: hover) —— 触屏上它会「粘住」，
   点完图标颜色一直变着，看起来像坏了。这是项目在 global.css 里立过的规矩。 */
@media (hover: hover) {
.picker-fullscreen-btn:hover { color: var(--primary-color); }
}
.picker-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 20px;
  padding: 4px;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-standard);
}
@media (hover: hover) {
.picker-close:hover {
  color: var(--text-primary);
}
}

.picker-search {
  padding: 12px 20px;
  position: relative;
}

.picker-search-icon {
  position: absolute;
  left: 32px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  font-size: 14px;
}

.picker-search-input {
  width: 100%;
  padding: 10px 12px 10px 36px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--bg-color);
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color var(--duration-fast) var(--ease-standard);
}

.picker-search-input:focus {
  outline: none;
  border-color: var(--primary-color);
}

/* 类型筛选标签 */
.picker-tabs {
  display: flex; gap: 6px; padding: 8px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
html.no-flex-gap .picker-tabs > * + * {
  margin-left: 6px;
}

.picker-tab {
  padding: 6px 12px; border-radius: var(--radius-pill);
  font-size: 12px; color: var(--text-secondary);
  background: var(--bg-color); border: none; cursor: pointer;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}
.picker-tab.active {
  background: var(--primary-color); color: #fff;
}
.picker-tab i { margin-right: 3px; }

/* 分组标签 */
.picker-folder-tabs {
  display: flex; gap: 4px; padding: 6px 20px;
  overflow-x: auto; white-space: nowrap;
  -webkit-overflow-scrolling: touch;
  flex-shrink: 0; min-height: 32px; align-items: center;
}
html.no-flex-gap .picker-folder-tabs > * + * {
  margin-left: 4px;
}

/* 美化分组标签滚动条 */
.picker-folder-tabs::-webkit-scrollbar { height: 3px; }
.picker-folder-tabs::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: var(--radius-pill); }
.picker-folder-tabs::-webkit-scrollbar-track { background: transparent; }
.picker-folder-tab {
  padding: 4px 10px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-tertiary);
  background: transparent; border: 1px solid var(--border-color);
  cursor: pointer; flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);
}
.picker-folder-tab.active {
  background: var(--primary-color); color: #fff;
  border-color: var(--primary-color);
}

/* 视频/音频图标卡片
   注：不用 aspect-ratio（Chrome 88+；本机目标内核含 Chrome 80），
   改用 padding-top 100% 撑出正方形，见 .picker-icon-card-inner */
.picker-icon-card {
  position: relative;
  width: 100%;
  padding-top: 100%;
  border-radius: var(--radius-sm); background: var(--bg-color);
}
.picker-icon-card-inner {
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; color: var(--text-secondary);
}
.picker-audio-card { background: linear-gradient(135deg, rgba(var(--primary-rgb),0.08), rgba(var(--primary-rgb),0.02)); }

.picker-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}

.picker-loading,
.picker-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--text-tertiary);
  font-size: 14px;
}
html.no-flex-gap .picker-loading, .picker-empty > * + * {
  margin-top: 12px;
}


.picker-loading i,
.picker-empty i {
  font-size: 32px;
}

/* 失败态里的重试按钮：触屏命中区撑到 40px（矮了容易点空） */
.picker-retry-btn {
  min-height: 40px;
  padding: 8px 22px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background var(--transition), color var(--transition);
}

@media (hover: hover) {
.picker-retry-btn:hover {
  background: var(--accent);
  color: var(--text-invert);
}
}

.picker-retry-btn:active {
  background: var(--accent);
  color: var(--text-invert);
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

@media (min-width: 600px) {
  .picker-grid { grid-template-columns: repeat(5, 1fr); }
}
@media (min-width: 900px) {
  .picker-grid { grid-template-columns: repeat(6, 1fr); }
}

.picker-item {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-md);
  background: var(--bg-color);
  overflow: hidden;
  cursor: pointer;
  transition: transform var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.picker-item:hover {
  transform: scale(1.02);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
}

.picker-img {
  width: 100%;
  height: 80px;
  object-fit: cover;
  background: var(--border-color);
}

.picker-name {
  padding: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
</style>