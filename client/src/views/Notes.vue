<template>
  <div class="notes-page">
    <!-- 全站统一顶栏：品牌 + 七入口导航 + 头像菜单（与其余六页一致） -->
    <AppNav active="notes" :show-menu-button="useDrawer" @toggle-sidebar="toggleDrawer" />

    <transition name="fade">
      <div v-if="drawerOpen" class="app-drawer-mask" @click="closeDrawer"></div>
    </transition>

    <!-- 笔记页自己的动作放页面工具栏；顶栏只承担全站导航 -->
    <div class="notes-toolbar glass">
      <div class="toolbar-left">
        <!-- 文件栏开关：竖屏抽屉模式下由顶栏的菜单按钮负责，这里只在常驻模式下出现 -->
        <button
          v-if="!useDrawer"
          class="icon-btn"
          :title="sidebarHidden ? '显示文件栏' : '隐藏文件栏'"
          @click="toggleSidebar"
        >
          <i class="fa-solid fa-table-columns"></i>
        </button>
        <div class="nav-create-dropdown">
          <button class="btn btn-sm btn-primary" @click="showCreateMenu = !showCreateMenu" title="新建">
            <i class="fa-solid fa-plus"></i><span>新建</span>
          </button>
          <transition name="dropdown-fade">
            <div v-if="showCreateMenu" class="create-menu">
              <button class="create-menu-item" @click="createNoteFile(); showCreateMenu = false">
                <i class="fa-regular fa-note-sticky"></i>
                <span>新建笔记</span>
              </button>
              <button class="create-menu-item" @click="createDrawFile(); showCreateMenu = false">
                <i class="fa-solid fa-palette"></i>
                <span>新建画板</span>
              </button>
            </div>
          </transition>
        </div>
        <button class="btn btn-sm btn-ghost" @click="openResourcePicker" title="从云盘导入">
          <i class="fa-solid fa-file-import"></i><span>导入</span>
        </button>
        <button
          v-if="isDrawFile && activeFile"
          class="btn btn-sm btn-ghost"
          @click="uploadToCloud"
          :disabled="cloudSyncing"
          :title="cloudSyncing ? '同步中...' : '上传到云端'"
        >
          <i :class="cloudSyncing ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-cloud-arrow-up'"></i><span>上传云端</span>
        </button>
      </div>
      <div class="toolbar-right">
        <!-- 当前文件的一排操作（标签 / 批注 / 版本历史 / 上传云端 / AI 辅助）。
             原来这排按钮在编辑区标题栏里，占掉一整行；而那一行除了它们
             只剩一句「创建于 …」。搬到这一栏有两个好处：
               · 编辑区顶部省下一行，正文起始位置更高；
               · 「对这一个文件做什么」和「怎么看」放在同一处，
                 都是对当前文件生效的视图级操作，不必上下找。 -->
        <div v-if="activeFile && !isDrawFile" class="file-actions">
          <button class="editor-tag-btn" @click="showTagModal = true" title="管理标签">
            <i class="fa-solid fa-tags"></i>
          </button>
          <button
            class="editor-tag-btn"
            @click="startAnnotation"
            title="批注"
            v-if="viewMode === 'edit' || viewMode === 'split'"
          >
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button class="editor-tag-btn" @click="showVersionHistory = true" title="版本历史">
            <i class="fa-solid fa-clock-rotate-left"></i>
          </button>
          <button
            class="editor-tag-btn"
            @click="uploadToCloud"
            title="上传到云端"
            v-if="!activeFile.isPrivate"
            :disabled="cloudSyncing"
          >
            <i class="fa-solid fa-cloud-arrow-up" :class="{ 'fa-spin': cloudSyncing }"></i>
          </button>
          <!-- AI 辅助（Cluss 特有）：整理 / 续写 / 提炼，会引用相关历史笔记与当前内容 -->
          <div class="assist-dropdown-wrap">
            <button class="editor-tag-btn" :disabled="assisting || !(activeFile.content && activeFile.content.trim())"
              @click="assistMenuOpen = !assistMenuOpen" title="让 AI 帮我把这篇整理/续写/提炼">
              <i :class="assisting ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-wand-magic-sparkles'"></i>
            </button>
            <transition name="dropdown-fade">
              <div v-if="assistMenuOpen" class="assist-menu">
                <button class="assist-menu-item" @click="runAssist('organize')">整理这篇</button>
                <button class="assist-menu-item" @click="runAssist('continue')">接着往下写</button>
                <button class="assist-menu-item" @click="runAssist('summarize')">提炼关键结论</button>
                <!-- 花积分之前让人看一眼余额：点不点得起在点之前就知道，而不是等 402 -->
                <div class="assist-menu-foot">
                  <span>AI 辅助消耗积分</span>
                  <span class="assist-balance" :class="{ 'is-empty': walletExhausted }">{{ walletLabel }}</span>
                </div>
              </div>
            </transition>
          </div>
        </div>
        <Segmented v-if="!isDrawFile" v-model="viewMode" :options="viewModeOptions" />
      </div>
    </div>

    <!-- ========== 画板文件：全屏 DrawCanvas ========== -->
    <div class="draw-body" v-if="isDrawFile && activeFile" :key="'draw_' + activeFileId">
      <DrawCanvas
        ref="drawCanvas"
        mode="full"
        :initialLayers="activeFile.canvasData || []"
        :showCloudUpload="!activeFile.isPrivate"
        :cloudSyncing="cloudSyncing"
        @save="onDrawSave"
        @close="exitDrawFile"
        @upload-to-cloud="uploadToCloud"
      />
    </div>
    <div class="draw-body draw-body--empty" v-else-if="isDrawFile && !activeFile">
      <div class="draw-empty-state">
        <i class="fa-solid fa-palette draw-empty-icon"></i>
        <h3>选择或新建画板文件</h3>
        <p>在左侧选择一个画板文件，或新建一个开始创作</p>
        <button class="btn btn-primary" @click="createDrawFile">
          <i class="fa-solid fa-plus"></i> 新建画板
        </button>
      </div>
    </div>

    <!-- ========== 笔记文件：正常笔记 UI ========== -->
    <div class="notes-body" v-if="!isDrawFile" :class="{ 'is-portrait': isPortrait, 'use-drawer': useDrawer, 'sidebar-hidden': sidebarHidden }">
      <transition name="fade">
        <aside
          v-show="!useDrawer || drawerOpen"
          class="notes-sidebar app-sidebar-drawer"
          :class="{ 'is-open': drawerOpen }"
          :style="drawerStyle"
        >
          <div class="sidebar-top glass sidebar-card">
            <div class="sidebar-search">
              <i class="fa-solid fa-magnifying-glass sidebar-search-icon"></i>
              <input
                v-model="searchInput"
                type="text"
                placeholder="搜索笔记..."
                class="sidebar-search-input"
              />
            </div>
            <!-- 排序按钮从「文件夹」那一行挪到这里。
                 原来一行 204px 要塞「文件夹下拉 + 新建文件夹 + 排序下拉」，
                 两个下拉各分到 85px，而全局 select 的箭头内缩就吃掉 34px ——
                 只剩 43px 显示文字，实测截成「全部…」「按时…」，
                 连「我在哪个文件夹」「按什么排序」都看不全。
                 现在排序变成 44px 图标按钮 + 菜单，文件夹那行把宽度全让出来。 -->
            <div class="sort-wrap">
              <button
                class="sort-btn"
                :class="{ 'is-active': sortMenuOpen || sortBy !== 'updatedAt' }"
                :aria-label="'排序：' + sortLabel"
                aria-haspopup="true"
                :aria-expanded="sortMenuOpen ? 'true' : 'false'"
                @click="toggleSortMenu"
              >
                <i class="fa-solid fa-arrow-down-wide-short"></i>
              </button>
              <transition name="dropdown-fade">
                <div v-if="sortMenuOpen" class="sort-menu" role="menu">
                  <button
                    v-for="opt in sortOptions"
                    :key="opt.value"
                    class="sort-menu-item"
                    :class="{ 'is-active': sortBy === opt.value }"
                    role="menuitemradio"
                    :aria-checked="sortBy === opt.value ? 'true' : 'false'"
                    @click="pickSort(opt.value)"
                  >
                    <span>{{ opt.label }}</span>
                    <i v-if="sortBy === opt.value" class="fa-solid fa-check"></i>
                  </button>
                </div>
              </transition>
            </div>
          </div>

          <!-- 文件夹下拉带篇数：不然新建一个文件夹切进去是空的，
               分不清「刚建还没放东西」和「功能坏了」 -->
          <div class="folder-bar glass sidebar-card">
            <select v-model="activeFolder" class="folder-select">
              <option v-for="f in folders" :key="f" :value="f">{{ f }}（{{ folderCounts[f] || 0 }}）</option>
            </select>
            <button class="folder-add-btn" @click="addFolder" title="新建文件夹"><i class="fa-solid fa-folder-plus"></i></button>
          </div>

          <div v-if="tagFilter" class="tag-filter-bar">
            <span class="tag-filter-label">筛选: {{ tagFilter }}</span>
            <button class="tag-filter-clear" @click="tagFilter = ''">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div class="sidebar-file-list sidebar-file-card glass scrollbar-thin" :class="{ 'has-vlist': filteredFiles.length > 30 }">
            <!--
              虚拟滚动：只渲染可视区附近的条目。

              为什么必须做：实测 60 篇笔记时，切入本页**每次**都要付
              75~87ms 的主线程阻塞（不是一次性）—— 全量渲染会产生
              1621 个 DOM 节点与 726 个事件监听器，每次进出都要
              创建再销毁一遍。用久了有几百篇笔记时更糟。

              为什么不用现成库：项目基线是 Chrome 80 / Android 9 / 微信 X5，
              引库要额外做兼容与降级，而这里的核心逻辑只有几十行。

              条目高度是变的（带标签 93px / 不带 69px），所以用
              VirtualList 的「实测均值 + 自适应修正」而非定高方案 ——
              定高会让滚动位置越滚越偏。
            -->
            <VirtualList
              v-if="filteredFiles.length > 0"
              ref="fileList"
              class="file-list-virtual"
              :items="filteredFiles"
              :avg-item-height="81"
              :overscan="6"
              :threshold="30"
            >
              <template slot-scope="{ items }">
                <div
                  v-for="file in items"
                  :key="file.id"
                  class="file-item"
                  :class="{ active: activeFileId === file.id }"
                  @click="selectFile(file.id)"
                  @contextmenu.prevent="showFileMenu($event, file)"
                >
                  <div class="file-item-main">
                    <div class="file-item-title">
                      <i v-if="file.type === 'draw'" class="fa-solid fa-palette file-type-icon draw-type" title="画板文件"></i>
                      <i v-else class="fa-regular fa-note-sticky file-type-icon note-type" title="笔记文件"></i>
                      <span v-html="highlightSearch(file.title || '未命名笔记')"></span>
                    </div>
                    <div class="file-item-meta">
                      <i v-if="file.pinned" class="fa-solid fa-thumbtack file-badge-icon" title="已置顶"></i>
                      <i v-if="file.starred" class="fa-solid fa-star file-badge-icon starred" title="已收藏"></i>
                      <i v-if="file.cloudSynced" class="fa-solid fa-cloud file-badge-icon" :title="file.cloudVisibility === 'public' ? '已同步(公开)' : '已同步(私密)'" :style="{ color: file.cloudVisibility === 'public' ? 'var(--success)' : 'var(--accent)' }"></i>
                      <span class="file-item-date">{{ formatDate(file.updatedAt) }}</span>
                    </div>
                  </div>
                  <div v-if="file.tags && file.tags.length" class="file-item-tags">
                    <span
                      v-for="tag in file.tags.slice(0, 3)"
                      :key="tag"
                      class="file-tag"
                      @click.stop="tagFilter = tag"
                    >{{ tag }}</span>
                  </div>
                </div>
              </template>
            </VirtualList>
            <div v-else class="sidebar-empty">
              <i class="fa-regular fa-note-sticky"></i>
              <span>{{ searchQuery || tagFilter ? '无匹配笔记' : '暂无笔记' }}</span>
            </div>
          </div>

          <div class="sidebar-bottom glass sidebar-card">
            <button class="sidebar-entry" @click="showCloudPanel = true" title="云端笔记">
              <i class="fa-solid fa-cloud"></i>
              <span>云端笔记</span>
            </button>
            <button class="privacy-entry" @click="openPrivacySpace">
              <i class="fa-solid fa-lock"></i>
              <span>隐私空间</span>
            </button>
          </div>
        </aside>
      </transition>

      <div class="notes-main">
        <div v-if="activeFile" class="editor-area" :style="editorAreaStyle">
          <!-- 标题与「创建于」同一行：这一行以前是「标题」+「创建于 …」+「一排按钮」两行，
             按钮搬到页面工具栏后这里只剩两者，齐平放一排，编辑区顶部直接省下一行。 -->
          <div class="editor-header">
            <input
              v-model="activeFile.title"
              class="editor-title-input"
              placeholder="笔记标题"
              @input="onFileChange"
            />
            <span class="editor-date">创建于 {{ formatDate(activeFile.createdAt) }}</span>
          </div>

          <!-- 格式工具栏
               原来 24 个 44px 按钮排成**一行不换行**（nowrap + overflow-x:auto，
               而滚动条又被隐藏），实测在 1440 宽下编辑区只有 564px —— 一行要 1165px，
               **13 个按钮被静默裁掉**，平板横屏更只剩 7 个能看见，且没有任何可横拖的提示。
               现在：常驻只留每天真用得上的 13 个，公式 / 图表 / 命令面板收进「更多」，
               并且允许换行 —— 宁可多占一行，也不能再有够不到的按钮。 -->
          <div v-if="viewMode !== 'preview'" class="editor-toolbar">
            <!-- 按语义分组：字形 / 标题 / 列表 / 插入 / 更多。
                 以前用一个 1px 的竖线当分隔符，而工具栏是 flex-wrap 的 ——
                 折行时最后那条竖线会被单独留在行尾，看起来像一条凭空的刻度；
                 分组之后折行只会发生在组之间，竖线也就没必要存在了。 -->
            <div class="toolbar-group">
            <button class="toolbar-btn" @click="insertMarkdown('bold')" title="加粗 (Ctrl+B)">
              <i class="fa-solid fa-bold"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('italic')" title="斜体 (Ctrl+I)">
              <i class="fa-solid fa-italic"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('strikethrough')" title="删除线">
              <i class="fa-solid fa-strikethrough"></i>
            </button>
            </div>
            <div class="toolbar-group">
            <button class="toolbar-btn" @click="insertMarkdown('h1')" title="一级标题">
              <i class="fa-solid fa-heading"></i><span class="toolbar-sub">1</span>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('h2')" title="二级标题">
              <i class="fa-solid fa-heading"></i><span class="toolbar-sub">2</span>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('h3')" title="三级标题">
              <i class="fa-solid fa-heading"></i><span class="toolbar-sub">3</span>
            </button>
            </div>
            <div class="toolbar-group">
            <button class="toolbar-btn" @click="insertMarkdown('ul')" title="无序列表">
              <i class="fa-solid fa-list-ul"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('ol')" title="有序列表">
              <i class="fa-solid fa-list-ol"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('todo')" title="待办事项">
              <i class="fa-solid fa-square-check"></i>
            </button>
            </div>
            <div class="toolbar-group">
            <button class="toolbar-btn" @click="insertMarkdown('code')" title="行内代码">
              <i class="fa-solid fa-code"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('quote')" title="引用">
              <i class="fa-solid fa-quote-left"></i>
            </button>
            <button class="toolbar-btn" @click="insertMarkdown('link')" title="链接">
              <i class="fa-solid fa-link"></i>
            </button>
            <button class="toolbar-btn" @click="openCloudImagePicker" title="从云盘插入图片/音视频">
              <i class="fa-solid fa-image"></i>
            </button>
            </div>
            <div class="toolbar-group">

            <!-- 低频能力：一次多点一下，但一个都不丢 -->
            <div class="more-menu-wrap">
              <button
                class="toolbar-btn"
                :class="{ 'is-active': moreMenuOpen }"
                title="更多：代码块 / 表格 / 分割线 / 公式 / 图表 / 命令面板"
                aria-haspopup="true"
                :aria-expanded="moreMenuOpen ? 'true' : 'false'"
                @click="toggleMoreMenu"
              >
                <i class="fa-solid fa-ellipsis"></i>
              </button>
              <transition name="dropdown-fade">
                <div v-if="moreMenuOpen" class="more-menu" role="menu">
                  <button class="more-menu-item" @click="applyMore('codeblock')">
                    <i class="fa-solid fa-file-code"></i><span>代码块</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('table')">
                    <i class="fa-solid fa-table"></i><span>表格</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('hr')">
                    <i class="fa-solid fa-minus"></i><span>分割线</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('annotation')">
                    <i class="fa-solid fa-pen-to-square"></i><span>批注</span>
                  </button>
                  <div class="more-menu-sep"></div>
                  <button class="more-menu-item" @click="applyMore('latex-inline')">
                    <span class="more-menu-latex">∑</span><span>行内公式</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('latex-block')">
                    <span class="more-menu-latex">∑∑</span><span>块级公式</span>
                  </button>
                  <div class="more-menu-sep"></div>
                  <button class="more-menu-item" @click="applyMore('mermaid-flowchart')">
                    <i class="fa-solid fa-diagram-project"></i><span>流程图</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('mermaid-gantt')">
                    <i class="fa-solid fa-bars-staggered"></i><span>甘特图</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('mermaid-mindmap')">
                    <i class="fa-solid fa-sitemap"></i><span>思维导图</span>
                  </button>
                  <button class="more-menu-item" @click="applyMore('mermaid-sequence')">
                    <i class="fa-solid fa-arrow-right-arrow-left"></i><span>序列图</span>
                  </button>
                  <div class="more-menu-sep"></div>
                  <button class="more-menu-item" @click="openCommandPalette">
                    <i class="fa-solid fa-terminal"></i><span>命令面板</span>
                  </button>
                </div>
              </transition>
            </div>
            </div>
          </div>

          <div v-if="viewMode !== 'preview'" class="editor-content">
            <textarea
              ref="editor"
              v-model="activeFile.content"
              class="editor-textarea scrollbar-thin"
              :style="{ fontSize: editorFontSize + 'px' }"
              @input="onFileChange"
              @keydown="onEditorKeydown"
              @scroll="syncScroll"
              spellcheck="false"
              placeholder="开始书写你的灵感..."
            ></textarea>
          </div>

          <!-- 字数与「已保存/编辑中」永远留着（写字的人最常看这两项）；
               其余按重要性在窄屏依次收掉，见 .editor-footer 的 media query -->
          <div v-if="viewMode !== 'preview'" class="editor-footer">
            <span class="footer-stat">中文: {{ chineseCharCount }}</span>
            <span class="footer-stat is-optional-1">英文: {{ englishWordCount }}</span>
            <span class="footer-stat is-optional-2">阅读: {{ readingTime }}</span>
            <span class="footer-stat is-optional-3">字号: {{ editorFontSize }}px</span>
            <span class="footer-stat save-indicator" :class="{ saved: autoSaveIndicator }">
              <i class="fa-solid fa-circle"></i> {{ autoSaveIndicator ? '已保存' : '编辑中' }}
            </span>
          </div>

          <!-- AI 辅助结果：不直接覆盖正文（整理错了没法撤销会很痛），
               先给一块预览区，确认后再「替换正文」或「追加到末尾」。
               生成中也显示这块：边流边出字，而不是空白面板干等。 -->
          <div v-if="assisting || assistResult" class="assist-result">
            <div class="assist-head">
              <span class="assist-label">{{ assisting ? 'AI 生成中…' : 'AI 建议' }}</span>
              <div class="assist-actions">
                <button v-if="assisting" class="assist-act-btn" @click="stopAssist">停止</button>
                <template v-else>
                  <button class="assist-act-btn primary" @click="applyAssist('replace')">替换正文</button>
                  <button class="assist-act-btn" @click="applyAssist('append')">追加到末尾</button>
                  <button class="assist-act-btn" @click="discardAssist">丢弃</button>
                </template>
              </div>
            </div>
            <div v-if="assistHtml" class="assist-body markdown-body" v-html="assistHtml" @click="onMarkdownClick"></div>
            <div v-else-if="assisting" class="assist-waiting">正在思考…</div>
          </div>
        </div>

        <div v-else class="editor-empty">
          <div class="empty-icon">
            <i class="fa-regular fa-note-sticky"></i>
          </div>
          <p class="empty-text">选择或创建一个笔记开始书写</p>
          <button class="btn btn-primary" @click="showTemplatePicker = true">
            <i class="fa-solid fa-plus"></i> 新建笔记
          </button>
        </div>
      <div
        v-if="activeFile && viewMode === 'split'"
        class="editor-resizer"
        @mousedown="startResize"
        @touchstart.prevent="startResize"
      >
        <div class="resizer-line"></div>
      </div>

      <div
        v-if="activeFile && viewMode !== 'edit'"
        class="preview-area"
        :style="previewAreaStyle"
      >
        <div class="preview-header">
          <span class="preview-label">预览</span>
          <button
            v-if="activeFile && activeFile.type !== 'draw'"
            class="preview-anno-toggle"
            :class="{ active: showAnnotationLayer }"
            @click="toggleAnnotationLayer"
            title="在文字上直接批注"
          >
            <i class="fa-solid fa-pen-to-square"></i>
            <span>{{ showAnnotationLayer ? '退出批注' : '批注' }}</span>
          </button>
        </div>
        <!-- 批注输入框 -->
        <div v-if="showAnnotationInput" class="anno-input-bar">
          <input
            id="annotation-inline-input"
            v-model="annotationInput"
            class="anno-input-field"
            placeholder="输入批注内容..."
            @keydown.enter="commitAnnotationCard"
            @keydown.escape="showAnnotationInput = false"
          />
          <button class="btn btn-primary btn-sm" @click="commitAnnotationCard">添加批注</button>
          <button class="btn btn-secondary btn-sm" @click="showAnnotationInput = false">取消</button>
        </div>
        <div class="preview-content-wrap">
          <div
            class="preview-content markdown-body scrollbar-thin"
            ref="previewContainer"
            @scroll="syncPreviewScroll"
            @mouseup="onPreviewTextSelect"
            @touchend="onPreviewTextSelect"
          >
            <div class="preview-content-inner">
              <div class="preview-content-html" v-html="renderedContentHtml" @click="onMarkdownClick"></div>
              <!-- 批注涂鸦层：在滚动内容内部，随内容自然滚动 -->
              <div v-if="showAnnotationLayer" class="annotation-overlay" :class="{ 'annotation-active': annoDrawing }">
                <DrawCanvas
                  ref="annotationCanvas"
                  mode="annotation"
                  :key="'anno_' + activeFileId"
                  :initialLayers="activeFile.canvasData || []"
                  @save="onAnnotationSave"
                  @drawing="annoDrawing = $event"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 结构化批注卡片（在内容下方） -->
        <div v-if="annotationCards.length > 0" class="annotation-cards-section">
          <div class="annotation-cards-label">
            <i class="fa-solid fa-pen-to-square"></i> 批注 ({{ annotationCards.length }})
          </div>
          <div
            v-for="card in annotationCards"
            :key="card.id"
            class="annotation-card"
            :style="{ borderLeftColor: card.color || 'var(--accent)' }"
          >
            <div class="annotation-card-header">
              <span class="annotation-card-time">{{ formatDate(card.createdAt) }}</span>
              <button class="annotation-card-del" @click="deleteAnnotation(card.id)" title="删除批注">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            <div v-if="card.selectedText" class="annotation-card-quote">
              "{{ card.selectedText }}"
            </div>
            <div class="annotation-card-text" v-html="renderAnnotationText(card.text)"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

    <transition name="modal-fade">
      <div v-if="showTemplatePicker" class="modal-overlay" @click.self="showTemplatePicker = false">
        <div class="modal-panel template-modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-wand-magic-sparkles"></i> 选择模板
            </h3>
            <button class="modal-close" @click="showTemplatePicker = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">
            <div class="template-grid">
              <div
                v-for="tpl in noteTemplates"
                :key="tpl.id"
                class="template-card"
                @click="createFileFromTemplate(tpl)"
              >
                <div class="template-icon">
                  <i class="fa-solid" :class="tpl.icon"></i>
                </div>
                <div class="template-name">{{ tpl.name }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showPrivacyModal" class="modal-overlay" @click.self="showPrivacyModal = false">
        <div class="modal-panel privacy-modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-lock"></i> 隐私空间
            </h3>
            <button class="modal-close" @click="showPrivacyModal = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div v-if="!privacyUnlocked" class="modal-body">
            <p class="privacy-hint">请输入密码以访问隐私空间</p>
            <input
              v-model="privacyPasswordInput"
              type="password"
              class="modal-input"
              placeholder="输入密码"
              @keyup.enter="verifyPrivacyPassword"
              ref="privacyInput"
            />
            <div v-if="!hasPrivacyPassword" class="privacy-setup">
              <p class="privacy-hint">首次使用，请设置密码</p>
              <input
                v-model="privacyPasswordConfirm"
                type="password"
                class="modal-input"
                placeholder="确认密码"
                @keyup.enter="verifyPrivacyPassword"
              />
            </div>
            <button class="btn btn-primary modal-btn" @click="verifyPrivacyPassword">
              {{ hasPrivacyPassword ? '解锁' : '设置密码' }}
            </button>
          </div>
          <div v-else class="modal-body privacy-content">
            <div class="privacy-toolbar">
              <button class="btn btn-secondary" @click="createPrivateFile">
                <i class="fa-solid fa-plus"></i> 新建隐私笔记
              </button>
              <button class="btn btn-secondary" @click="moveToPrivate" :disabled="!activeFile || activeFile.isPrivate">
                <i class="fa-solid fa-lock"></i> 移入隐私
              </button>
              <button class="btn btn-secondary" @click="moveToPublic" :disabled="!activeFile || !activeFile.isPrivate">
                <i class="fa-solid fa-lock-open"></i> 移出隐私
              </button>
            </div>
            <div class="privacy-file-list">
              <div
                v-for="file in privateFiles"
                :key="file.id"
                class="file-item"
                :class="{ active: activeFileId === file.id }"
                @click="selectFile(file.id)"
              >
                <div class="file-item-main">
                  <div class="file-item-title">{{ file.title || '未命名笔记' }}</div>
                  <div class="file-item-date">{{ formatDate(file.updatedAt) }}</div>
                </div>
              </div>
              <div v-if="privateFiles.length === 0" class="sidebar-empty">
                <span>暂无隐私笔记</span>
              </div>
            </div>
            <button class="btn btn-secondary modal-btn" @click="lockPrivacySpace">
              <i class="fa-solid fa-lock"></i> 锁定隐私空间
            </button>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showTagModal" class="modal-overlay" @click.self="showTagModal = false">
        <div class="modal-panel tag-modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-tags"></i> 管理标签
            </h3>
            <button class="modal-close" @click="showTagModal = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">
            <div class="tag-input-row">
              <input
                v-model="newTagInput"
                type="text"
                class="modal-input"
                placeholder="输入标签名"
                @keyup.enter="addTag"
              />
              <button class="btn btn-primary" @click="addTag">添加</button>
            </div>
            <div class="tag-list">
              <span
                v-for="tag in allTags"
                :key="tag"
                class="tag-item"
                :class="{ active: activeFile && activeFile.tags.indexOf(tag) > -1 }"
                @click="toggleTag(tag)"
              >{{ tag }}</span>
            </div>
            <div v-if="activeFile" class="current-tags">
              <span class="current-tags-label">当前标签:</span>
              <span
                v-for="tag in activeFile.tags"
                :key="tag"
                class="tag-item active"
                @click="removeTag(tag)"
              >{{ tag }} <i class="fa-solid fa-xmark"></i></span>
              <span v-if="activeFile.tags.length === 0" class="no-tags">无标签</span>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showRenameModal" class="modal-overlay" @click.self="showRenameModal = false">
        <div class="modal-panel">
          <div class="modal-header">
            <h3 class="modal-title">重命名笔记</h3>
            <button class="modal-close" @click="showRenameModal = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">
            <input
              v-model="renameInput"
              type="text"
              class="modal-input"
              placeholder="输入新名称"
              @keyup.enter="confirmRename"
              ref="renameInput"
            />
            <div class="modal-actions">
              <button class="btn btn-secondary" @click="showRenameModal = false">取消</button>
              <button class="btn btn-primary" @click="confirmRename">确认</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showFileMenuModal" class="context-menu" :style="fileMenuStyle">
        <button class="context-menu-item" @click="startRename">
          <i class="fa-solid fa-pen"></i> 重命名
        </button>
        <button class="context-menu-item" @click="duplicateFile">
          <i class="fa-solid fa-copy"></i> 复制
        </button>
        <button class="context-menu-item" @click="togglePinFile">
          <i class="fa-solid fa-thumbtack"></i> {{ fileMenuTarget.pinned ? '取消置顶' : '置顶' }}
        </button>
        <button class="context-menu-item" @click="toggleStarFile">
          <i class="fa-solid fa-star"></i> {{ fileMenuTarget.starred ? '取消收藏' : '收藏' }}
        </button>
        <!-- 移动到文件夹：以前文件夹只能建、不能往里放东西 —— 建完切进去永远是空的，
             这一项是让文件夹真正可用的那一半。子菜单就地展开，不跳浮窗。 -->
        <div class="context-menu-sub">
          <button class="context-menu-item has-sub" @click.stop="toggleFolderPicker">
            <i class="fa-solid fa-folder"></i> 移动到文件夹
            <i class="fa-solid fa-chevron-right sub-arrow" :class="{ open: folderPickerFor === fileMenuTarget.id }"></i>
          </button>
          <div v-if="folderPickerFor === fileMenuTarget.id" class="context-submenu" :class="{ flip: folderSubFlip }">
            <button
              v-for="f in movableFolders"
              :key="f"
              class="context-menu-item"
              :class="{ current: (fileMenuTarget.folder || DEFAULT_FOLDER) === f }"
              @click="moveFileToFolder(fileMenuTarget.id, f)"
            >
              <i class="fa-solid fa-folder"></i> {{ f }}
              <i v-if="(fileMenuTarget.folder || DEFAULT_FOLDER) === f" class="fa-solid fa-check sub-check"></i>
            </button>
            <div v-if="deletableFolders.length" class="context-menu-sep"></div>
            <button
              v-for="f in deletableFolders"
              :key="'del_' + f"
              class="context-menu-item danger"
              @click="removeFolder(f)"
            >
              <i class="fa-solid fa-trash"></i> 删除「{{ f }}」
            </button>
          </div>
        </div>
        <button v-if="!fileMenuTarget.isPrivate" class="context-menu-item" @click="moveToPrivateFromMenu">
          <i class="fa-solid fa-lock"></i> 移入隐私
        </button>
        <button v-if="fileMenuTarget.isPrivate && privacyUnlocked" class="context-menu-item" @click="moveToPublicFromMenu">
          <i class="fa-solid fa-lock-open"></i> 移出隐私
        </button>
        <button class="context-menu-item danger" @click="deleteFileFromMenu">
          <i class="fa-solid fa-trash"></i> 删除
        </button>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showVersionHistory" class="modal-overlay" @click.self="showVersionHistory = false">
        <div class="modal-panel version-modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-clock-rotate-left"></i> 版本历史
            </h3>
            <button class="modal-close" @click="showVersionHistory = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">
            <div v-if="activeFile && activeFile.versions && activeFile.versions.length" class="version-list">
              <div
                v-for="(ver, idx) in activeFile.versions"
                :key="idx"
                class="version-item"
              >
                <div class="version-info">
                  <div class="version-time">{{ formatDate(ver.timestamp) }}</div>
                  <div class="version-summary">{{ (ver.content || '').substring(0, 60) }}{{ (ver.content || '').length > 60 ? '...' : '' }}</div>
                </div>
                <div class="version-actions">
                  <button class="btn btn-secondary btn-sm" @click="previewVersion(ver)">查看</button>
                  <button class="btn btn-primary btn-sm" @click="restoreVersion(ver)">恢复</button>
                </div>
              </div>
            </div>
            <div v-else class="sidebar-empty">
              <i class="fa-solid fa-clock-rotate-left"></i>
              <span>暂无版本记录</span>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showVersionPreview" class="modal-overlay" @click.self="showVersionPreview = false">
        <div class="modal-panel version-preview-modal">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-eye"></i> 版本预览
            </h3>
            <button class="modal-close" @click="showVersionPreview = false">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">
            <div class="version-preview-content" v-html="versionPreviewHtml" @click="onMarkdownClick"></div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showResourcePicker" class="modal-overlay" @click.self="showResourcePicker = false">
        <div class="modal-panel" style="max-width: 600px; max-height: 80vh;">
          <div class="modal-header">
            <h3 class="modal-title"><i class="fa-solid fa-folder-open"></i> 从云盘导入</h3>
            <button class="modal-close" @click="showResourcePicker = false"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="modal-body" style="overflow-y: auto; max-height: 60vh;">
            <ErrorBanner :message="resourcePickerError" retry @retry="loadResourcePickerItems()" />
            <div v-if="resourcePickerLoading" class="loading-area" style="padding: 40px; text-align: center;">
              <div class="loading-spinner"></div>
              <span>加载中...</span>
            </div>
            <div v-else-if="!resourcePickerError && resourcePickerItems.length === 0" style="padding: 40px; text-align: center; color: var(--text-tertiary);">
              云盘里没有可导入的 .md / .txt 文件
            </div>
            <div v-else>
              <div v-if="resourcePickerPath !== '/'" class="resource-picker-item" @click="goResourcePickerBack">
                <i class="fa-solid fa-arrow-left" style="margin-right: 8px;"></i>
                <span>返回上级</span>
              </div>
              <div
                v-for="item in resourcePickerItems"
                :key="item.name"
                class="resource-picker-item"
                :class="{ 'is-dir': item.is_dir }"
                @click="onResourcePickerItemClick(item)"
              >
                <i class="fa-solid" :class="item.is_dir ? 'fa-folder' : getItemIcon(item)" style="margin-right: 10px; width: 20px; text-align: center;"></i>
                <span class="resource-picker-name">{{ item.name }}</span>
                <span v-if="!item.is_dir" class="resource-picker-size">{{ formatFileSize(item.size) }}</span>
              </div>
            </div>
          </div>
          <div class="modal-footer" style="padding: 12px 20px; border-top: 0.5px solid var(--menu-border); display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: var(--font-size-caption); color: var(--text-tertiary);">支持 .txt 和 .md 文件</span>
            <button class="btn btn-secondary" @click="showResourcePicker = false">取消</button>
          </div>
        </div>
      </div>
    </transition>

    <!-- Interactive Mermaid Zoom Modal -->
    <transition name="modal-fade">
      <div v-if="showMermaidZoom" class="modal-overlay zoom-overlay" @click.self="showMermaidZoom = false">
        <div class="modal-panel mermaid-zoom-panel">
          <div class="modal-header zoom-header">
            <h3 class="modal-title"><i class="fa-solid fa-expand"></i> 图表预览</h3>
            <div class="zoom-controls">
              <button class="zoom-ctrl-btn" @click="zoomIn" title="放大"><i class="fa-solid fa-plus"></i></button>
              <span class="zoom-level">{{ Math.round(mermaidZoomScale * 100) }}%</span>
              <button class="zoom-ctrl-btn" @click="zoomOut" title="缩小"><i class="fa-solid fa-minus"></i></button>
              <button class="zoom-ctrl-btn" @click="resetZoom" title="重置"><i class="fa-solid fa-arrows-to-circle"></i></button>
            </div>
            <button class="modal-close" @click="closeMermaidZoom"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div
            class="zoom-viewport"
            ref="zoomViewport"
            @wheel.prevent="onZoomWheel"
            @mousedown.prevent="onZoomPanStart"
            @mousemove="onZoomPanMove"
            @mouseup="onZoomPanEnd"
            @mouseleave="onZoomPanEnd"
            @dblclick="resetZoom"
            @touchstart.prevent="onZoomTouchStart"
            @touchmove="onZoomTouchMove"
            @touchend="onZoomTouchEnd"
          >
            <div
              class="zoom-stage"
              :style="{ transform: 'translate(' + mermaidZoomPanX + 'px, ' + mermaidZoomPanY + 'px) scale(' + mermaidZoomScale + ')' }"
            >
              <div class="mermaid-zoom-content" v-html="mermaidZoomContent"></div>
            </div>
          </div>
          <div class="zoom-hint">滚轮缩放 · 拖拽移动 · 双击重置</div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showChartEditor" class="modal-overlay" @click.self="showChartEditor = false">
        <div class="modal-panel chart-editor-panel">
          <div class="modal-header">
            <h3 class="modal-title"><i class="fa-solid fa-diagram-project"></i> 图表编辑器 - {{ chartEditorType === 'flowchart' ? '流程图' : chartEditorType === 'gantt' ? '甘特图' : chartEditorType === 'mindmap' ? '思维导图' : '序列图' }}</h3>
            <button class="modal-close" @click="showChartEditor = false"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="chart-editor-toolbar">
            <div class="chart-toolbar-group" v-if="chartEditorType === 'flowchart'">
              <button class="chart-tool-btn" @click="chartEditorAddNode('rect')" title="矩形节点"><i class="fa-solid fa-square"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddNode('round')" title="圆角节点"><i class="fa-regular fa-square"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddNode('diamond')" title="菱形判断"><i class="fa-solid fa-diamond"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddNode('circle')" title="圆形节点"><i class="fa-solid fa-circle"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddEdge" title="添加连线"><i class="fa-solid fa-arrow-right"></i></button>
            </div>
            <div class="chart-toolbar-group" v-if="chartEditorType === 'gantt'">
              <button class="chart-tool-btn" @click="chartEditorAddTask" title="添加任务"><i class="fa-solid fa-plus"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddMilestone" title="添加里程碑"><i class="fa-solid fa-flag"></i></button>
            </div>
            <div class="chart-toolbar-group" v-if="chartEditorType === 'mindmap'">
              <button class="chart-tool-btn" @click="chartEditorAddBranch" title="添加分支"><i class="fa-solid fa-plus"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddSubBranch" title="添加子分支"><i class="fa-solid fa-code-branch"></i></button>
            </div>
            <div class="chart-toolbar-group" v-if="chartEditorType === 'sequence'">
              <button class="chart-tool-btn" @click="chartEditorAddParticipant" title="添加参与者"><i class="fa-solid fa-user-plus"></i></button>
              <button class="chart-tool-btn" @click="chartEditorAddMessage" title="添加消息"><i class="fa-solid fa-message"></i></button>
            </div>
            <div class="chart-toolbar-sep"></div>
            <button class="chart-tool-btn" @click="chartEditorAutoLayout" title="自动布局"><i class="fa-solid fa-wand-magic-sparkles"></i></button>
            <button class="chart-tool-btn" @click="chartEditorChangeTheme" title="切换主题"><i class="fa-solid fa-palette"></i></button>
          </div>
          <div class="chart-editor-body">
            <div class="chart-editor-visual">
              <div class="chart-preview-area scrollbar-thin" ref="chartPreviewArea">
                <div v-if="chartEditorPreviewSvg" class="chart-preview-svg" v-html="chartEditorPreviewSvg"></div>
                <div v-if="chartEditorError" class="mermaid-error">{{ chartEditorError }}</div>
                <div v-if="!chartEditorPreviewSvg && !chartEditorError" class="chart-preview-empty">
                  <i class="fa-solid fa-diagram-project"></i>
                  <span>在下方输入Mermaid代码预览图表</span>
                </div>
              </div>
            </div>
            <div class="chart-editor-code">
              <textarea
                v-model="chartEditorCode"
                class="chart-code-textarea scrollbar-thin"
                @input="onChartEditorCodeChange"
                spellcheck="false"
                placeholder="输入 Mermaid 代码..."
              ></textarea>
            </div>
          </div>
          <div class="modal-footer" style="padding: 12px 20px; border-top: 0.5px solid var(--menu-border); display: flex; justify-content: flex-end; gap: 8px;">
            <button class="btn btn-secondary" @click="showChartEditor = false">取消</button>
            <button class="btn btn-primary" @click="saveChartToNote">保存到笔记</button>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showCommandPalette" class="command-palette-overlay" @click.self="showCommandPalette = false">
        <div class="command-palette">
          <div class="command-palette-input-wrap">
            <i class="fa-solid fa-magnifying-glass command-palette-icon"></i>
            <input
              v-model="commandPaletteQuery"
              class="command-palette-input"
              placeholder="输入命令搜索..."
              ref="commandPaletteInput"
              @keydown.escape="showCommandPalette = false"
              @keydown.enter="executeCommandPalette"
            />
          </div>
          <div class="command-palette-list scrollbar-thin">
            <div
              v-for="(cmd, idx) in filteredCommandItems"
              :key="idx"
              class="command-palette-item"
              @click="executeCommand(cmd)"
            >
              <i class="fa-solid" :class="cmd.icon" style="width: 20px; text-align: center; margin-right: 10px;"></i>
              <span class="command-palette-label">{{ cmd.label }}</span>
              <span v-if="cmd.shortcut" class="command-palette-shortcut">{{ cmd.shortcut }}</span>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showCloudPanel" class="modal-overlay" @click.self="showCloudPanel = false">
        <div class="modal-panel cloud-panel">
          <div class="modal-header">
            <h3 class="modal-title">
              <i class="fa-solid fa-cloud"></i> 云端笔记
            </h3>
            <button class="modal-close" @click="showCloudPanel = false; viewingCloudNote = null">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body cloud-panel-body">
            <div v-if="!viewingCloudNote">
              <div class="cloud-tabs">
                <button class="cloud-tab-btn" :class="{ active: cloudTab === 'my' }" @click="cloudTab = 'my'">我的云端</button>
                <button class="cloud-tab-btn" :class="{ active: cloudTab === 'public' }" @click="cloudTab = 'public'; loadPublicNotes()">公开笔记</button>
              </div>
              <div v-if="cloudTab === 'my'">
                <div class="cloud-toolbar">
                  <button class="btn btn-secondary" @click="loadCloudNotes">
                    <i class="fa-solid fa-rotate"></i> 刷新
                  </button>
                  <button class="btn btn-secondary" @click="showCloudFolderModal = true">
                    <i class="fa-solid fa-folder-plus"></i> 新建文件夹
                  </button>
                </div>
                <div v-if="cloudNotes.length === 0" class="sidebar-empty">
                  <i class="fa-solid fa-cloud"></i>
                  <span>暂无云端笔记</span>
                </div>
                <div v-else class="cloud-note-list">
                  <div
                    v-for="note in cloudNotes"
                    :key="note.id"
                    class="cloud-note-item"
                  >
                    <div class="cloud-note-info" @click="viewCloudNoteDetail(note)">
                      <div class="cloud-note-title">
                        <i v-if="note.is_pinned" class="fa-solid fa-thumbtack" style="font-size: 10px; margin-right: 4px; color: var(--text-tertiary);"></i>
                        <i v-if="note.type === 'draw'" class="fa-solid fa-palette" style="margin-right: 4px; color: var(--accent); font-size: 12px;" title="画板笔记"></i>
                        {{ note.title || '未命名笔记' }}
                      </div>
                      <div class="cloud-note-meta">
                        <span class="cloud-note-folder"><i class="fa-solid fa-folder" style="margin-right: 3px;"></i>{{ note.folder || '默认' }}</span>
                        <span class="cloud-note-visibility" :class="{ 'is-public': note.visibility === 'public' }">
                          <i class="fa-solid" :class="note.visibility === 'public' ? 'fa-globe' : 'fa-lock'" style="margin-right: 3px;"></i>
                          {{ note.visibility === 'public' ? '公开' : '私密' }}
                        </span>
                        <span class="cloud-note-date">{{ formatDate(note.updated_at) }}</span>
                      </div>
                    </div>
                    <div class="cloud-note-actions">
                      <button class="cloud-action-btn" @click="toggleCloudVisibility(note)" :title="note.visibility === 'public' ? '设为私密' : '设为公开'">
                        <i class="fa-solid" :class="note.visibility === 'public' ? 'fa-lock' : 'fa-globe'"></i>
                      </button>
                      <select class="cloud-folder-select" @change="moveCloudNoteFolder(note.id, $event.target.value)" :value="note.folder || '默认'">
                        <option v-for="f in cloudFolders" :key="f.id" :value="f.name">{{ f.name }}</option>
                        <option value="默认">默认</option>
                      </select>
                      <button class="cloud-action-btn danger" @click="deleteCloudNote(note.id)" title="从云端删除">
                        <i class="fa-solid fa-trash"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="cloudTab === 'public'">
                <div class="cloud-toolbar">
                  <input v-model="publicSearchQuery" type="text" class="modal-input" placeholder="搜索公开笔记..." style="flex:1; margin-right:8px;" />
                  <button class="btn btn-secondary" @click="loadPublicNotes">
                    <i class="fa-solid fa-rotate"></i> 刷新
                  </button>
                </div>
                <ErrorBanner :message="publicNotesError" retry @retry="loadPublicNotes()" />
                <div v-if="publicNotesLoading" class="sidebar-empty">
                  <i class="fa-solid fa-spinner fa-spin"></i>
                  <span>加载中...</span>
                </div>
                <div v-else-if="!publicNotesError && filteredPublicNotes.length === 0" class="sidebar-empty">
                  <i class="fa-solid fa-globe"></i>
                  <span>暂无公开笔记</span>
                </div>
                <div v-else class="cloud-note-list">
                  <div
                    v-for="note in filteredPublicNotes"
                    :key="note.id"
                    class="cloud-note-item public-note-item"
                    @click="viewCloudNoteDetail(note)"
                  >
                    <div class="cloud-note-info">
                      <div class="cloud-note-title">
                        <i v-if="note.type === 'draw'" class="fa-solid fa-palette" style="margin-right: 4px; color: var(--accent); font-size: 12px;" title="画板笔记"></i>
                        {{ note.title || '未命名笔记' }}
                      </div>
                      <div class="cloud-note-meta">
                        <span class="cloud-note-author"><i class="fa-solid fa-user" style="margin-right:3px;"></i>{{ note.net_name || '未知用户' }}</span>
                        <span class="cloud-note-folder"><i class="fa-solid fa-folder" style="margin-right: 3px;"></i>{{ note.folder || '默认' }}</span>
                        <span class="cloud-note-date">{{ formatDate(note.updated_at) }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <transition name="modal-fade">
      <div v-if="showCloudFolderModal" class="modal-overlay" @click.self="showCloudFolderModal = false">
        <div class="modal-panel">
          <div class="modal-header">
            <h3 class="modal-title"><i class="fa-solid fa-folder-plus"></i> 新建云端文件夹</h3>
            <button class="modal-close" @click="showCloudFolderModal = false"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="modal-body">
            <input
              v-model="newCloudFolderName"
              type="text"
              class="modal-input"
              placeholder="输入文件夹名称"
              @keyup.enter="createCloudFolder"
            />
            <div class="modal-actions">
              <button class="btn btn-secondary" @click="showCloudFolderModal = false">取消</button>
              <button class="btn btn-primary" @click="createCloudFolder">创建</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <div v-if="viewingCloudNote" class="cloud-note-fullscreen">
      <div class="cloud-note-fullscreen-header">
        <button class="btn btn-secondary" @click="viewingCloudNote = null"><i class="fa-solid fa-arrow-left"></i> 返回</button>
        <h2 class="cloud-note-fullscreen-title">{{ viewingCloudNote.title || '未命名笔记' }}</h2>
        <button class="btn btn-primary" @click="importCloudNote(viewingCloudNote)"><i class="fa-solid fa-download"></i> 转载到本地</button>
      </div>
      <div class="cloud-note-fullscreen-meta">
        <span v-if="viewingCloudNote.net_name"><i class="fa-solid fa-user"></i> {{ viewingCloudNote.net_name }}</span>
        <span v-if="viewingCloudNote.folder"><i class="fa-solid fa-folder"></i> {{ viewingCloudNote.folder }}</span>
        <span v-if="viewingCloudNote.tags && viewingCloudNote.tags.length">
          <i class="fa-solid fa-tags"></i> {{ viewingCloudNote.tags.join(', ') }}
        </span>
        <span><i class="fa-solid fa-clock"></i> {{ formatDate(viewingCloudNote.updated_at) }}</span>
      </div>
      <div v-if="viewingCloudNote.type === 'draw'" class="cloud-note-fullscreen-content cloud-note-draw-readonly">
        <DrawCanvas
          v-if="viewingCloudNote.canvas_data"
          mode="full"
          :readonly="true"
          :initialLayers="parseCanvasData(viewingCloudNote.canvas_data)"
        />
        <div v-else class="cloud-note-draw-empty">
          <i class="fa-solid fa-palette"></i>
          <p>画板数据为空</p>
        </div>
      </div>
      <div v-else class="cloud-note-fullscreen-content markdown-body" v-html="renderMarkdown(viewingCloudNote.content || '')" @click="onMarkdownClick"></div>
    </div>

    <!-- 云盘图片/音视频选择器 -->
    <CloudImagePicker v-if="showCloudPicker" @select="onCloudImageSelect" @close="showCloudPicker = false" />

    <!-- 轻量输入弹窗（替代 ClassIntra 全局 $modal.prompt：新建本地文件夹等场景） -->
    <div v-if="showPromptModal" class="modal-overlay" @click.self="settlePromptModal(null)">
      <div class="modal-panel prompt-modal">
        <div class="modal-header">
          <h3 class="modal-title">{{ promptTitle }}</h3>
          <button class="modal-close" @click="settlePromptModal(null)"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="modal-body">
          <input
            ref="promptInput"
            v-model="promptValue"
            class="modal-input"
            :placeholder="promptPlaceholder"
            @keydown.enter="settlePromptModal(promptValue)"
            @keydown.esc="settlePromptModal(null)"
          />
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" @click="settlePromptModal(null)">取消</button>
          <button class="btn btn-primary" @click="settlePromptModal(promptValue)">{{ promptConfirmText }}</button>
        </div>
      </div>
    </div>

  </div>
</template>

<script>
import { marked } from 'marked';
import DOMPurify from 'dompurify';
// ⚠️ 用 hljs-lite（core 版 + 按需注册），不是全量包：
//   全量包带进约 190 种语言的定义，而这个页面只用到
//   getLanguage / highlight / highlightAuto 三个 API。
//   换 core 版后 Notes 单页实测省下 300KB+ 原始体积，
//   对低端安卓平板是一次实打实的首屏收益。详见 utils/hljs-lite.js。
import hljs from '@/utils/hljs-lite';
import katex from 'katex';
import mermaid from 'mermaid';
import 'highlight.js/styles/github-dark.min.css';
import 'katex/dist/katex.min.css';
import AppNav from '@/components/AppNav.vue';
import DrawCanvas from '@/components/DrawCanvas.vue';
import CloudImagePicker from '@/components/CloudImagePicker.vue';
import Segmented from '@/components/Segmented.vue';
import VirtualList from '@/components/VirtualList.vue';
import ErrorBanner from '@/components/ErrorBanner.vue';
import api from '@/utils/api';
import cloudPickerReceiver from '@/mixins/cloud-picker-receiver';
import orientation from '@/mixins/orientation';
import LatexRenderer, { ensureKatexIdle, onKatexReady } from '@/utils/latex-renderer';
// AI 辅助的流式接口（Cluss 特有）：SSE 读流工具
import { postStream, readSseStream } from '@/utils/sse';
import { readStudentPrefs } from '@/utils/student-prefs';

var NOTES_STORAGE_KEY = 'notes_data';

mermaid.initialize({
  startOnLoad: false,
  theme: 'default',
  // antiscript：允许 HTML 标签（<br> 等）但移除脚本事件——loose 完全不设防（存储型 XSS），strict 会把 <br> 转义成文本
  securityLevel: 'antiscript',
  fontFamily: 'inherit',
  suppressErrorRendering: true,
  flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
  gantt: { useMaxWidth: true },
  mindmap: { useMaxWidth: true, padding: 16 },
  sequence: { useMaxWidth: true }
});

var mermaidRenderCounter = 0;
var mermaidRenderDebounce = null;

// UTF-8 safe Base64 encode (replaces fragile btoa(unescape(encodeURIComponent(...))))
function utf8ToBase64(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xC0 | (code >> 6), 0x80 | (code & 0x3F));
    } else if (code < 0xD800 || code >= 0xE000) {
      bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F));
    } else {
      // Surrogate pair: code is high surrogate, next is low surrogate
      i++;
      var next = str.charCodeAt(i);
      var cp = 0x10000 + ((code & 0x3FF) << 10) + (next & 0x3FF);
      bytes.push(
        0xF0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3F),
        0x80 | ((cp >> 6) & 0x3F),
        0x80 | (cp & 0x3F)
      );
    }
  }
  var binary = '';
  for (var j = 0; j < bytes.length; j++) {
    binary += String.fromCharCode(bytes[j]);
  }
  return btoa(binary);
}

// UTF-8 safe Base64 decode
function base64ToUtf8(b64) {
  var binary = atob(b64);
  var bytes = [];
  for (var i = 0; i < binary.length; i++) {
    bytes.push(binary.charCodeAt(i));
  }
  var result = '';
  var i = 0;
  while (i < bytes.length) {
    var b0 = bytes[i];
    if (b0 < 0x80) {
      result += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xE0) === 0xC0) {
      result += String.fromCharCode(((b0 & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
      i += 2;
    } else if ((b0 & 0xF0) === 0xE0) {
      result += String.fromCharCode(((b0 & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
      i += 3;
    } else {
      var cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
      result += String.fromCharCode(0xD800 + ((cp - 0x10000) >> 10));
      result += String.fromCharCode(0xDC00 + ((cp - 0x10000) & 0x3FF));
      i += 4;
    }
  }
  return result;
}

// 旧版本地"加密"（XOR + 写死的 key）的**解密半边**仍保留：
// 老学生的 privacyPassword 还以这种混淆串存在 notes_data 里，
// 要在解锁时读出来搬到服务端（见 verifyPrivacyPassword 的 ② 分支）。
// 加密半边（encrypt）已删除 —— 新密码一律走服务端 scrypt，
// 再造新的本地混淆串只会让"搬一次"这件事再发生一遍。
function decrypt(encoded, key) {
  var text = base64ToUtf8(encoded);
  var result = '';
  for (var i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return result;
}

function generateId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 文件夹的两个约定值。
// 「全部」只是筛选视角，不是存放位置，所以永远不会成为某篇笔记的 folder；
// 「默认」是兜底 —— 没有 folder 字段的旧笔记一律算在它名下。
// 这两个值散落在过滤、计数、可删除判断里，抽成常量免得各写一份中文再改岔。
var ALL_FOLDERS = '全部';
var DEFAULT_FOLDER = '默认';

var customRenderer = new marked.Renderer();
customRenderer.code = function(code, lang) {
  var language = lang || '';
  if (language === 'mermaid') {
    mermaidRenderCounter++;
    var mermaidId = 'mermaid-chart-' + mermaidRenderCounter;
    var rawB64 = utf8ToBase64(String(code));
    return '<div class="mermaid-chart-wrapper"><div class="mermaid-chart" id="' + mermaidId + '" data-raw-b64="' + rawB64 + '"></div><div class="mermaid-chart-actions"><button class="mermaid-edit-btn" data-chart-id="' + mermaidId + '" title="编辑图表"><i class="fa-solid fa-pen-to-square"></i></button><button class="mermaid-zoom-btn" data-chart-id="' + mermaidId + '" title="放大查看"><i class="fa-solid fa-expand"></i></button></div></div>';
  }
  var highlighted;
  if (language && hljs.getLanguage(language)) {
    try {
      highlighted = hljs.highlight(code, { language: language }).value;
    } catch (e) {
      highlighted = hljs.highlightAuto(code).value;
    }
  } else {
    highlighted = hljs.highlightAuto(code).value;
  }
  var lines = highlighted.split('\n');
  var lineNumbersHtml = '';
  var codeLinesHtml = '';
  for (var i = 0; i < lines.length; i++) {
    lineNumbersHtml += '<span class="code-line-number">' + (i + 1) + '</span>';
    codeLinesHtml += '<span class="code-line">' + lines[i] + '</span>';
  }
  var langLabel = language ? '<span class="code-lang-label">' + language + '</span>' : '';
  return '<pre class="code-block-wrapper">' + langLabel + '<div class="code-block-inner"><div class="code-line-numbers">' + lineNumbersHtml + '</div><code class="hljs code-block-content">' + codeLinesHtml + '</code></div></pre>';
};
customRenderer.table = function(header, body) {
  return '<div class="table-wrapper"><table class="md-table"><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>';
};

marked.setOptions({
  renderer: customRenderer,
  breaks: true,
  gfm: true,
  headerIds: false,
  mangle: false
});

var NOTE_TEMPLATES = [
  { id: 'blank', name: '空白笔记', icon: 'fa-file', content: '' },
  { id: 'diary', name: '日记', icon: 'fa-calendar-day', content: '# 📅 日记 - {{date}}\n\n**天气**：\n**心情**：😊\n\n---\n\n## 今日记录\n\n\n\n---\n\n## 今日感悟\n\n' },
  { id: 'meeting', name: '会议记录', icon: 'fa-users', content: '# 📋 会议记录\n\n**日期**：{{date}}\n**参会人**：\n**主持人**：\n\n---\n\n## 议题\n\n1. \n\n## 决议\n\n- \n\n## 待办事项\n\n- [ ] \n\n' },
  { id: 'todo', name: '待办清单', icon: 'fa-list-check', content: '# ✅ 待办清单 - {{date}}\n\n## 🔴 紧急重要\n\n- [ ] \n\n## 🟡 重要不紧急\n\n- [ ] \n\n## 🟢 紧急不重要\n\n- [ ] \n\n## ⚪ 不紧急不重要\n\n- [ ] \n\n---\n\n## 已完成\n\n- [x] \n' },
  { id: 'reading', name: '读书笔记', icon: 'fa-book', content: '# 📖 读书笔记\n\n**书名**：\n**作者**：\n**阅读日期**：{{date}}\n\n---\n\n## 摘要\n\n> \n\n## 核心观点\n\n1. \n\n## 个人感想\n\n\n\n## 精彩段落\n\n> \n\n' },
  { id: 'weekly', name: '周计划', icon: 'fa-calendar-week', content: '# 📅 周计划 - {{date}}\n\n## 周一\n\n- [ ] \n\n## 周二\n\n- [ ] \n\n## 周三\n\n- [ ] \n\n## 周四\n\n- [ ] \n\n## 周五\n\n- [ ] \n\n## 周末\n\n- [ ] \n\n---\n\n## 本周目标\n\n1. \n\n## 本周复盘\n\n\n' }
];

export default {
  name: 'Notes',
  mixins: [cloudPickerReceiver, orientation],
  components: { AppNav: AppNav, DrawCanvas: DrawCanvas, CloudImagePicker: CloudImagePicker, Segmented: Segmented, VirtualList: VirtualList, ErrorBanner: ErrorBanner },
  data: function() {
    return {
      files: [],
      privateFiles: [],
      activeFileId: null,
      editorFontSize: 15,
      // 分栏默认给编辑区多一点：写作时正文是主角，预览是配角。
      // 50/50 时编辑区在 1440 宽下只有 564px，一行放不下工具栏、正文也窄。
      editorWidthPercent: 62,
      moreMenuOpen: false,
      sortMenuOpen: false,
      viewMode: 'split',
      isResizing: false,
      searchInput: '',
      searchQuery: '',
      tagFilter: '',
      isMobile: window.innerWidth <= 768,
      showPrivacyModal: false,
      privacyUnlocked: false,
      privacyPasswordInput: '',
      privacyPasswordConfirm: '',
      privacyPassword: '',
      showTagModal: false,
      newTagInput: '',
      showRenameModal: false,
      renameInput: '',
      renameTargetId: null,
showFileMenuModal: false,
    fileMenuStyle: {},
    fileMenuTarget: {},
    // 「移动到文件夹」子菜单当前展开给哪篇（存 id，不是对象 —— 对象会跟着
    // 右键目标的切换而错位）。菜单关掉时要一并收起，否则下次打开还悬着。
    folderPickerFor: '',
    // 右边放不下时子菜单翻到左侧（见 toggleFolderPicker 里的实测判据）
    folderSubFlip: false,
      isSyncingScroll: false,
      saveTimer: null,
      autoSaveTimer: null,
      autoSaveIndicator: false,
      showTemplatePicker: false,
      noteTemplates: NOTE_TEMPLATES,
      showVersionHistory: false,
      showVersionPreview: false,
      versionPreviewHtml: '',
      showCreateMenu: false,
      /* 桌面/宽屏下可手动收起文件栏，把横向空间让给编辑区；竖屏抽屉模式走 drawerOpen */
      sidebarHidden: false,
      showAnnotationLayer: false,
      annoDrawing: false,
      annotationInput: '',
      annotationSelectedText: '',
      annotationColor: 'var(--accent)',
      showAnnotationInput: false,
      showResourcePicker: false,
      resourcePickerItems: [],
      resourcePickerPath: '/',
      resourcePickerLoading: false,
      // 「从云盘导入」列表的加载失败态：用 ErrorBanner 展示（可重试），
      // 不再用 toast —— 列表是自己一整块内容，失败了该在它所在处说清并给重试入口
      resourcePickerError: '',
      showMermaidZoom: false,
      mermaidZoomContent: '',
      mermaidZoomScale: 1,
      mermaidZoomPanX: 0,
      mermaidZoomPanY: 0,
      mermaidZoomPanning: false,
      mermaidZoomLastX: 0,
      mermaidZoomLastY: 0,
      mermaidZoomTouchDist: 0,
      showChartEditor: false,
      chartEditorCode: '',
      chartEditorType: 'flowchart',
      chartEditorPreviewSvg: '',
      chartEditorError: '',
      showCommandPalette: false,
      commandPaletteQuery: '',
      // 云盘图片选择器
      showCloudPicker: false,
      imageInsertPos: null, // 打开选择器时保存的编辑器光标位置 { start, end }
      folders: ['全部', '默认'],
      activeFolder: '全部',
      sortBy: 'updatedAt',
      renderedContentHtml: '',
      cloudSyncing: false,
      cloudNotes: [],
      showCloudPanel: false,
      cloudFolders: [],
      showCloudFolderModal: false,
      newCloudFolderName: '',
      cloudTab: 'my',
      publicNotes: [],
      publicNotesLoading: false,
      // 公开笔记列表的加载失败态：同上，改用 ErrorBanner（可重试），
      // 免得失败时面板显示「暂无公开笔记」把人误导成"真的没有"
      publicNotesError: '',
      publicSearchQuery: '',
      viewingCloudNote: null,
      // ---- 轻量输入弹窗（替代 ClassIntra 全局 $modal.prompt）----
      showPromptModal: false,
      promptTitle: '',
      promptPlaceholder: '',
      promptConfirmText: '确定',
      promptValue: '',
      // ---- AI 辅助（Cluss 特有：走 /api/notes/assist，消耗积分）----
      assistMenuOpen: false,
      assisting: false,
      assistResult: '',
      assistHtml: '',
      wallet: null,
      error: ''
    };
  },
  computed: {
    // ---- 积分（AI 辅助用，Cluss 特有）----
    walletLabel: function() {
      var w = this.wallet;
      if (!w) return '…';
      if (!w.is_allocated) return '未开通';
      return w.available_points + ' 积分';
    },
    walletExhausted: function() {
      var w = this.wallet;
      return !!(w && w.is_allocated && Number(w.available_points || 0) <= 0);
    },
    // 超能岛浏览器是否启用（per-user browser_enabled，Admin → 用户列表 → 编辑用户）
    // 禁用时笔记中的链接以纯文本显示，点击提示"你没有权限"
    browserEnabled: function() {
      var user = this.$store && this.$store.state && this.$store.state.auth && this.$store.state.auth.user;
      return !!(user && user.info && user.info.browser_enabled);
    },
    activeFile: function() {
      var self = this;
      var allFiles = self.allFiles;
      for (var i = 0; i < allFiles.length; i++) {
        if (allFiles[i].id === self.activeFileId) return allFiles[i];
      }
      return null;
    },
    allFiles: function() {
      return this.files.concat(this.privateFiles);
    },
    isDrawFile: function() {
      var file = this.activeFile;
      return file && file.type === 'draw';
    },
    annotationCards: function() {
      var file = this.activeFile;
      if (!file || file.type === 'draw') return [];
      return file.annotations || [];
    },
    filteredFiles: function() {
      var self = this;
      // ⚠️ 必须先slice 再过滤/排序。
      //   原来直接 `var result = self.files`：无搜索词、无标签、无文件夹过滤时
      //   result 与 data.files 是**同一个数组引用**，下面的 result.sort()
      //   就地打乱了data.files 本身。后果是笔记列表的顺序被这个 computed 的
      //   求值时机污染 —— 表现为你选了「按时间排序」，结果顺序却随
      //   别的筛选条件进出而变，且完全不可预测。
      var result = self.files.slice();
      if (self.searchQuery) {
        var q = self.searchQuery.toLowerCase();
        if (q.indexOf('#') === 0) {
          var tagName = q.substring(1);
          result = result.filter(function(f) {
            return f.tags && f.tags.some(function(t) { return t.toLowerCase().indexOf(tagName) > -1; });
          });
        } else {
          result = result.filter(function(f) {
            return (f.title || '').toLowerCase().indexOf(q) > -1 ||
                   (f.content || '').toLowerCase().indexOf(q) > -1;
          });
        }
      }
      if (self.tagFilter) {
        var tf = self.tagFilter;
        result = result.filter(function(f) {
          return f.tags && f.tags.indexOf(tf) > -1;
        });
      }
      if (self.activeFolder && self.activeFolder !== '全部') {
        result = result.filter(function(f) { return (f.folder || '默认') === self.activeFolder; });
      }
      result.sort(function(a, b) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        if (self.sortBy === 'title') {
          return (a.title || '').localeCompare(b.title || '');
        }
        if (self.sortBy === 'charCount') {
          return ((b.content || '').length) - ((a.content || '').length);
        }
        return new Date(b.updatedAt) - new Date(a.updatedAt);
      });
      return result;
    },
    allTags: function() {
      var self = this;
      var tagSet = {};
      for (var i = 0; i < self.files.length; i++) {
        var tags = self.files[i].tags || [];
        for (var j = 0; j < tags.length; j++) {
          tagSet[tags[j]] = true;
        }
      }
      return Object.keys(tagSet).sort();
    },
    // 每个文件夹的篇数（「全部」是总数）。下拉里直接显示，
    // 免得新建一个文件夹切进去空空的、以为坏了
    folderCounts: function() {
      var self = this;
      var counts = { '全部': self.files.length };
      for (var i = 0; i < self.files.length; i++) {
        var key = self.files[i].folder || DEFAULT_FOLDER;
        counts[key] = (counts[key] || 0) + 1;
      }
      return counts;
    },
    // 「移动到文件夹」里可选项：去掉「全部」（那是筛选视角，不是存放位置）
    movableFolders: function() {
      var self = this;
      var list = self.folders.filter(function(f) { return f !== ALL_FOLDERS; });
      if (list.indexOf(DEFAULT_FOLDER) < 0) list.unshift(DEFAULT_FOLDER);
      return list;
    },
    // 可删除的文件夹：「全部」是虚拟筛选、「默认」是兜底，都不能删
    deletableFolders: function() {
      var self = this;
      return self.folders.filter(function(f) { return f !== ALL_FOLDERS && f !== DEFAULT_FOLDER; });
    },
    // 「有没有密码」= 服务端设过 **或** 本地还留着旧格式的。
    // 两个都认是因为老学生的密码还以 XOR 混淆串存在 notes_data 里
    // （见 verifyPrivacyPassword 的迁移注释）；只认服务端会让
    // "我明明设过"直接退回设置流程，之前的私密笔记谁都打不开。
    hasPrivacyPassword: function() {
      return this.lockHasPassword || !!this.privacyPassword;
    },
    // 统一密码（服务端）的两个镜像态。放 computed 而不是 data：
    // 对话侧解锁 / 设置里改了密码，这里要立刻跟着变。
    lockHasPassword: function() {
      return this.$store.state.lock.hasPassword;
    },
    lockUnlocked: function() {
      return this.$store.state.lock.unlocked;
    },
    charCount: function() {
      if (!this.activeFile || !this.activeFile.content) return 0;
      return this.activeFile.content.replace(/\s/g, '').length;
    },
    lineCount: function() {
      if (!this.activeFile || !this.activeFile.content) return 0;
      return this.activeFile.content.split('\n').length;
    },
    chineseCharCount: function() {
      if (!this.activeFile || !this.activeFile.content) return 0;
      var match = this.activeFile.content.match(/[\u4e00-\u9fff]/g);
      return match ? match.length : 0;
    },
    englishWordCount: function() {
      if (!this.activeFile || !this.activeFile.content) return 0;
      var match = this.activeFile.content.match(/[a-zA-Z]+/g);
      return match ? match.length : 0;
    },
    readingTime: function() {
      var total = this.chineseCharCount + this.englishWordCount;
      var minutes = Math.ceil(total / 300);
      return minutes < 1 ? '<1分钟' : minutes + '分钟';
    },
    filteredPublicNotes: function() {
      var self = this;
      var q = (self.publicSearchQuery || '').toLowerCase();
      if (!q) return self.publicNotes;
      return self.publicNotes.filter(function(n) {
        return (n.title || '').toLowerCase().indexOf(q) > -1 ||
               (n.content || '').toLowerCase().indexOf(q) > -1 ||
               (n.net_name || '').toLowerCase().indexOf(q) > -1 ||
               (n.tags && n.tags.some(function(t) { return t.toLowerCase().indexOf(q) > -1; }));
      });
    },
    commandItems: function() {
      return [
        { label: '新建笔记', icon: 'fa-plus', action: 'newNote', shortcut: 'Ctrl+N' },
        { label: '保存', icon: 'fa-floppy-disk', action: 'save', shortcut: 'Ctrl+S' },
        { label: '插入流程图', icon: 'fa-diagram-project', action: 'mermaid-flowchart' },
        { label: '插入甘特图', icon: 'fa-bars-staggered', action: 'mermaid-gantt' },
        { label: '插入思维导图', icon: 'fa-sitemap', action: 'mermaid-mindmap' },
        { label: '插入序列图', icon: 'fa-arrow-right-arrow-left', action: 'mermaid-sequence' },
        { label: '加粗', icon: 'fa-bold', action: 'bold', shortcut: 'Ctrl+B' },
        { label: '斜体', icon: 'fa-italic', action: 'italic', shortcut: 'Ctrl+I' },
        { label: '插入代码块', icon: 'fa-file-code', action: 'codeblock' },
        { label: '插入表格', icon: 'fa-table', action: 'table' },
        { label: '增大字号', icon: 'fa-magnifying-glass-plus', action: 'fontSizeUp', shortcut: 'Ctrl+=' },
        { label: '减小字号', icon: 'fa-magnifying-glass-minus', action: 'fontSizeDown', shortcut: 'Ctrl+-' },
        { label: '打开画布', icon: 'fa-paintbrush', action: 'canvas' },
        { label: '管理标签', icon: 'fa-tags', action: 'tags' },
        { label: '版本历史', icon: 'fa-clock-rotate-left', action: 'versions' },
        { label: '焦点模式', icon: 'fa-expand', action: 'focusMode', shortcut: 'Ctrl+Shift+F' }
      ];
    },
    filteredCommandItems: function() {
      var self = this;
      if (!self.commandPaletteQuery) return self.commandItems;
      var q = self.commandPaletteQuery.toLowerCase();
      return self.commandItems.filter(function(cmd) {
        return cmd.label.toLowerCase().indexOf(q) > -1;
      });
    },
    // 排序：三档，与原来那个 select 的选项一一对应（值不变，历史数据照读）
    sortOptions: function() {
      return [
        { value: 'updatedAt', label: '按更新时间' },
        { value: 'title', label: '按标题' },
        { value: 'charCount', label: '按字数' }
      ];
    },
    sortLabel: function() {
      var self = this;
      for (var i = 0; i < self.sortOptions.length; i++) {
        if (self.sortOptions[i].value === self.sortBy) return self.sortOptions[i].label;
      }
      return '按更新时间';
    },
    // 视图模式：用全站统一的分段控件（编辑 / 分栏 / 预览），
    // 替代 ClassIntra 顶栏里那组图标按钮
    viewModeOptions: function() {
      return [
        { id: 'edit', label: '编辑' },
        { id: 'split', label: '分栏' },
        { id: 'preview', label: '预览' }
      ];
    },
    editorAreaStyle: function() {
      var self = this;
      if (self.viewMode === 'edit') return { flex: '1 1 0%', minWidth: '0', maxWidth: '100%' };
      if (self.viewMode === 'preview') return { flex: '0 0 0%', overflow: 'hidden', minWidth: '0', maxWidth: '0%' };
      // 分栏永远是**左右**（横向）：笔记是「左边写、右边看」的工作方式，
      // 竖向堆叠会把预览压到编辑区下面，读稿时得来回上下扫，体验反而更差。
      // 编辑区嫌小靠比例解决（默认 62%），不靠换布局。
      return { flex: '1 1 0%', minWidth: '0', maxWidth: 'calc(' + self.editorWidthPercent + '% - 6px)' };
    },
    previewAreaStyle: function() {
      var self = this;
      if (self.viewMode === 'preview') return { flex: '1 1 0%', minWidth: '0', maxWidth: '100%' };
      if (self.viewMode === 'edit') return { flex: '0 0 0%', overflow: 'hidden', minWidth: '0', maxWidth: '0%' };
      return { flex: '1 1 0%', minWidth: '0', maxWidth: 'calc(' + (100 - self.editorWidthPercent) + '% - 6px)' };
    }
  },
  watch: {
    // 选中项滚进可视区。
    //
    // 虚拟滚动之后，选中的笔记可能落在渲染窗口之外 —— 侧栏看着就是
    // 「明明选中了却看不到高亮在哪」。activeFileId 有好几处会被改
    // （selectFile / loadData / deleteFile 后重选 / 撤销恢复），
    // 逐个调用 scrollToIndex 必然漏，所以在这里统一兜住。
    //
    // 只在选中项真的不在可视区时才滚（scrollToIndex 内部已判），
    // 正常点击列表里的项不会产生多余的滚动动作。
    activeFileId: function() {
      var self = this;
      this.$nextTick(function() {
        var vl = self.$refs.fileList;
        if (!vl || !vl.scrollToIndex) return;
        var idx = -1;
        for (var i = 0; i < self.filteredFiles.length; i++) {
          if (self.filteredFiles[i].id === self.activeFileId) { idx = i; break; }
        }
        if (idx >= 0) vl.scrollToIndex(idx);
      });
    },
    // 搜索输入防抖：输入框绑 searchInput，这里等 200ms 静默后才落到 searchQuery。
    //
    // 为什么要分两个变量：filteredFiles 的匹配范围**包含笔记正文**，
    // 每敲一个键就要把所有笔记的完整正文 toLowerCase + indexOf 一遍
    // （50篇 × 平均 5KB = 每键扫描 250KB 文本）。低端平板上这是可感知的卡顿，
    // 表现为"打字时整个页面顿一下"。
    //
    // 而 searchQuery 全文件有 6 处引用（含空状态文案与高亮定位），
    // 让它只在防抖后更新，这 6 处一行都不用改 —— 副作用最小的做法。
    searchInput: function(val) {
      var self = this;
      if (this._searchDebounce) clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(function() {
        self._searchDebounce = null;
        self.searchQuery = val;
      }, 200);
    },
    activeFile: function() {
      var self = this;
      self.$nextTick(function() {
        self.bindTodoClicks();
        self.renderMermaidCharts();
      });
    },
    renderedContentHtml: function() {
      var self = this;
      self._mermaidActionsBound = false;
      self.$nextTick(function() {
        self.bindTodoClicks();
        self.renderMermaidCharts();
        // 内容变化后，若批注层已开启，重新测量并初始化画布尺寸（保留现有图层）
        if (self.showAnnotationLayer && self.$refs.annotationCanvas) {
          self.$refs.annotationCanvas.init(self.activeFile.canvasData || []);
        }
      });
    },
    'activeFile.content': {
      handler: function() {
        var self = this;
        if (self._renderDebounce) clearTimeout(self._renderDebounce);
        self._renderDebounce = setTimeout(function() {
          self.renderedContentHtml = self.computeRenderedContent();
        }, 300);
      },
      immediate: true
    },
    viewMode: function() {
      this.saveData();
    }
  },
  created: function() {
    this.loadData();
    this.loadCloudNotes();
    this.loadCloudFolders();
    this.loadWallet();
    // 统一密码状态：不预拉的话，学生明明在对话侧解锁过，
    // 进隐私空间还要再输一遍（"合为一个"就名不副实）。
    // refresh 内部失败按"没密码"兜底，不影响本页其它加载。
    this.$store.dispatch('lock/refresh');
    // katex 按需加载 + 就绪重绘（机制见 utils/markdown.js 的说明）。
    // 本页通过 latex-renderer 渲染公式；引擎到货前是 <code> 原文占位，
    // 到货后重算当前预览 —— 仅当前笔记一篇，成本可忽略。
    // Notes 已有 _renderDebounce（300ms）防抖，这里直接赋值不与之冲突。
    var self = this;
    ensureKatexIdle();
    onKatexReady(function () {
      if (self.activeFile && self.activeFile.content) {
        self.renderedContentHtml = self.computeRenderedContent();
      }
    });
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onGlobalKeydown);
    window.addEventListener('beforeunload', this.forceSave);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  },
  beforeDestroy: function() {
    // 搜索防抖定时器：不清的话组件销毁后它仍会触发，
    // 往已销毁的实例上写 searchQuery（Vue 2 里这会静默失败但留下悬空定时器）
    if (this._searchDebounce) {
      clearTimeout(this._searchDebounce);
      this._searchDebounce = null;
    }
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onGlobalKeydown);
    window.removeEventListener('beforeunload', this.forceSave);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    if (this._renderDebounce) clearTimeout(this._renderDebounce);
    this.forceSave();
    if (this._activeFileMenuHandler) {
      document.removeEventListener('click', this._activeFileMenuHandler);
      this._activeFileMenuHandler = null;
    }
    // 排序菜单的 click-away：不摘掉的话它握着整个 vm，页面销毁后回收不了
    if (this._sortMenuHandler) {
      document.removeEventListener('click', this._sortMenuHandler);
      this._sortMenuHandler = null;
    }
    if (this._moreMenuHandler) {
      document.removeEventListener('click', this._moreMenuHandler);
      this._moreMenuHandler = null;
    }
  },
  methods: {
    // 笔记中的超链接点击拦截：有 browser_enabled 时用超能岛浏览器打开（隐藏地址栏），无权限提示
    onMarkdownClick: function(e) {
      var target = e.target;
      if (target.tagName === 'AUDIO') return;
      var linkEl = target.closest ? target.closest('a') : null;
      if (linkEl && linkEl.tagName === 'A') {
        if (!this.browserEnabled) {
          e.preventDefault();
          e.stopPropagation();
          this.$store.commit('SHOW_TOAST', { message: '你没有权限打开链接', type: 'error' });
          return;
        }
        var href = linkEl.getAttribute('href') || '';
        // 仅拦截外部链接（http/https），内部路由不动
        if (/^https?:\/\//i.test(href)) {
          e.preventDefault();
          e.stopPropagation();
          // 笔记应用打开链接时统一隐藏地址栏
          var url = '/browser?url=' + encodeURIComponent(href) + '&fullscreen=1&noaddr=1';
          this.$router.push(url);
        }
      }
    },
    // 应用超链接权限过滤：无 browser_enabled 时将 <a> 转为带提示的 span
    applyLinkPermission: function(html) {
      if (this.browserEnabled) return html;
      return html.replace(/<a\b[^>]*>([^<]*)<\/a>/gi, '<span class="msg-link-text msg-link-no-perm" title="你没有权限打开链接">$1</span>');
    },
    renderMarkdown: function(content) {
      if (!content) return '';
      var result = LatexRenderer.processContent(content, marked);
      result.html = DOMPurify.sanitize(result.html, {
        ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mtext', 'mspace', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msubsup', 'mmultiscripts', 'maction'],
        ADD_ATTR: ['style', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'linethickness', 'notation', 'open', 'close', 'separators', 'stretchy', 'symmetric', 'lspace', 'rspace', 'largeop', 'movablelimits', 'accent', 'accentunder', 'align', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalcolumns', 'equalrows', 'minlabelspacing', 'side', 'subscriptshift', 'superscriptshift']
      });
      var html = LatexRenderer.renderFinalHtml(result.html, result.placeholders);
      html = this.applyLinkPermission(html);
      return html;
    },
    computeRenderedContent: function() {
      if (!this.activeFile || !this.activeFile.content) return '';
      mermaidRenderCounter = 0;
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        theme: isDark ? 'dark' : 'default',
        // ⚠️ 这里必须是 'antiscript'，不能是 'loose'。
//   'loose' 下mermaid 不对标签做任何消毒，而本路径生成的 SVG
//   是直接 innerHTML 注入的（见 renderMermaidCharts），且**没有**
//   utils/mermaid.js 的 stripExecutable 兜底。
//   笔记正文有两个来源都会流到这里：AI 辅助结果（runAssist）与云端导入，
//   在提示注入场景下可触达 on* 事件属性。
//   同一文件上方第 1165 行与 utils/mermaid.js 都是 antiscript，
//   那里的注释写得更直接：「loose 完全不设防，不能给」。
        securityLevel: 'antiscript',
        fontFamily: 'inherit',
        suppressErrorRendering: true,
        flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' },
        gantt: { useMaxWidth: true },
        mindmap: { useMaxWidth: true, padding: 16 },
        sequence: { useMaxWidth: true }
      });
      var content = this.activeFile.content;
      var result = LatexRenderer.processContent(content, marked);
      var html = DOMPurify.sanitize(result.html, {
        ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mtext', 'mspace', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msubsup', 'mmultiscripts', 'maction', 'svg', 'path', 'g', 'text', 'rect', 'circle', 'line', 'polygon', 'polyline', 'ellipse', 'defs', 'clipPath', 'marker', 'tspan', 'foreignObject', 'use', 'image', 'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'linearGradient', 'stop', 'pattern', 'desc', 'title', 'style'],
        ADD_ATTR: ['style', 'xmlns', 'viewBox', 'preserveAspectRatio', 'd', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'class', 'id', 'href', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform', 'filterUnits', 'stdDeviation', 'dx', 'dy', 'result', 'in', 'in2', 'operator', 'k1', 'k2', 'k3', 'k4', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'linethickness', 'notation', 'open', 'close', 'separators', 'stretchy', 'symmetric', 'lspace', 'rspace', 'largeop', 'movablelimits', 'accent', 'accentunder', 'align', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalcolumns', 'equalrows', 'minlabelspacing', 'side', 'subscriptshift', 'superscriptshift', 'data-raw-b64', 'data-chart-id']
      });
      html = LatexRenderer.renderFinalHtml(html, result.placeholders);
      html = this.renderAnnotations(html);
      html = this.renderTodoItems(html);
      html = this.applyLinkPermission(html);
      return html;
    },
    loadData: function() {
      var self = this;
      try {
        var raw = localStorage.getItem(NOTES_STORAGE_KEY);
        if (raw) {
          var data = JSON.parse(raw);
          self.files = data.files || [];
          self.privateFiles = data.privateFiles || [];
          self.privacyPassword = data.privatePassword || '';
          self.editorFontSize = data.editorFontSize || 15;
          // 存量数据里的 50 正是**旧默认值**（没人拖过也是 50），跟着新默认值走；
          // 拖过的值不是 50，原样尊重，不擅自改用户自己调过的比例
          var savedRatio = Number(data.editorWidthPercent) || 62;
          self.editorWidthPercent = savedRatio === 50 ? 62 : savedRatio;
          self.activeFileId = data.activeFileId || null;
          self.viewMode = data.viewMode || 'split';
          self.folders = data.folders || ['全部', '默认'];
          self.activeFolder = data.activeFolder || '全部';
          self.sortBy = data.sortBy || 'updatedAt';
        }
      } catch (e) {}
      self.checkStorageUsage();
    },
    saveData: function() {
      var self = this;
      if (self.saveTimer) clearTimeout(self.saveTimer);
      self.saveTimer = setTimeout(function() {
        try {
          var data = {
            files: self.files,
            privateFiles: self.privateFiles,
            privatePassword: self.privacyPassword,
            editorFontSize: self.editorFontSize,
            editorWidthPercent: self.editorWidthPercent,
            activeFileId: self.activeFileId,
            viewMode: self.viewMode,
            folders: self.folders,
            activeFolder: self.activeFolder,
            sortBy: self.sortBy
          };
          localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(data));
          self._saveCount = (self._saveCount || 0) + 1;
          if (self._saveCount % 10 === 0) self.checkStorageUsage();
        } catch (e) {
          console.error('[Notes] 保存失败:', e);
          if (e.name === 'QuotaExceededError') {
            self.$store.commit('SHOW_TOAST', { message: '存储空间不足，已自动清理旧版本', type: 'warn' });
            self.cleanupOldVersions();
            try { localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(data)); } catch (e2) {}
          }
        }
      }, 300);
    },
    forceSave: function() {
      var self = this;
      if (self.saveTimer) clearTimeout(self.saveTimer);
      if (self.autoSaveTimer) clearTimeout(self.autoSaveTimer);
      try {
        var data = {
          files: self.files,
          privateFiles: self.privateFiles,
          privatePassword: self.privacyPassword,
          editorFontSize: self.editorFontSize,
          editorWidthPercent: self.editorWidthPercent,
          activeFileId: self.activeFileId,
          viewMode: self.viewMode,
          folders: self.folders,
          activeFolder: self.activeFolder,
          sortBy: self.sortBy
        };
        localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(data));
      } catch (e) {
        // beforeunload 中无法弹 toast，静默处理
      }
    },
    handleVisibilityChange: function() {
      if (document.visibilityState === 'hidden') {
        this.forceSave();
      }
    },
    cleanupOldVersions: function() {
      var self = this;
      var allFiles = (self.files || []).concat(self.privateFiles || []);
      var cleaned = false;
      for (var i = 0; i < allFiles.length; i++) {
        var f = allFiles[i];
        if (f.versions && f.versions.length > 5) {
          f.versions = f.versions.slice(f.versions.length - 5);
          cleaned = true;
        }
      }
      return cleaned;
    },
    checkStorageUsage: function() {
      var self = this;
      var total = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        total += (localStorage.getItem(key) || '').length * 2;
      }
      var limit = 5 * 1024 * 1024;
      var pct = Math.round((total / limit) * 100);
      if (pct > 80 && !self._storageWarned) {
        self._storageWarned = true;
        self.$store.commit('SHOW_TOAST', { message: '存储空间已使用 ' + pct + '%，建议清理旧版本', type: 'warn' });
      } else if (pct <= 70) {
        self._storageWarned = false;
      }
      return { used: total, limit: limit, percent: pct };
    },
    onFileChange: function() {
      var self = this;
      if (self.activeFile) {
        self.activeFile.updatedAt = new Date().toISOString();
      }
      self.autoSaveIndicator = false;
      self.saveData();
      if (self.autoSaveTimer) clearTimeout(self.autoSaveTimer);
      self.autoSaveTimer = setTimeout(function() {
        self.saveVersion();
        self.autoSaveIndicator = true;
        setTimeout(function() {
          self.autoSaveIndicator = false;
        }, 2000);
      }, 2500);
    },
    saveVersion: function() {
      var self = this;
      if (!self.activeFile) return;
      if (!self.activeFile.versions) {
        self.$set(self.activeFile, 'versions', []);
      }
      var now = new Date().toISOString();
      var versions = self.activeFile.versions;
      if (versions.length > 0) {
        var last = versions[versions.length - 1];
        if (last.content === self.activeFile.content && last.title === self.activeFile.title) return;
      }
      versions.push({
        timestamp: now,
        content: self.activeFile.content,
        title: self.activeFile.title
      });
      if (versions.length > 20) {
        self.activeFile.versions = versions.slice(versions.length - 20);
      }
    },
    previewVersion: function(ver) {
      var self = this;
      var content = ver.content || '';
      var result = LatexRenderer.processContent(content, marked);
      var html = DOMPurify.sanitize(result.html, {
        ADD_TAGS: ['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mtext', 'mspace', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msubsup', 'mmultiscripts', 'maction', 'svg', 'path', 'g', 'text', 'rect', 'circle', 'line', 'polygon', 'polyline', 'ellipse', 'defs', 'clipPath', 'marker', 'tspan', 'foreignObject', 'use', 'image', 'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'linearGradient', 'stop', 'pattern', 'desc', 'title', 'style'],
        ADD_ATTR: ['style', 'xmlns', 'viewBox', 'preserveAspectRatio', 'd', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'class', 'id', 'href', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'patternUnits', 'patternTransform', 'filterUnits', 'stdDeviation', 'dx', 'dy', 'result', 'in', 'in2', 'operator', 'k1', 'k2', 'k3', 'k4', 'displaystyle', 'scriptlevel', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'linethickness', 'notation', 'open', 'close', 'separators', 'stretchy', 'symmetric', 'lspace', 'rspace', 'largeop', 'movablelimits', 'accent', 'accentunder', 'align', 'columnalign', 'rowalign', 'columnspacing', 'rowspacing', 'columnlines', 'rowlines', 'frame', 'framespacing', 'equalcolumns', 'equalrows', 'minlabelspacing', 'side', 'subscriptshift', 'superscriptshift']
      });
      html = LatexRenderer.renderFinalHtml(html, result.placeholders);
      html = self.renderAnnotations(html);
      html = self.renderTodoItems(html);
      html = self.applyLinkPermission(html);
      self.versionPreviewHtml = html;
      self.showVersionPreview = true;
    },
    restoreVersion: function(ver) {
      var self = this;
      if (!self.activeFile) return;
      self.activeFile.content = ver.content;
      self.activeFile.title = ver.title;
      self.activeFile.updatedAt = new Date().toISOString();
      self.onFileChange();
      self.showVersionHistory = false;
      self.$store.commit('SHOW_TOAST', { message: '已恢复到历史版本', type: 'success' });
    },
    createFile: function() {
      var self = this;
      var file = {
        id: generateId(),
        title: '未命名笔记',
        content: '',
        type: 'note',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: false,
        canvasData: null,
        annotations: [],
        templateId: 'blank',
        versions: [],
        folder: self.targetFolder()
      };
      self.files.unshift(file);
      self.activeFileId = file.id;
      self.saveData();
      self.$nextTick(function() {
        if (self.$refs.editor) self.$refs.editor.focus();
      });
    },
    createFileFromTemplate: function(tpl) {
      var self = this;
      var now = new Date();
      var dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      var content = tpl.content.replace(/\{\{date\}\}/g, dateStr);
      var file = {
        id: generateId(),
        title: tpl.name + ' - ' + dateStr,
        content: content,
        type: 'note',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: false,
        canvasData: null,
        annotations: [],
        templateId: tpl.id,
        versions: [],
        folder: self.targetFolder()
      };
      self.files.unshift(file);
      self.activeFileId = file.id;
      self.showTemplatePicker = false;
      self.saveData();
      self.$nextTick(function() {
        if (self.$refs.editor) self.$refs.editor.focus();
      });
    },
    createPrivateFile: function() {
      var self = this;
      var file = {
        id: generateId(),
        title: '未命名隐私笔记',
        content: '',
        type: 'note',
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: true,
        canvasData: null,
        annotations: [],
        templateId: 'blank',
        versions: []
      };
      self.privateFiles.unshift(file);
      self.activeFileId = file.id;
      self.saveData();
    },
    selectFile: function(id) {
      var self = this;
      // 切换前自动保存画板数据
      if (self.isDrawFile && self.activeFile && self.activeFile.id !== id && self.$refs.drawCanvas) {
        try {
          var currentData = self.$refs.drawCanvas.getData();
          self.activeFile.canvasData = currentData;
        } catch(e) {}
      }
      // 切换前自动保存批注数据
      if (self.showAnnotationLayer && self.activeFile && self.$refs.annotationCanvas) {
        try {
          var annoData = self.$refs.annotationCanvas.getData();
          self.activeFile.canvasData = annoData;
        } catch(e) {}
      }
      self.activeFileId = id;
      self.saveData();
      if (self.useDrawer) self.closeDrawer();
    },
    deleteFile: function(id) {
      var self = this;
      var idx = self.files.findIndex(function(f) { return f.id === id; });
      if (idx > -1) {
        self.files.splice(idx, 1);
      } else {
        idx = self.privateFiles.findIndex(function(f) { return f.id === id; });
        if (idx > -1) self.privateFiles.splice(idx, 1);
      }
      if (self.activeFileId === id) {
        var remaining = self.files.concat(self.privateFiles);
        self.activeFileId = remaining.length > 0 ? remaining[0].id : null;
      }
      self.saveData();
    },
    startRename: function() {
      var self = this;
      self.renameTargetId = self.fileMenuTarget.id;
      self.renameInput = self.fileMenuTarget.title || '';
      self.showFileMenuModal = false;
      self.showRenameModal = true;
      self.$nextTick(function() {
        if (self.$refs.renameInput) self.$refs.renameInput.focus();
      });
    },
    confirmRename: function() {
      var self = this;
      if (!self.renameInput.trim()) return;
      var file = self.allFiles.find(function(f) { return f.id === self.renameTargetId; });
      if (file) {
        file.title = self.renameInput.trim();
        file.updatedAt = new Date().toISOString();
        self.saveData();
      }
      self.showRenameModal = false;
    },
    duplicateFile: function() {
      var self = this;
      var src = self.fileMenuTarget;
      var copy = {
        id: generateId(),
        title: src.title + ' (副本)',
        content: src.content,
        type: src.type || 'note',
        tags: (src.tags || []).slice(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: src.isPrivate,
        canvasData: (src.canvasData || []).slice(),
        annotations: (src.annotations || []).slice(),
        templateId: src.templateId || 'blank',
        versions: []
      };
      if (src.isPrivate) {
        self.privateFiles.unshift(copy);
      } else {
        self.files.unshift(copy);
      }
      self.activeFileId = copy.id;
      self.showFileMenuModal = false;
      self.saveData();
    },
    showFileMenu: function(e, file) {
      var self = this;
      self.fileMenuTarget = file;
      self.folderPickerFor = '';   // 每次开菜单都从收起状态开始
      self.fileMenuStyle = {
        left: e.clientX + 'px',
        top: e.clientY + 'px'
      };
      self.showFileMenuModal = true;
      var handler = function() {
        self.showFileMenuModal = false;
        self.folderPickerFor = '';
        document.removeEventListener('click', handler);
        self._activeFileMenuHandler = null;
      };
      self._activeFileMenuHandler = handler;
      setTimeout(function() {
        document.addEventListener('click', handler);
      }, 0);
    },
    deleteFileFromMenu: function() {
      var self = this;
      self.deleteFile(self.fileMenuTarget.id);
      self.showFileMenuModal = false;
    },
    moveToPrivate: function() {
      var self = this;
      if (!self.activeFile || self.activeFile.isPrivate) return;
      var idx = self.files.findIndex(function(f) { return f.id === self.activeFile.id; });
      if (idx > -1) {
        var file = self.files.splice(idx, 1)[0];
        file.isPrivate = true;
        self.privateFiles.unshift(file);
        self.saveData();
        self.$store.commit('SHOW_TOAST', { message: '已移入隐私空间', type: 'success' });
      }
    },
    moveToPublic: function() {
      var self = this;
      if (!self.activeFile || !self.activeFile.isPrivate) return;
      var idx = self.privateFiles.findIndex(function(f) { return f.id === self.activeFile.id; });
      if (idx > -1) {
        var file = self.privateFiles.splice(idx, 1)[0];
        file.isPrivate = false;
        self.files.unshift(file);
        self.saveData();
        self.$store.commit('SHOW_TOAST', { message: '已移出隐私空间', type: 'success' });
      }
    },
    moveToPrivateFromMenu: function() {
      var self = this;
      var file = self.fileMenuTarget;
      if (file.isPrivate) return;
      var idx = self.files.findIndex(function(f) { return f.id === file.id; });
      if (idx > -1) {
        var moved = self.files.splice(idx, 1)[0];
        moved.isPrivate = true;
        self.privateFiles.unshift(moved);
        self.saveData();
        self.$store.commit('SHOW_TOAST', { message: '已移入隐私空间', type: 'success' });
      }
      self.showFileMenuModal = false;
    },
    moveToPublicFromMenu: function() {
      var self = this;
      var file = self.fileMenuTarget;
      if (!file.isPrivate) return;
      var idx = self.privateFiles.findIndex(function(f) { return f.id === file.id; });
      if (idx > -1) {
        var moved = self.privateFiles.splice(idx, 1)[0];
        moved.isPrivate = false;
        self.files.unshift(moved);
        self.saveData();
        self.$store.commit('SHOW_TOAST', { message: '已移出隐私空间', type: 'success' });
      }
      self.showFileMenuModal = false;
    },
    openPrivacySpace: function() {
      var self = this;
      self.showPrivacyModal = true;
      self.privacyPasswordInput = '';
      self.privacyPasswordConfirm = '';
      // 已经全局解锁过（比如刚在对话侧输过密码）就直接进 ——
      // 再摆一个密码框会让人以为"密码没记住/失效了"。
      // 这正是"合为一个密码"要消除的体感。
      if (self.lockUnlocked) self.privacyUnlocked = true;
      self.$nextTick(function() {
        if (self.$refs.privacyInput) self.$refs.privacyInput.focus();
      });
    },
    verifyPrivacyPassword: function() {
      var self = this;
      // 统一密码：笔记的私密与「隐藏的对话」共用服务端那一份
      // （cluss_private_lock，scrypt hash + salt）。这里保留两条旧路径
      // 只是为了**迁移**，不解释的话没人敢删：
      //   ① 服务端已设过 → 直接校验；
      //   ② 服务端没有、本地有旧串 → 本地校验通过后立刻搬上服务端并清掉本地。
      //      本地那份是 XOR + 写死在源码里的 key，只是混淆不是加密，
      //      且清一次浏览器数据就"锁丢了人还能进"——搬走才是修好。
      if (!self.hasPrivacyPassword) {
        if (!self.privacyPasswordInput) return;
        if (self.privacyPasswordInput !== self.privacyPasswordConfirm) {
          self.$store.commit('SHOW_TOAST', { message: '两次密码不一致', type: 'error' });
          return;
        }
        self.$store.dispatch('lock/setup', self.privacyPasswordInput).then(function(r) {
          if (!r.ok) {
            self.$store.commit('SHOW_TOAST', { message: r.message || '设置失败', type: 'error' });
            return;
          }
          self.privacyUnlocked = true;
          self.saveData();
          self.$store.commit('SHOW_TOAST', { message: '密码设置成功', type: 'success' });
        });
        return;
      }

      // 已解锁过（刚在对话侧输过）：不必再问一次。
      // 这正是"合为一个密码"要解决的事——同一个人没必要记两遍。
      if (self.lockUnlocked) {
        self.privacyUnlocked = true;
        return;
      }

      // ① 服务端有密码 → 走服务端校验（顺带拿到 30 分钟解锁态）
      if (self.lockHasPassword) {
        self.$http.post('/private/verify', { password: self.privacyPasswordInput }).then(function(r) {
          var d = (r && r.data && r.data.data) || {};
          if (d.unlocked === false) {
            self.$store.commit('SHOW_TOAST', { message: '密码错误', type: 'error' });
            return;
          }
          self.$store.commit('lock/SET_STATUS', { hasPassword: true, unlocked: true });
          self.privacyUnlocked = true;
          self.$store.commit('SHOW_TOAST', { message: '解锁成功', type: 'success' });
        }).catch(function(e) {
          var msg = (e && e.response && e.response.data && e.response.data.message) || '密码错误';
          self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
        });
        return;
      }

      // ② 本地旧串：先按老办法验，通过就搬上服务端
      var decrypted = decrypt(self.privacyPassword, 'classintra_notes_key');
      if (decrypted !== self.privacyPasswordInput) {
        self.$store.commit('SHOW_TOAST', { message: '密码错误', type: 'error' });
        return;
      }
      self.$store.dispatch('lock/setup', self.privacyPasswordInput).then(function(r) {
        if (!r.ok) {
          // 搬不上去也先让进：本地校验已经通过了，功能不该被网络挡住
          self.privacyUnlocked = true;
          self.$store.commit('SHOW_TOAST', { message: '解锁成功', type: 'success' });
          return;
        }
        // 搬成功 → 清掉本地旧串。留着它意味着"源码里的 key 还能解开"，
        // 与把密码写成明文只隔一层 base64。
        // 用 forceSave 而不是 saveData：saveData 有 300ms 防抖，
        // 这期间关掉页面（本地串还在）等于迁移只做了一半。
        self.privacyPassword = '';
        self.privacyUnlocked = true;
        self.forceSave();
        self.$store.commit('SHOW_TOAST', { message: '解锁成功', type: 'success' });
      });
    },
    lockPrivacySpace: function() {
      this.privacyUnlocked = false;
      this.showPrivacyModal = false;
      // 一并清服务端解锁态：只收本地的话，对话侧的隐藏会话还开着，
      // "合为一个密码"就出现了两条寿命不同的锁。
      this.$store.dispatch('lock/lock');
      this.$store.commit('SHOW_TOAST', { message: '隐私空间已锁定', type: 'info' });
    },
    addTag: function() {
      var self = this;
      if (!self.newTagInput.trim() || !self.activeFile) return;
      var tag = self.newTagInput.trim();
      if (self.activeFile.tags.indexOf(tag) === -1) {
        self.activeFile.tags.push(tag);
        self.onFileChange();
      }
      self.newTagInput = '';
    },
    removeTag: function(tag) {
      var self = this;
      if (!self.activeFile) return;
      var idx = self.activeFile.tags.indexOf(tag);
      if (idx > -1) {
        self.activeFile.tags.splice(idx, 1);
        self.onFileChange();
      }
    },
    toggleTag: function(tag) {
      var self = this;
      if (!self.activeFile) return;
      var idx = self.activeFile.tags.indexOf(tag);
      if (idx > -1) {
        self.activeFile.tags.splice(idx, 1);
      } else {
        self.activeFile.tags.push(tag);
      }
      self.onFileChange();
    },
    // ============ 云盘图片/音视频插入 ============
    openCloudImagePicker: function() {
      // 打开选择器前保存编辑器光标位置，选择后在该位置插入
      var editor = this.$refs.editor;
      if (editor) {
        this.imageInsertPos = { start: editor.selectionStart, end: editor.selectionEnd };
      }
      this.showCloudPicker = true;
    },
    onCloudImageSelect: function(file) {
      var self = this;
      self.showCloudPicker = false;
      if (!file || !(file.hash || file.name)) return;
      // URL 附加扩展名，便于渲染器识别媒体类型
      var baseUrl = file.url || ('/api/cloud/files/' + encodeURIComponent(file.hash || file.name));
      var displayName = file.display_name || file.name;
      var ext = '';
      var dotIdx = displayName.lastIndexOf('.');
      if (dotIdx > -1) ext = displayName.substring(dotIdx);
      var url = baseUrl.indexOf('.') === -1 ? baseUrl + ext : baseUrl;
      // 图片附加缩放参数，加快加载
      if (url.indexOf('/api/cloud/files/') > -1 && url.indexOf('?w=') === -1) url += '?w=800';
      // 按文件类型分支：图片用 ![]()，音视频用 []()（customRenderer.link 渲染播放器）
      var type = self.getCloudFileType(file);
      var md = type === 'image' ? '![' + displayName + '](' + url + ')' : '[' + displayName + '](' + url + ')';
      var editor = self.$refs.editor;
      if (!editor) {
        // 兜底：追加到末尾
        self.activeFile.content = (self.activeFile.content || '') + '\n' + md + '\n';
        self.onFileChange();
        return;
      }
      // 在保存的光标位置插入（若未保存则用当前光标）
      var pos = self.imageInsertPos || { start: editor.selectionStart, end: editor.selectionEnd };
      var text = editor.value || '';
      var before = text.substring(0, pos.start);
      var after = text.substring(pos.end);
      var insertText = (before && !before.endsWith('\n') ? '\n' : '') + md + '\n';
      self.activeFile.content = before + insertText + after;
      self.imageInsertPos = null;
      // 恢复编辑器焦点并将光标移到插入内容之后
      self.$nextTick(function() {
        editor.focus();
        var cursorPos = (before + insertText).length;
        editor.setSelectionRange(cursorPos, cursorPos);
      });
      self.onFileChange();
    },
    getCloudFileType: function(file) {
      // 优先使用 mime_type，回退到文件名解析
      if (file && file.mime_type) {
        if (file.mime_type.indexOf('image/') === 0) return 'image';
        if (file.mime_type.indexOf('video/') === 0) return 'video';
        if (file.mime_type.indexOf('audio/') === 0) return 'audio';
      }
      var name = (file && (file.name || file.display_name)) || '';
      var lower = name.toLowerCase();
      if (lower.indexOf('__audio') > -1) return 'audio';
      if (lower.indexOf('__video') > -1) return 'video';
      if (lower.indexOf('__image') > -1) return 'image';
      var VID_EXTS = ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.3gp'];
      var AUD_EXTS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus'];
      var IMG_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      for (var v = 0; v < VID_EXTS.length; v++) { if (lower.indexOf(VID_EXTS[v]) > -1) return 'video'; }
      for (var a = 0; a < AUD_EXTS.length; a++) { if (lower.indexOf(AUD_EXTS[a]) > -1) return 'audio'; }
      for (var i = 0; i < IMG_EXTS.length; i++) { if (lower.indexOf(IMG_EXTS[i]) > -1) return 'image'; }
      return 'other';
    },
    insertMarkdown: function(type) {
      var self = this;
      var editor = self.$refs.editor;
      if (!editor) return;
      var start = editor.selectionStart;
      var end = editor.selectionEnd;
      var text = editor.value;
      var selected = text.substring(start, end);
      var before = text.substring(0, start);
      var after = text.substring(end);
      var insert = '';
      var cursorOffset = 0;

      switch (type) {
        case 'bold':
          insert = '**' + (selected || '粗体文本') + '**';
          cursorOffset = selected ? insert.length : 2;
          break;
        case 'italic':
          insert = '*' + (selected || '斜体文本') + '*';
          cursorOffset = selected ? insert.length : 1;
          break;
        case 'strikethrough':
          insert = '~~' + (selected || '删除线文本') + '~~';
          cursorOffset = selected ? insert.length : 2;
          break;
        case 'h1':
          insert = '\n# ' + (selected || '标题') + '\n';
          cursorOffset = 3;
          break;
        case 'h2':
          insert = '\n## ' + (selected || '标题') + '\n';
          cursorOffset = 4;
          break;
        case 'h3':
          insert = '\n### ' + (selected || '标题') + '\n';
          cursorOffset = 5;
          break;
        case 'ul':
          insert = '\n- ' + (selected || '列表项') + '\n';
          cursorOffset = 3;
          break;
        case 'ol':
          insert = '\n1. ' + (selected || '列表项') + '\n';
          cursorOffset = 4;
          break;
        case 'todo':
          insert = '\n- [ ] ' + (selected || '待办事项') + '\n';
          cursorOffset = 7;
          break;
        case 'code':
          insert = '`' + (selected || '代码') + '`';
          cursorOffset = selected ? insert.length : 1;
          break;
        case 'codeblock':
          insert = '\n```\n' + (selected || '代码内容') + '\n```\n';
          cursorOffset = 5;
          break;
        case 'link':
          insert = '[' + (selected || '链接文本') + '](url)';
          cursorOffset = selected ? insert.length - 1 : 1;
          break;
        case 'image':
          insert = '![' + (selected || '图片描述') + '](url)';
          cursorOffset = selected ? insert.length - 1 : 2;
          break;
        case 'quote':
          insert = '\n> ' + (selected || '引用内容') + '\n';
          cursorOffset = 3;
          break;
        case 'annotation':
          // 使用新的批注卡片系统
          self.addAnnotationCard(selected || '');
          return;
        case 'table':
          insert = '\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n';
          cursorOffset = 3;
          break;
        case 'hr':
          insert = '\n---\n';
          cursorOffset = insert.length;
          break;
        case 'latex-inline':
          insert = '$' + (selected || 'x^2') + '$';
          cursorOffset = selected ? insert.length : 1;
          break;
        case 'latex-block':
          insert = '\n$$\n' + (selected || 'x^2') + '\n$$\n';
          cursorOffset = 4;
          break;
        case 'mermaid-flowchart':
          insert = '\n```mermaid\ngraph TD\n    A[开始] --> B{判断}\n    B -->|是| C[执行]\n    B -->|否| D[结束]\n```\n';
          cursorOffset = 19;
          break;
        case 'mermaid-gantt':
          insert = '\n```mermaid\ngantt\n    title 项目计划\n    dateFormat  YYYY-MM-DD\n    section 阶段一\n    需求分析     :a1, 2024-01-01, 5d\n    系统设计     :a2, after a1, 3d\n    section 阶段二\n    开发实现     :b1, after a2, 10d\n    测试验收     :b2, after b1, 5d\n```\n';
          cursorOffset = 19;
          break;
        case 'mermaid-mindmap':
          insert = '\n```mermaid\nmindmap\n  root((中心主题))\n    分支一\n      子主题1\n      子主题2\n    分支二\n      子主题3\n    分支三\n```\n';
          cursorOffset = 19;
          break;
        case 'mermaid-sequence':
          insert = '\n```mermaid\nsequenceDiagram\n    participant A as 参与者A\n    participant B as 参与者B\n    A->>B: 请求\n    B-->>A: 响应\n```\n';
          cursorOffset = 19;
          break;
        default:
          return;
      }

      self.activeFile.content = before + insert + after;
      self.$nextTick(function() {
        var pos = start + cursorOffset;
        editor.setSelectionRange(pos, pos);
        editor.focus();
        self.onFileChange();
      });
    },
    onEditorKeydown: function(e) {
      var self = this;
      if (self.isResizing) return;
      if (e.key === 'Enter') {
        var editor = self.$refs.editor;
        if (!editor) return;
        var pos = editor.selectionStart;
        var text = editor.value;
        var lineStart = text.lastIndexOf('\n', pos - 1) + 1;
        var currentLine = text.substring(lineStart, pos);
        var indent = currentLine.match(/^(\s*)/)[1];
        var listMatch = currentLine.match(/^(\s*)([-*+]|\d+\.)\s/);
        if (listMatch) {
          e.preventDefault();
          var prefix = listMatch[1] + (listMatch[2].match(/\d+/) ? (parseInt(listMatch[2]) + 1) + '. ' : listMatch[2] + ' ');
          var todoMatch = currentLine.match(/^(\s*)([-*+])\s\[[ x]\]\s/);
          if (todoMatch) {
            prefix = todoMatch[1] + todoMatch[2] + ' [ ] ';
          }
          var insert = '\n' + prefix;
          self.activeFile.content = text.substring(0, pos) + insert + text.substring(pos);
          self.$nextTick(function() {
            var newPos = pos + insert.length;
            editor.setSelectionRange(newPos, newPos);
            self.onFileChange();
          });
          return;
        }
        if (indent) {
          e.preventDefault();
          var insertStr = '\n' + indent;
          self.activeFile.content = text.substring(0, pos) + insertStr + text.substring(pos);
          self.$nextTick(function() {
            var newPos = pos + insertStr.length;
            editor.setSelectionRange(newPos, newPos);
            self.onFileChange();
          });
        }
      }
    },
    onGlobalKeydown: function(e) {
      var self = this;
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        self.saveData();
        self.autoSaveIndicator = true;
        setTimeout(function() { self.autoSaveIndicator = false; }, 2000);
        self.$store.commit('SHOW_TOAST', { message: '已保存', type: 'success' });
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        self.showTemplatePicker = true;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        if (self.activeFile) {
          e.preventDefault();
          self.insertMarkdown('bold');
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
        if (self.activeFile) {
          e.preventDefault();
          self.insertMarkdown('italic');
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        self.adjustFontSize(1);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        self.adjustFontSize(-1);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        self.showCommandPalette = true;
        self.commandPaletteQuery = '';
        self.$nextTick(function() {
          if (self.$refs.commandPaletteInput) self.$refs.commandPaletteInput.focus();
        });
      }
      if (e.key === 'Escape') {
        if (self.showCommandPalette) {
          self.showCommandPalette = false;
        }
      }
    },
    adjustFontSize: function(delta) {
      this.editorFontSize = Math.max(12, Math.min(24, this.editorFontSize + delta));
      this.saveData();
    },
    syncScroll: function() {
      var self = this;
      if (self.isSyncingScroll || self.isMobile || self.viewMode !== 'split') return;
      self.isSyncingScroll = true;
      var editor = self.$refs.editor;
      var preview = self.$refs.previewContainer;
      if (editor && preview) {
        var ratio = editor.scrollTop / (editor.scrollHeight - editor.clientHeight || 1);
        preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
      }
      self.$nextTick(function() {
        self.isSyncingScroll = false;
      });
    },
    syncPreviewScroll: function() {
      var self = this;
      if (self.isSyncingScroll || self.isMobile || self.isResizing || self.viewMode !== 'split') return;
      self.isSyncingScroll = true;
      var editor = self.$refs.editor;
      var preview = self.$refs.previewContainer;
      if (editor && preview) {
        var ratio = preview.scrollTop / (preview.scrollHeight - preview.clientHeight || 1);
        editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
      }
      self.$nextTick(function() {
        self.isSyncingScroll = false;
      });
    },
    startResize: function(e) {
      var self = this;
      e.preventDefault();
      self.isResizing = true;
      var mainEl = self.$el.querySelector('.notes-main');
      if (!mainEl) return;
      var editorArea = mainEl.querySelector('.editor-area');
      var previewArea = mainEl.querySelector('.preview-area');
      if (editorArea) editorArea.classList.add('resizing');
      if (previewArea) previewArea.classList.add('resizing');
      var isTouch = e.type === 'touchstart';
      var startX = isTouch ? e.touches[0].clientX : e.clientX;
      var startPercent = self.editorWidthPercent;
      var mainWidth = mainEl.offsetWidth;

      function onMove(ev) {
        var cx = isTouch ? ev.touches[0].clientX : ev.clientX;
        var dx = cx - startX;
        var newPercent = startPercent + (dx / mainWidth) * 100;
        if (newPercent < 30) newPercent = 30;
        if (newPercent > 82) newPercent = 82;
        self.editorWidthPercent = newPercent;
      }

      function onEnd() {
        self.isResizing = false;
        if (editorArea) editorArea.classList.remove('resizing');
        if (previewArea) previewArea.classList.remove('resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        self.saveData();
      }

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
    },
    renderAnnotations: function(html) {
      return html.replace(
        /<blockquote>\s*<p>\[批注\]\s*([\s\S]*?)<\/p>\s*<\/blockquote>/g,
        '<div class="note-annotation"><span class="annotation-label">批注</span>$1</div>'
      );
    },
    renderTodoItems: function(html) {
      html = html.replace(
        /<li>\s*\[\s*\]\s*/g,
        '<li class="todo-item"><input type="checkbox" class="todo-checkbox" data-checked="false" /> '
      );
      html = html.replace(
        /<li>\s*\[x\]\s*/gi,
        '<li class="todo-item todo-done"><input type="checkbox" class="todo-checkbox" checked data-checked="true" /> '
      );
      return html;
    },
    bindTodoClicks: function() {
      var self = this;
      var preview = self.$refs.previewContainer;
      if (!preview) return;
      var checkboxes = preview.querySelectorAll('.todo-checkbox');
      for (var i = 0; i < checkboxes.length; i++) {
        checkboxes[i].onclick = function(e) {
          e.preventDefault();
          var isChecked = this.getAttribute('data-checked') === 'true';
          self.toggleTodoItem(!isChecked);
        };
      }
    },
    toggleTodoItem: function(toChecked) {
      var self = this;
      if (!self.activeFile || !self.activeFile.content) return;
      var editor = self.$refs.editor;
      if (!editor) return;
      var pos = editor.selectionStart;
      var lines = self.activeFile.content.split('\n');
      var charCount = 0;
      var targetLine = -1;
      for (var i = 0; i < lines.length; i++) {
        var lineLen = lines[i].length + 1;
        if (charCount <= pos && pos < charCount + lineLen) {
          targetLine = i;
          break;
        }
        charCount += lineLen;
      }
      if (targetLine === -1) {
        for (var j = 0; j < lines.length; j++) {
          if (toChecked && lines[j].match(/^- \[ \] /)) {
            lines[j] = lines[j].replace(/^- \[ \] /, '- [x] ');
            targetLine = j;
            break;
          } else if (!toChecked && lines[j].match(/^- \[x\] /i)) {
            lines[j] = lines[j].replace(/^- \[x\] /i, '- [ ] ');
            targetLine = j;
            break;
          }
        }
      } else {
        if (toChecked) {
          lines[targetLine] = lines[targetLine].replace(/^- \[ \] /, '- [x] ');
        } else {
          lines[targetLine] = lines[targetLine].replace(/^- \[x\] /i, '- [ ] ');
        }
      }
      self.activeFile.content = lines.join('\n');
      self.onFileChange();
    },
    openResourcePicker: function() {
      var self = this;
      self.showResourcePicker = true;
      self.resourcePickerPath = '/';
      self.loadResourcePickerItems();
    },
    // Cluss 没有 ClassIntra 的资源仓库：改为从本机云盘导入 .md/.txt。
    // 云盘是扁平列表（无目录），一次拉全量文本文件即可。
    loadResourcePickerItems: function() {
      var self = this;
      self.resourcePickerLoading = true;
      self.resourcePickerError = '';
      api.get('/cloud/files', { params: { kind: 'text' } })
        .then(function(response) {
          var files = (response.data.data && response.data.data.files) || [];
          self.resourcePickerItems = files.filter(function(f) {
            var ext = (f.name || '').split('.').pop().toLowerCase();
            return ext === 'md' || ext === 'markdown' || ext === 'txt';
          }).map(function(f) {
            var dot = (f.name || '').lastIndexOf('.');
            return {
              name: f.name,
              hash: f.hash,
              size: f.size,
              extension: dot > -1 ? f.name.slice(dot + 1) : '',
              is_dir: false
            };
          });
          self.resourcePickerLoading = false;
        })
        .catch(function() {
          // 整块列表加载失败：改用弹窗内 ErrorBanner（可重试），不再只弹一条 toast；
          // 它也让「云盘里没有可导入的文件」这条误导性空态不再出现
          self.resourcePickerError = '加载云盘文件失败';
          self.resourcePickerLoading = false;
        });
    },
    onResourcePickerItemClick: function(item) {
      var self = this;
      // 云盘为扁平结构，目录分支不会命中；保留扩展名拦截
      var ext = (item.extension || '').toLowerCase();
      if (ext !== 'txt' && ext !== 'md' && ext !== 'markdown') {
        self.$store.commit('SHOW_TOAST', { message: '仅支持导入 .txt 和 .md 文件', type: 'warning' });
        return;
      }
      // 正文在云盘是内容寻址文件：按 hash 读回。transformResponse 保持原样字符串，
      // 避免 axios 按默认 JSON 解析把 markdown 原文吃掉
      api.get('/cloud/files/' + item.hash, {
        responseType: 'text',
        transformResponse: [function(d) { return d; }]
      })
        .then(function(response) {
          var content = typeof response.data === 'string' ? response.data : '';
          var newFile = {
            id: generateId(),
            title: item.name.replace(/\.(txt|md)$/i, ''),
            content: content,
            tags: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isPrivate: false,
            canvasData: [],
            templateId: 'blank',
            versions: [],
            folder: self.targetFolder()
          };
          self.files.unshift(newFile);
          self.activeFileId = newFile.id;
          self.saveData();
          self.showResourcePicker = false;
          self.$store.commit('SHOW_TOAST', { message: '导入成功: ' + item.name, type: 'success' });
        })
        .catch(function() {
          self.$store.commit('SHOW_TOAST', { message: '读取文件失败', type: 'error' });
        });
    },
    goResourcePickerBack: function() {
      var self = this;
      var parts = self.resourcePickerPath.split('/');
      parts.pop();
      var parentPath = parts.join('/') || '/';
      self.resourcePickerPath = parentPath;
      self.loadResourcePickerItems(parentPath);
    },
    getItemIcon: function(item) {
      var ext = (item.extension || '').toLowerCase();
      if (ext === 'md' || ext === 'markdown') return 'fa-file-lines';
      if (ext === 'txt') return 'fa-file-alt';
      return 'fa-file';
    },
    formatFileSize: function(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },
    // ---- AI 辅助（Cluss 特有）----
    loadWallet: function() {
      this.$store.dispatch('auth/fetchWallet').then(function(w) {
        if (w !== undefined) this.wallet = w;
      }.bind(this)).catch(function() { /* 拉不到就保持旧值 */ });
    },
    // 走 /api/notes/assist：服务端会引用相关历史笔记与当前编辑内容。
    // 结果先落在 assistResult 里预览，不直接改正文（改错了没法撤销会很难受）。
    runAssist: function(action) {
      var self = this;
      self.assistMenuOpen = false;
      var content = (self.activeFile && self.activeFile.content) || '';
      if (!content.trim()) {
        self.$store.commit('SHOW_TOAST', { message: '笔记还是空的，先写点什么', type: 'warning' });
        return;
      }
      if (self.assisting) return;
      // 客户端预检：余额一眼见底就没必要发起请求（服务端 402 仍是最终权威）
      if (self.walletExhausted) {
        self.$store.commit('SHOW_TOAST', { message: '积分已用完，请联系管理员充值', type: 'warning' });
        return;
      }

      self.assisting = true;
      self.assistResult = '';
      self.assistHtml = '';

      var controller = new AbortController();
      this._assistAbort = controller;

      postStream('/api/notes/assist', this.$store.state.auth.token, {
        action: action,
        // 传当前笔记的真实 id：服务端靠它把"正在编辑的这一篇"从相关历史笔记里排除。
        // 之前硬编码 0，等于没排除 —— 模型会把自己正在写的这篇当参照物读回来。
        note_id: (self.activeFile && self.activeFile.id) || '',
        title: self.activeFile.title || '',
        content: content,
        tags: self.activeFile.tags || [],
        // 学习偏好：服务端 turn-runner 从 body 读它来注入「讲解风格/常学科目/
        // 是否参考学习记录」。这里漏带过一整子 —— AI 辅助是笔记页唯一的模型入口，
        // 不带就等于学生在设置里改的东西在笔记页完全不打折。
        student_prefs: readStudentPrefs()
      }, controller.signal).then(function(resp) {
        return readSseStream(resp, {
          onDelta: function(text) {
            self.assistResult += text;
            self.scheduleAssistRender();
          },
          onDone: function(done) {
            // 记账完成后服务端会在 done 里带最新余额，这里同步刷新本地钱包
            self.loadWallet();
            if (done && done.estimated) {
              self.$store.commit('SHOW_TOAST', { message: '本次用量为估算值（上游未返回精确用量）', type: 'info' });
            }
          },
          onError: function(message) {
            self.$store.commit('SHOW_TOAST', { message: message || 'AI 处理失败', type: 'error' });
          }
        });
      }).catch(function(err) {
        if (err && err.name === 'AbortError') return; // 主动停止：保留已生成的部分
        self.$store.commit('SHOW_TOAST', { message: (err && err.message) || 'AI 处理失败', type: 'error' });
        // 402 说明本地钱包是旧的（或刚好在别处花完了），刷新之
        if (err && err.status === 402) self.loadWallet();
      }).then(function() {
        self.assisting = false;
        self._assistAbort = null;
        if (self._assistRender) {
          clearTimeout(self._assistRender);
          self._assistRender = null;
        }
        // 收尾必须补一次完整渲染：节流期间最后几个字可能还没画上去，
        // 中断/报错时已收到的部分内容也要渲染出来（积分已经花了，内容别白拿）
        if (self.assistResult) {
          self.assistHtml = self.renderMarkdown(self.assistResult);
        }
      });
    },
    // 生成中停止：保留已生成的部分——积分已经花了，内容不该跟着扔
    stopAssist: function() {
      if (this._assistAbort) this._assistAbort.abort();
    },
    discardAssist: function() {
      this.assistResult = '';
      this.assistHtml = '';
    },
    // 边流边渲染（节流）：markdown 解析不便宜，逐 delta 全量渲染长文会掉帧
    scheduleAssistRender: function() {
      var self = this;
      if (this._assistRender) clearTimeout(this._assistRender);
      this._assistRender = setTimeout(function() {
        self._assistRender = null;
        self.assistHtml = self.renderMarkdown(self.assistResult);
      }, 150);
    },
    // 采纳建议：替换正文或追加到末尾。替换是破坏性动作，正文非空时先确认。
    applyAssist: function(mode) {
      var self = this;
      if (!self.assistResult || !self.activeFile) return;
      var apply = function() {
        if (mode === 'replace') {
          self.activeFile.content = self.assistResult;
        } else {
          var sep = (self.activeFile.content && self.activeFile.content.trim()) ? '\n\n' : '';
          self.activeFile.content = (self.activeFile.content || '') + sep + self.assistResult;
        }
        self.onFileChange();
        self.discardAssist();
      };
      if (mode === 'replace' && self.activeFile.content && self.activeFile.content.trim()) {
        self.$store.dispatch('confirm', { message: '替换后当前正文会被覆盖，确定吗？', confirmText: '替换' }).then(function(ok) {
          if (ok) apply();
        });
      } else {
        apply();
      }
    },
    highlightSearch: function(text) {
      var self = this;
      if (!self.searchQuery || self.searchQuery.indexOf('#') === 0) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      var q = self.searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var regex = new RegExp('(' + q + ')', 'gi');
      return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
    },
    formatDate: function(dateStr) {
      if (!dateStr) return '';
      var d = new Date(dateStr);
      var now = new Date();
      var diff = now - d;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      if (diff < 604800000) return Math.floor(diff / 86400000) + '天前';
      var month = d.getMonth() + 1;
      var day = d.getDate();
      var hours = d.getHours().toString().padStart(2, '0');
      var minutes = d.getMinutes().toString().padStart(2, '0');
      return month + '/' + day + ' ' + hours + ':' + minutes;
    },
    onResize: function() {
      this.isMobile = window.innerWidth <= 768;
    },
    // 排序菜单：与「更多」同一套 click-away，避免菜单点不开也关不掉
    toggleSortMenu: function() {
      var self = this;
      if (self.sortMenuOpen) {
        self.closeSortMenu();
        return;
      }
      self.sortMenuOpen = true;
      var handler = function() {
        self.closeSortMenu();
        document.removeEventListener('click', handler);
      };
      self._sortMenuHandler = handler;
      setTimeout(function() {
        document.addEventListener('click', handler);
      }, 0);
    },
    closeSortMenu: function() {
      this.sortMenuOpen = false;
      if (this._sortMenuHandler) {
        document.removeEventListener('click', this._sortMenuHandler);
        this._sortMenuHandler = null;
      }
    },
    pickSort: function(value) {
      this.sortBy = value;
      this.closeSortMenu();
      this.saveData();
    },
    // 「更多」菜单：点开后在 document 上挂一次性 click-away（沿用 showFileMenu 的写法），
    // 不这么做的话点别处菜单不消失，学生会以为页面卡住了
    toggleMoreMenu: function() {
      var self = this;
      if (self.moreMenuOpen) {
        self.closeMoreMenu();
        return;
      }
      self.moreMenuOpen = true;
      self.assistMenuOpen = false;
      var handler = function() {
        self.closeMoreMenu();
        document.removeEventListener('click', handler);
      };
      self._moreMenuHandler = handler;
      setTimeout(function() {
        document.addEventListener('click', handler);
      }, 0);
    },
    closeMoreMenu: function() {
      this.moreMenuOpen = false;
      if (this._moreMenuHandler) {
        document.removeEventListener('click', this._moreMenuHandler);
        this._moreMenuHandler = null;
      }
    },
    applyMore: function(action) {
      this.closeMoreMenu();
      this.insertMarkdown(action);
    },
    openCommandPalette: function() {
      this.closeMoreMenu();
      this.showCommandPalette = true;
      this.commandPaletteQuery = '';
    },
    renderMermaidCharts: function(retryCount) {
      var self = this;
      if (mermaidRenderDebounce) clearTimeout(mermaidRenderDebounce);
      var attempt = retryCount || 0;
      mermaidRenderDebounce = setTimeout(function() {
        var preview = self.$refs.previewContainer;
        if (!preview) {
          if (attempt < 5) {
            self.renderMermaidCharts(attempt + 1);
          }
          return;
        }
        var charts = preview.querySelectorAll('.mermaid-chart');
        if (charts.length === 0) {
          self.bindMermaidChartActions();
          return;
        }
        var renderQueue = [];
        charts.forEach(function(el) {
          var rawB64 = el.getAttribute('data-raw-b64');
          if (!rawB64) {
            if (!el.querySelector('svg') && !el.querySelector('.mermaid-error')) {
              var chartId = el.id;
              if (chartId) {
                var idx = parseInt(chartId.replace('mermaid-chart-', ''), 10);
                var rawCode = self.extractMermaidCodeFromContent(idx);
                if (rawCode) {
                  rawB64 = utf8ToBase64(rawCode);
                  el.setAttribute('data-raw-b64', rawB64);
                }
              }
            }
          }
          if (!rawB64) return;
          var decodedCode;
          try {
            decodedCode = base64ToUtf8(rawB64);
          } catch (e) {
            try { decodedCode = atob(rawB64); } catch (e2) { return; }
          }
          var chartId = el.id;
          renderQueue.push({ el: el, code: decodedCode, id: chartId });
        });
        if (renderQueue.length === 0) {
          self.bindMermaidChartActions();
          return;
        }
        var idx = 0;
        function renderNext() {
          if (idx >= renderQueue.length) {
            self.$nextTick(function() {
              self.bindMermaidChartActions();
            });
            return;
          }
          var item = renderQueue[idx];
          idx++;
          var svgId = item.id + '-svg-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);

          // Pre-validate syntax with mermaid.parse() before attempting render
          try {
            mermaid.parse(item.code);
          } catch (parseErr) {
            var parseMsg = parseErr.message || String(parseErr);
            console.warn('[Mermaid] Parse error:', parseMsg);
            item.el.innerHTML = '<div class="mermaid-error"><i class="fa-solid fa-triangle-exclamation"></i> 语法错误<div class="mermaid-error-code"><pre>' + parseMsg.replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</pre></div></div>';
            item.el.removeAttribute('data-raw-b64');
            renderNext();
            return;
          }

          try {
            var renderResult = mermaid.render(svgId, item.code);
            if (renderResult && typeof renderResult.then === 'function') {
              renderResult.then(function(result) {
                if (result && result.svg) {
                  item.el.innerHTML = result.svg;
                  var svg = item.el.querySelector('svg');
                  if (svg) {
                    svg.style.maxWidth = '100%';
                    svg.style.height = 'auto';
                  }
                } else {
                  item.el.innerHTML = '<div class="mermaid-error"><i class="fa-solid fa-triangle-exclamation"></i> 图表渲染结果为空</div>';
                }
                item.el.removeAttribute('data-raw-b64');
                renderNext();
              }).catch(function(err) {
                var errMsg = (err && (err.message || String(err))) || '未知错误';
                console.warn('[Mermaid] Render error:', errMsg);
                item.el.innerHTML = '<div class="mermaid-error"><i class="fa-solid fa-triangle-exclamation"></i> 图表渲染失败<div class="mermaid-error-code"><pre>' + errMsg.replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</pre></div></div>';
                item.el.removeAttribute('data-raw-b64');
                renderNext();
              });
            } else if (renderResult && renderResult.svg) {
              // Synchronous result (fallback for older Mermaid)
              item.el.innerHTML = renderResult.svg;
              item.el.removeAttribute('data-raw-b64');
              var svg = item.el.querySelector('svg');
              if (svg) {
                svg.style.maxWidth = '100%';
                svg.style.height = 'auto';
              }
              renderNext();
            } else {
              // No valid result
              item.el.innerHTML = '<div class="mermaid-error"><i class="fa-solid fa-triangle-exclamation"></i> 图表渲染结果异常</div>';
              item.el.removeAttribute('data-raw-b64');
              renderNext();
            }
          } catch (e) {
            var errMsg = (e && (e.message || String(e))) || '未知异常';
            console.warn('[Mermaid] Render exception:', errMsg);
            item.el.innerHTML = '<div class="mermaid-error"><i class="fa-solid fa-triangle-exclamation"></i> 图表渲染失败<div class="mermaid-error-code"><pre>' + errMsg.replace(/</g, '&lt;').replace(/\n/g, '<br>') + '</pre></div></div>';
            item.el.removeAttribute('data-raw-b64');
            renderNext();
          }
        }
        renderNext();
      }, 150);
    },
    bindMermaidChartActions: function() {
      var self = this;
      var preview = self.$refs.previewContainer;
      if (!preview) return;
      if (self._mermaidActionsBound) return;
      self._mermaidActionsBound = true;
      preview.addEventListener('click', function(e) {
        var btn = e.target.closest('.mermaid-edit-btn');
        if (btn) {
          var chartId = btn.getAttribute('data-chart-id');
          var chartEl = document.getElementById(chartId);
          if (chartEl) {
            var rawB64 = chartEl.getAttribute('data-raw-b64');
            var rawCode = '';
            if (rawB64) {
              try {
                rawCode = base64ToUtf8(rawB64);
              } catch (e2) {
                try { rawCode = atob(rawB64); } catch (e3) { rawCode = ''; }
              }
            }
            if (!rawCode) {
              var idx = parseInt(chartId.replace('mermaid-chart-', ''), 10);
              rawCode = self.extractMermaidCodeFromContent(idx);
            }
            self.openChartEditor(rawCode);
          }
          return;
        }
        var zoomBtn = e.target.closest('.mermaid-zoom-btn');
        if (zoomBtn) {
          var chartId2 = zoomBtn.getAttribute('data-chart-id');
          var chartEl2 = document.getElementById(chartId2);
          if (chartEl2) {
            self.zoomMermaidChart(chartEl2);
          }
          return;
        }
      });
    },
    extractMermaidCodeFromContent: function(chartIndex) {
      var self = this;
      if (!self.activeFile || !self.activeFile.content) return '';
      var content = self.activeFile.content;
      var regex = /```mermaid\n([\s\S]*?)```/g;
      var match;
      var count = 0;
      while ((match = regex.exec(content)) !== null) {
        count++;
        if (count === chartIndex) {
          return match[1].trim();
        }
      }
      return '';
    },
    zoomMermaidChart: function(chartEl) {
      var self = this;
      var svgHtml = chartEl.innerHTML;
      self.mermaidZoomContent = svgHtml;
      self.mermaidZoomScale = 1;
      self.mermaidZoomPanX = 0;
      self.mermaidZoomPanY = 0;
      self.showMermaidZoom = true;
      self.$nextTick(function() {
        self.fitZoomToViewport();
      });
    },
    closeMermaidZoom: function() {
      this.showMermaidZoom = false;
      this.mermaidZoomContent = '';
    },
    // Fit the SVG to the viewport on open
    fitZoomToViewport: function() {
      var self = this;
      var viewport = self.$refs.zoomViewport;
      if (!viewport) return;
      var svg = viewport.querySelector('svg');
      if (!svg) return;
      var vw = viewport.clientWidth;
      var vh = viewport.clientHeight;
      var sw = svg.getAttribute('width') ? parseFloat(svg.getAttribute('width')) : (svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : vw);
      var sh = svg.getAttribute('height') ? parseFloat(svg.getAttribute('height')) : (svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.height : vh);
      if (!sw || !sh || sw <= 0 || sh <= 0) return;
      var scaleX = (vw - 80) / sw;
      var scaleY = (vh - 80) / sh;
      var fitScale = Math.min(scaleX, scaleY, 2);
      if (fitScale < 0.3) fitScale = 0.3;
      self.mermaidZoomScale = fitScale;
      self.mermaidZoomPanX = 0;
      self.mermaidZoomPanY = 0;
    },
    zoomIn: function() {
      this.mermaidZoomScale = Math.min(5, this.mermaidZoomScale * 1.25);
    },
    zoomOut: function() {
      this.mermaidZoomScale = Math.max(0.2, this.mermaidZoomScale / 1.25);
    },
    resetZoom: function() {
      this.mermaidZoomScale = 1;
      this.mermaidZoomPanX = 0;
      this.mermaidZoomPanY = 0;
    },
    onZoomWheel: function(e) {
      var delta = e.deltaY > 0 ? -0.1 : 0.1;
      var newScale = Math.max(0.2, Math.min(5, this.mermaidZoomScale + delta));
      // Zoom toward cursor position
      var viewport = this.$refs.zoomViewport;
      if (viewport) {
        var rect = viewport.getBoundingClientRect();
        var mx = e.clientX - rect.left;
        var my = e.clientY - rect.top;
        var ratio = newScale / this.mermaidZoomScale;
        this.mermaidZoomPanX = mx - ratio * (mx - this.mermaidZoomPanX);
        this.mermaidZoomPanY = my - ratio * (my - this.mermaidZoomPanY);
      }
      this.mermaidZoomScale = newScale;
    },
    onZoomPanStart: function(e) {
      this.mermaidZoomPanning = true;
      this.mermaidZoomLastX = e.clientX;
      this.mermaidZoomLastY = e.clientY;
    },
    onZoomPanMove: function(e) {
      if (!this.mermaidZoomPanning) return;
      var dx = e.clientX - this.mermaidZoomLastX;
      var dy = e.clientY - this.mermaidZoomLastY;
      this.mermaidZoomPanX += dx;
      this.mermaidZoomPanY += dy;
      this.mermaidZoomLastX = e.clientX;
      this.mermaidZoomLastY = e.clientY;
    },
    onZoomPanEnd: function() {
      this.mermaidZoomPanning = false;
    },
    onZoomTouchStart: function(e) {
      if (e.touches.length === 1) {
        this.mermaidZoomPanning = true;
        this.mermaidZoomLastX = e.touches[0].clientX;
        this.mermaidZoomLastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        this.mermaidZoomPanning = false;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        this.mermaidZoomTouchDist = Math.sqrt(dx * dx + dy * dy);
      }
    },
    onZoomTouchMove: function(e) {
      if (e.touches.length === 1 && this.mermaidZoomPanning) {
        var dx = e.touches[0].clientX - this.mermaidZoomLastX;
        var dy = e.touches[0].clientY - this.mermaidZoomLastY;
        this.mermaidZoomPanX += dx;
        this.mermaidZoomPanY += dy;
        this.mermaidZoomLastX = e.touches[0].clientX;
        this.mermaidZoomLastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        var dx2 = e.touches[0].clientX - e.touches[1].clientX;
        var dy2 = e.touches[0].clientY - e.touches[1].clientY;
        var newDist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
        if (this.mermaidZoomTouchDist > 0) {
          var scale = newDist / this.mermaidZoomTouchDist;
          this.mermaidZoomScale = Math.max(0.2, Math.min(5, this.mermaidZoomScale * scale));
        }
        this.mermaidZoomTouchDist = newDist;
      }
    },
    onZoomTouchEnd: function() {
      this.mermaidZoomPanning = false;
      this.mermaidZoomTouchDist = 0;
    },
    openChartEditor: function(rawCode) {
      var self = this;
      self.chartEditorCode = rawCode;
      self.showChartEditor = true;
      self.detectChartType(rawCode);
      self.$nextTick(function() {
        self.renderChartPreview();
      });
    },
    detectChartType: function(code) {
      var self = this;
      var trimmed = code.trim();
      if (trimmed.match(/^(graph|flowchart)\s/i)) {
        self.chartEditorType = 'flowchart';
      } else if (trimmed.match(/^gantt/i)) {
        self.chartEditorType = 'gantt';
      } else if (trimmed.match(/^mindmap/i)) {
        self.chartEditorType = 'mindmap';
      } else if (trimmed.match(/^sequenceDiagram/i)) {
        self.chartEditorType = 'sequence';
      } else {
        self.chartEditorType = 'flowchart';
      }
    },
    onChartEditorCodeChange: function() {
      var self = this;
      self.detectChartType(self.chartEditorCode);
      if (self._chartPreviewTimer) clearTimeout(self._chartPreviewTimer);
      self._chartPreviewTimer = setTimeout(function() {
        self.renderChartPreview();
      }, 300);
    },
    renderChartPreview: function() {
      var self = this;
      var code = self.chartEditorCode.trim();
      if (!code) {
        self.chartEditorPreviewSvg = '';
        self.chartEditorError = '';
        return;
      }
      var tempId = 'chart-preview-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
      try {
        mermaid.render(tempId, code).then(function(result) {
          self.chartEditorPreviewSvg = result.svg;
          self.chartEditorError = '';
        }).catch(function(err) {
          self.chartEditorError = '语法错误: ' + (err.message || '请检查Mermaid代码');
          self.chartEditorPreviewSvg = '';
        });
      } catch (e) {
        self.chartEditorError = '语法错误: ' + (e.message || '请检查Mermaid代码');
        self.chartEditorPreviewSvg = '';
      }
    },
    saveChartToNote: function() {
      var self = this;
      if (!self.activeFile) return;
      var editor = self.$refs.editor;
      if (!editor) return;
      var codeBlock = '\n```mermaid\n' + self.chartEditorCode + '\n```\n';
      var pos = editor.selectionStart;
      var text = self.activeFile.content;
      self.activeFile.content = text.substring(0, pos) + codeBlock + text.substring(pos);
      self.showChartEditor = false;
      self.onFileChange();
      self.$store.commit('SHOW_TOAST', { message: '图表已插入笔记', type: 'success' });
    },
    chartEditorAddNode: function(type) {
      var self = this;
      var nodeId = 'N' + Date.now().toString(36);
      var suffix = '';
      if (type === 'rect') suffix = nodeId + '[新节点]';
      else if (type === 'round') suffix = nodeId + '(新节点)';
      else if (type === 'diamond') suffix = nodeId + '{新判断}';
      else if (type === 'circle') suffix = nodeId + '((新节点))';
      var lines = self.chartEditorCode.split('\n');
      var lastNodeLine = -1;
      for (var i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().match(/^[A-Za-z0-9_]+[\[\(\{]/)) {
          lastNodeLine = i;
          break;
        }
      }
      if (lastNodeLine >= 0) {
        var lastNodeId = lines[lastNodeLine].trim().match(/^([A-Za-z0-9_]+)/);
        if (lastNodeId) {
          suffix = lastNodeId[1] + ' --> ' + suffix;
        }
      }
      self.chartEditorCode += '\n    ' + suffix;
      self.renderChartPreview();
    },
    chartEditorAddEdge: function() {
      var self = this;
      var lines = self.chartEditorCode.split('\n');
      var nodeIds = [];
      lines.forEach(function(line) {
        var m = line.trim().match(/^([A-Za-z0-9_]+)[\[\(\{]/);
        if (m) nodeIds.push(m[1]);
      });
      if (nodeIds.length < 2) {
        self.$store.commit('SHOW_TOAST', { message: '至少需要2个节点才能连线', type: 'warning' });
        return;
      }
      var from = nodeIds[nodeIds.length - 2];
      var to = nodeIds[nodeIds.length - 1];
      self.chartEditorCode += '\n    ' + from + ' --> ' + to;
      self.renderChartPreview();
    },
    chartEditorAddMilestone: function() {
      var self = this;
      var taskId = 'ms' + Date.now().toString(36);
      self.chartEditorCode += '\n    里程碑     :milestone,' + taskId + ', 2024-01-15, 0d';
      self.renderChartPreview();
    },
    chartEditorAddSubBranch: function() {
      var self = this;
      self.chartEditorCode += '\n        子分支';
      self.renderChartPreview();
    },
    chartEditorAddParticipant: function() {
      var self = this;
      var pId = 'P' + Date.now().toString(36);
      var lines = self.chartEditorCode.split('\n');
      var insertIdx = 0;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().indexOf('participant') === 0) insertIdx = i + 1;
      }
      lines.splice(insertIdx, 0, '    participant ' + pId + ' as 参与者' + (insertIdx + 1));
      self.chartEditorCode = lines.join('\n');
      self.renderChartPreview();
    },
    chartEditorAddMessage: function() {
      var self = this;
      self.chartEditorCode += '\n    A->>B: 新消息';
      self.renderChartPreview();
    },
    chartEditorChangeTheme: function() {
      var self = this;
      var themes = ['default', 'dark', 'forest', 'neutral'];
      var currentIdx = themes.indexOf(mermaid.mermaidAPI.getConfig().theme || 'default');
      var nextIdx = (currentIdx + 1) % themes.length;
      mermaid.initialize({ theme: themes[nextIdx] });
      self.renderChartPreview();
      self.$store.commit('SHOW_TOAST', { message: '主题已切换为: ' + themes[nextIdx], type: 'info' });
    },
    chartEditorAddTask: function() {
      var self = this;
      var taskId = 'task' + Date.now().toString(36);
      self.chartEditorCode += '\n    新任务     :' + taskId + ', 2024-01-01, 3d';
      self.renderChartPreview();
    },
    chartEditorAddBranch: function() {
      var self = this;
      self.chartEditorCode += '\n      新分支';
      self.renderChartPreview();
    },
    chartEditorAutoLayout: function() {
      var self = this;
      self.renderChartPreview();
      self.$store.commit('SHOW_TOAST', { message: '已重新渲染布局', type: 'info' });
    },
    executeCommand: function(cmd) {
      var self = this;
      self.showCommandPalette = false;
      switch (cmd.action) {
        case 'newNote': self.showTemplatePicker = true; break;
        case 'save': self.saveData(); self.$store.commit('SHOW_TOAST', { message: '已保存', type: 'success' }); break;
        case 'bold': self.insertMarkdown('bold'); break;
        case 'italic': self.insertMarkdown('italic'); break;
        case 'codeblock': self.insertMarkdown('codeblock'); break;
        case 'table': self.insertMarkdown('table'); break;
        case 'fontSizeUp': self.adjustFontSize(1); break;
        case 'fontSizeDown': self.adjustFontSize(-1); break;
        case 'canvas': self.createDrawFile(); break;
        case 'tags': self.showTagModal = true; break;
        case 'versions': self.showVersionHistory = true; break;
        case 'focusMode': self.toggleFocusMode(); break;
        default:
          if (cmd.action.indexOf('mermaid-') === 0) {
            self.insertMarkdown(cmd.action);
          }
          break;
      }
    },
    executeCommandPalette: function() {
      var self = this;
      if (self.filteredCommandItems.length > 0) {
        self.executeCommand(self.filteredCommandItems[0]);
      }
    },
    /* 文件栏开关：竖屏窄屏是抽屉（交给 mixin），其余情况收起/展开常驻文件栏 */
    toggleSidebar: function() {
      if (this.useDrawer) {
        this.toggleDrawer();
      } else {
        this.sidebarHidden = !this.sidebarHidden;
      }
    },
    toggleFocusMode: function() {
      var self = this;
      self.closeDrawer();
      self.viewMode = 'edit';
      self.$store.commit('SHOW_TOAST', { message: '焦点模式 - 按 Esc 退出', type: 'info' });
    },
    // ---- 文件夹 ----
    //
    // 以前文件夹是「能建、不能放」的死功能：建完切进去永远是空的，
    // 因为①所有新建路径都不写 folder 字段，②右键菜单里也没有「移动到」。
    // 现在这两头都补上，文件夹才算真的能用。
    // 判定一律走这个方法，别在各处各写一遍 `(f.folder||'默认')===x`。
    folderOf: function(file) {
      return (file && file.folder) || DEFAULT_FOLDER;
    },
    // 新建时落到哪：当前正在看某个具体文件夹就放进去，看「全部」就进「默认」。
    // 这样「切到错题 → 新建」是符合直觉的动作，不必先去菜单里搬一次。
    targetFolder: function() {
      return (this.activeFolder && this.activeFolder !== ALL_FOLDERS) ? this.activeFolder : DEFAULT_FOLDER;
    },
    moveFileToFolder: function(fileId, folder) {
      var self = this;
      var file = self.files.filter(function(f) { return f.id === fileId; })[0];
      if (!file || self.folderOf(file) === folder) {
        self.closeFolderPicker();
        return;
      }
      file.folder = folder;
      file.updatedAt = new Date().toISOString();
      self.closeFolderPicker();
      self.saveData();
      self.$store.commit('SHOW_TOAST', { message: '已移到「' + folder + '」', type: 'success' });
    },
    toggleFolderPicker: function() {
      var self = this;
      var id = self.fileMenuTarget && self.fileMenuTarget.id;
      if (self.folderPickerFor === id) { self.folderPickerFor = ''; return; }
      self.folderPickerFor = id;
      // 子菜单默认往右展开；右边放不下就翻到左侧。
      // 文件栏只有 300px 宽，右键点在它右缘时子菜单会被推出屏幕 ——
      // 触屏上更是随手就点在中间，必须自己判。
      self.$nextTick(function() {
        var sub = self.$el.querySelector('.context-submenu');
        if (!sub) return;
        var r = sub.getBoundingClientRect();
        self.folderSubFlip = r.right > window.innerWidth - 8;
      });
    },
    closeFolderPicker: function() {
      this.folderPickerFor = '';
    },
    // 删除文件夹：里面的笔记回「默认」，不连带删笔记。
    // 删文件夹是容易点错的动作，所以确认框里写清楚会迁几篇走。
    removeFolder: function(name) {
      var self = this;
      var affected = self.files.filter(function(f) { return self.folderOf(f) === name; });
      self.closeFolderPicker();
      self.openPromptModal({
        title: '删除文件夹「' + name + '」',
        placeholder: affected.length ? affected.length + ' 篇笔记会回到「默认」，输入文件夹名确认' : '输入文件夹名确认',
        confirmText: '删除'
      }).then(function(typed) {
        if (String(typed || '').trim() !== name) {
          self.$store.commit('SHOW_TOAST', { message: '文件夹名不一致，未删除', type: 'warning' });
          return;
        }
        self.folders = self.folders.filter(function(f) { return f !== name; });
        affected.forEach(function(f) { f.folder = DEFAULT_FOLDER; });
        if (self.activeFolder === name) self.activeFolder = ALL_FOLDERS;
        self.saveData();
        self.$store.commit('SHOW_TOAST', {
          message: affected.length ? ('已删除，' + affected.length + ' 篇笔记回到「默认」') : '文件夹已删除',
          type: 'success'
        });
      }).catch(function() {});
    },
    addFolder: function() {
      var self = this;
      // Cluss 没有全局 $modal.prompt：用本组件的轻量输入弹窗代替（见模板 prompt-modal）
      self.openPromptModal({
        title: '新建文件夹',
        placeholder: '文件夹名称',
        confirmText: '创建'
      }).then(function(name) {
        if (!name || !name.trim()) return;
        name = name.trim();
        if (self.folders.indexOf(name) > -1) {
          self.$store.commit('SHOW_TOAST', { message: '文件夹已存在', type: 'warning' });
          return;
        }
        self.folders.push(name);
        // 建完直接切进去并让「全部」之外的筛选生效：学生建文件夹的意图通常就是
        // 「我要往这里放东西」，停在「全部」等于还要再点一次下拉
        self.activeFolder = name;
        self.saveData();
      }).catch(function() {});
    },
    // ---- 轻量输入弹窗（替代 ClassIntra 的 $modal.prompt）----
    openPromptModal: function(opts) {
      var self = this;
      self.promptTitle = opts.title || '请输入';
      self.promptPlaceholder = opts.placeholder || '';
      self.promptConfirmText = opts.confirmText || '确定';
      self.promptValue = '';
      self.showPromptModal = true;
      self.$nextTick(function() {
        if (self.$refs.promptInput) self.$refs.promptInput.focus();
      });
      return new Promise(function(resolve) {
        self._promptResolve = resolve;
      });
    },
    settlePromptModal: function(value) {
      var self = this;
      self.showPromptModal = false;
      var resolve = self._promptResolve;
      self._promptResolve = null;
      if (resolve) resolve(value);
    },
    togglePinFile: function() {
      var self = this;
      var file = self.fileMenuTarget;
      if (!file) return;
      file.pinned = !file.pinned;
      self.showFileMenuModal = false;
      self.saveData();
    },
    toggleStarFile: function() {
      var self = this;
      var file = self.fileMenuTarget;
      if (!file) return;
      file.starred = !file.starred;
      self.showFileMenuModal = false;
      self.saveData();
    },
    uploadToCloud: function() {
      var self = this;
      if (!self.activeFile || self.activeFile.isPrivate) return;
      self.cloudSyncing = true;
      // 画板模式：先从组件取最新画板数据
      var canvasData = '';
      if (self.isDrawFile && self.$refs.drawCanvas) {
        try { canvasData = JSON.stringify(self.$refs.drawCanvas.getData()); } catch (e) {}
      }
      var data = {
        id: self.activeFile.id,
        title: self.activeFile.title || '',
        content: self.activeFile.content || '',
        tags: self.activeFile.tags || [],
        folder: self.activeFile.folder || '默认',
        visibility: self.activeFile.cloudVisibility || 'private',
        is_pinned: self.activeFile.pinned ? 1 : 0,
        canvas_data: canvasData,
        type: self.isDrawFile ? 'draw' : 'note'
      };
      api.post('/notes/notes', data).then(function(response) {
        if (response.data.code === 200) {
          self.$set(self.activeFile, 'cloudSynced', true);
          self.$set(self.activeFile, 'cloudVisibility', data.visibility);
          self.$store.commit('SHOW_TOAST', { message: '已上传到云端', type: 'success' });
          self.loadCloudNotes();
        }
      }).catch(function(err) {
        var msg = '上传失败';
        if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      }).finally(function() {
        self.cloudSyncing = false;
      });
    },
    loadCloudNotes: function() {
      var self = this;
      api.get('/notes/notes').then(function(response) {
        if (response.data.code === 200) {
          self.cloudNotes = response.data.data || [];
          for (var i = 0; i < self.files.length; i++) {
            var synced = self.cloudNotes.some(function(cn) { return cn.id === self.files[i].id; });
            self.$set(self.files[i], 'cloudSynced', synced);
            if (synced) {
              var cloudNote = self.cloudNotes.find(function(cn) { return cn.id === self.files[i].id; });
              self.$set(self.files[i], 'cloudVisibility', cloudNote ? cloudNote.visibility : 'private');
              // 画板数据回填：从云端还原 canvasData
              if (cloudNote && cloudNote.canvas_data) {
                try {
                  self.$set(self.files[i], 'canvasData', JSON.parse(cloudNote.canvas_data));
                } catch (e) {}
              }
            }
          }
        }
      }).catch(function() {});
    },
    toggleCloudVisibility: function(file) {
      var self = this;
      var newVisibility = file.cloudVisibility === 'public' ? 'private' : 'public';
      api.patch('/notes/notes/' + file.id + '/visibility', { visibility: newVisibility }).then(function(response) {
        if (response.data.code === 200) {
          self.$set(file, 'cloudVisibility', newVisibility);
          self.$store.commit('SHOW_TOAST', { message: newVisibility === 'public' ? '已设为公开' : '已设为私密', type: 'success' });
        }
      }).catch(function(err) {
        var msg = '操作失败';
        if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      });
    },
    loadCloudFolders: function() {
      var self = this;
      api.get('/notes/folders').then(function(response) {
        if (response.data.code === 200) {
          self.cloudFolders = response.data.data || [];
        }
      }).catch(function() {});
    },
    createCloudFolder: function() {
      var self = this;
      var name = self.newCloudFolderName.trim();
      if (!name) return;
      api.post('/notes/folders', { name: name }).then(function(response) {
        if (response.data.code === 200) {
          self.loadCloudFolders();
          self.newCloudFolderName = '';
          self.showCloudFolderModal = false;
          self.$store.commit('SHOW_TOAST', { message: '文件夹创建成功', type: 'success' });
        }
      }).catch(function(err) {
        var msg = '创建失败';
        if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      });
    },
    moveCloudNoteFolder: function(noteId, folder) {
      var self = this;
      api.patch('/notes/notes/' + noteId + '/folder', { folder: folder }).then(function(response) {
        if (response.data.code === 200) {
          self.loadCloudNotes();
          self.$store.commit('SHOW_TOAST', { message: '已移动到 ' + folder, type: 'success' });
        }
      }).catch(function(err) {
        var msg = '移动失败';
        if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      });
    },
    deleteCloudNote: function(noteId) {
      var self = this;
      self.$store.dispatch('confirm', { message: '确定要从云端删除此笔记吗？', danger: true }).then(function(result) {
        if (!result) return;
        api.delete('/notes/notes/' + noteId).then(function(response) {
          if (response.data.code === 200) {
            self.loadCloudNotes();
            self.$store.commit('SHOW_TOAST', { message: '已从云端删除', type: 'success' });
          }
        }).catch(function(err) {
          var msg = '删除失败';
          if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
          self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
        });
      });
    },
    loadPublicNotes: function() {
      var self = this;
      self.publicNotesLoading = true;
      self.publicNotesError = '';
      api.get('/notes/notes/public').then(function(response) {
        if (response.data.code === 200) {
          self.publicNotes = response.data.data || [];
        }
      }).catch(function() {
        // 整块列表加载失败：改用页内 ErrorBanner（可重试），不再只弹一条 toast；
        // 它也让「暂无公开笔记」这条误导性空态不再出现
        self.publicNotesError = '获取公开笔记失败';
      }).finally(function() {
        self.publicNotesLoading = false;
      });
    },
    viewCloudNoteDetail: function(note) {
      var self = this;
      api.get('/notes/notes/' + note.id).then(function(response) {
        if (response.data.code === 200) {
          self.viewingCloudNote = response.data.data;
          // 关闭云盘浮窗，避免遮挡全屏查看
          self.showCloudPanel = false;
        }
      }).catch(function(err) {
        var msg = '获取笔记详情失败';
        if (err.response && err.response.data && err.response.data.message) msg = err.response.data.message;
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      });
    },
    // 解析画板数据（JSON 字符串 → 数组）
    parseCanvasData: function(canvasDataStr) {
      if (!canvasDataStr) return [];
      try { return JSON.parse(canvasDataStr); } catch (e) { return []; }
    },
    importCloudNote: function(note) {
      var self = this;
      var isDraw = note.type === 'draw';
      var canvasData = null;
      if (isDraw && note.canvas_data) {
        try { canvasData = JSON.parse(note.canvas_data); } catch (e) { canvasData = []; }
      }
      var newFile = {
        id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        title: note.title || '未命名笔记',
        content: note.content || '',
        type: isDraw ? 'draw' : 'note',
        tags: note.tags || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: false,
        canvasData: canvasData,
        annotations: [],
        templateId: null,
        versions: [],
        folder: self.targetFolder(),
        pinned: false
      };
      self.files.push(newFile);
      self.activeFileId = newFile.id;
      self.saveData();
      self.viewingCloudNote = null;
      self.showCloudPanel = false;
      self.$store.commit('SHOW_TOAST', { message: '已转载到本地笔记', type: 'success' });
    },
    // ============ 批注系统 ============
    startAnnotation: function() {
      var self = this;
      if (self.viewMode === 'edit') {
        self.viewMode = 'split';
        // 等分屏渲染后再打开批注层
        self.$nextTick(function() {
          self.showAnnotationLayer = true;
        });
      } else {
        self.showAnnotationLayer = true;
      }
    },

    toggleAnnotationLayer: function() {
      var self = this;
      self.showAnnotationLayer = !self.showAnnotationLayer;
      if (!self.showAnnotationLayer) {
        // 退出批注时保存
        self.saveData();
      }
    },

    onAnnotationSave: function(canvasData) {
      var self = this;
      if (!self.activeFile) return;
      self.activeFile.canvasData = canvasData;
      self.activeFile.updatedAt = new Date().toISOString();
      self.saveData();
    },

    commitAnnotationCard: function() {
      var self = this;
      var text = self.annotationInput.trim();
      if (!text) { self.showAnnotationInput = false; return; }
      if (!self.activeFile || self.activeFile.type === 'draw') return;
      if (!self.activeFile.annotations) {
        self.$set(self.activeFile, 'annotations', []);
      }
      self.activeFile.annotations.push({
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        text: text,
        selectedText: self.annotationSelectedText || '',
        color: self.annotationColor,
        createdAt: new Date().toISOString()
      });
      self.activeFile.updatedAt = new Date().toISOString();
      self.annotationInput = '';
      self.annotationSelectedText = '';
      self.showAnnotationInput = false;
      self.saveData();
      self.$store.commit('SHOW_TOAST', { message: '批注已添加', type: 'success' });
    },

    addAnnotationCard: function(selectedText) {
      var self = this;
      if (!self.activeFile || self.activeFile.type === 'draw') return;
      if (!self.activeFile.annotations) {
        self.$set(self.activeFile, 'annotations', []);
      }
      self.annotationInput = '';
      self.annotationSelectedText = selectedText || '';
      self.annotationColor = 'var(--accent)';
      self.showAnnotationInput = true;
      // 不弹出原生 prompt，显示内置输入框
      self.$nextTick(function() {
        var el = document.getElementById('annotation-inline-input');
        if (el) el.focus();
      });
    },

    deleteAnnotation: function(annoId) {
      var self = this;
      if (!self.activeFile || !self.activeFile.annotations) return;
      var idx = self.activeFile.annotations.findIndex(function(a) { return a.id === annoId; });
      if (idx > -1) {
        self.activeFile.annotations.splice(idx, 1);
        self.activeFile.updatedAt = new Date().toISOString();
        self.saveData();
      }
    },

    onPreviewTextSelect: function() {
      var self = this;
      if (self.showAnnotationLayer) return; // 批注涂鸦模式下不触发
      setTimeout(function() {
        var selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.toString().trim()) return;
        var selectedText = selection.toString().trim();
        if (selectedText.length < 1) return;
        // 在预览区选中文字时自动弹出批注提示
        // 使用轻量提示：在选中的文本下方显示一个小按钮
        // 为了避免过于复杂，这里直接用简单的确认
        if (selectedText.length > 0 && selectedText.length < 500) {
          // 不自动弹出，让用户通过编辑器批注按钮来添加
          // 但保留这个钩子供未来扩展
        }
      }, 300);
    },

    renderAnnotationText: function(text) {
      if (!text) return '';
      // 简单的 markdown 处理
      var html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
      return html;
    },

    // ============ 画板模式 ============
    createNoteFile: function() {
      this.showTemplatePicker = true;
    },

    exitDrawFile: function() {
      var self = this;
      // 退出前保存当前画板数据
      if (self.$refs.drawCanvas && self.activeFile) {
        try {
          var currentData = self.$refs.drawCanvas.getData();
          self.activeFile.canvasData = currentData;
          self.activeFile.updatedAt = new Date().toISOString();
        } catch(e) {}
      }
      // 切到最近的非画板文件
      var noteFile = self.allFiles.find(function(f) { return f.type !== 'draw'; });
      if (noteFile) {
        self.activeFileId = noteFile.id;
      }
      self.saveData();
    },

    onDrawSave: function(canvasData) {
      var self = this;
      if (!self.activeFile) return;
      self.activeFile.canvasData = canvasData;
      self.activeFile.updatedAt = new Date().toISOString();
      self.saveData();
    },

    createDrawFile: function() {
      var self = this;
      var id = generateId();
      var now = new Date().toISOString();
      var file = {
        id: id,
        title: '未命名画板 ' + new Date().toLocaleDateString('zh-CN'),
        content: '',
        type: 'draw',
        tags: [],
        folder: self.activeFolder !== '全部' ? self.activeFolder : null,
        canvasData: [],
        annotations: null,
        createdAt: now,
        updatedAt: now,
        pinned: false,
        privacyId: null
      };
      self.files.unshift(file);
      self.activeFileId = id;
      self.saveData();
    }
  }
};
</script>

<style scoped>
/* 按钮默认**不继承**字体 —— UA 会给 <button> 一套自己的 font（Windows 上是 Arial）。
   全局 .btn / .segmented-item 都显式写了 `font-family: inherit`，
   本页这些「裸样式」控件（图标钮、菜单项、侧栏行、输入框）同样要补，
   否则它们的文字（尤其是数字与 H₁ 这类符号）与页面其他部分对不上。
   一条兜住全部，比在二十几个类里各写一遍可靠 —— 后者迟早又漏一个。 */
.notes-page button,
.notes-page input,
.notes-page select,
.notes-page textarea {
  font-family: inherit;
}
.notes-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  /* 不写死底色：与其余页面一致，透出全局渐变背景，消除「笔记页比别页更平/更白」的割裂感 */
  background: transparent;
  gap: var(--gap-md);
  /* 安全区兜底：与 Chat/Study/Writing/Records 等页根容器同一写法。
     无刘海/挖孔的桌面与平板上四个 inset 都是 0，留白与改动前完全一致；
     刘海/挖孔机上顶栏不被摄像头区压住、底部内容不被手势条盖住。 */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
}

.notes-body {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}

/* 图标小按钮（「收起/显示文件栏」）。
   ⚠️ .icon-btn 在本项目里是**每个页面各写一份**的 scoped 规则（Chat / Admin /
   Records / Writing / Usage 各有一份，尺寸档位还分 26px 与 28px 两档）——
   唯独 Notes.vue 漏了。漏了不会报错，只是这个按钮退回浏览器默认外观：
   白底 + 系统灰边框 + 默认字号，在「新建 / 导入」两个真按钮旁边像个异物。
   这里按 Records / Usage 同档（28→42px）补齐，别再按小一号那档走 ——
   笔记页是触屏主力场景，点击目标要给足。 */
.icon-btn {
  width: clamp(28px, 19.36px + 0.9vw, 42px);
  height: clamp(28px, 19.36px + 0.9vw, 42px);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--text-tertiary);
  font-size: clamp(16px, 13.12px + 0.3vw, 21px);
  line-height: 1;
  cursor: pointer;
}

@media (hover: hover) {
  .icon-btn:hover {
    background: var(--ink-2);
    color: var(--text-primary);
  }
}

/* 页面工具栏：与 Records / Writing 等页的 .toolbar 同一套观感
   （玻璃卡 + 大圆角 + 统一点击目标），只放笔记自己的动作 */
.notes-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  /* 完全贴边：与其余页面统一，去掉四边固定留白，间距由 .notes-page 的 gap 提供 */
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  position: relative;
  z-index: 30;
}
html.no-flex-gap .notes-toolbar > * + * {
  margin-left: var(--gap-md);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
html.no-flex-gap .toolbar-left > * + * {
  margin-left: 8px;
}

/* 工具栏右半：当前文件的操作 + 视图切换。
   两者都是「对当前文件生效」的视图级动作，放一起不用上下找。 */
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
html.no-flex-gap .toolbar-right > * + * {
  margin-left: 8px;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
  border-right: 0.5px solid var(--menu-border);
  flex-shrink: 0;
}
html.no-flex-gap .file-actions > * + * {
  margin-left: 4px;
}

/* 新建下拉菜单 */
.nav-create-dropdown {
  position: relative;
}

.create-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  /* 浮层底色统一用 --menu-bg（近不透明）：--surface-2 在深色下只有 8% 白，
     盖在正文上能把下面的字读出来，等于菜单透明 */
  background: var(--menu-bg);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  border: 0.5px solid var(--menu-border);
  padding: 6px;
  z-index: 3000;
  min-width: 160px;
}

.create-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: none;
  background: none;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-standard);
  touch-action: manipulation;
  min-height: 44px;
}
html.no-flex-gap .create-menu-item > * + * {
  margin-left: 10px;
}


@media (hover: hover) {
.create-menu-item:hover {
  background: var(--bg-base);
}
}

.create-menu-item:active {
  background: var(--accent-soft);
  transform: scale(0.97);
}

.create-menu-item i {
  font-size: 18px;
  width: 24px;
  text-align: center;
}

.dropdown-fade-enter-active,
.dropdown-fade-leave-active {
  transition: opacity var(--duration-fast) var(--ease-standard) ease, transform var(--duration-fast) var(--ease-standard) ease;
}

.dropdown-fade-enter,
.dropdown-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.notes-sidebar {
  width: var(--sidebar-w);
  /* 侧栏本身**透明**，内容分块装进 glass 卡片 —— 与对话页同一套层次。
     原来这里给整个侧栏铺一层 --glass-bg 毛玻璃，于是：
       对话页：透明底 + 若干独立卡片（有圆角、阴影、层次）
       笔记页：一整块大玻璃，控件直接摊在上面（无圆角、无层次）
     同一位置两种做法，学生来回切页会觉得「笔记的文件栏不像别的页面」。
     实测数据（server/scripts/audit-sidebar-visual.cjs）：
       对话页 2 个子块全部 glass/20px 圆角/有阴影
       笔记页 4 个子块全部透明/0px 圆角/无阴影
     玻璃拟态本身也更适合「铺在固定装饰背景上的卡片」，
     整块大玻璃会让里面的文字与背后渐变叠在一起、对比度变差。 */
  border-right: 0.5px solid var(--menu-border);
  backdrop-filter: var(--glass-blur-container);
  -webkit-backdrop-filter: var(--glass-blur-container);
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding: var(--gap-md);
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
  z-index: 20;
  /* 收起 / 展开文件栏时宽度做过渡，编辑区随之铺满。
     padding 也要一起过渡，否则收起的最后一帧会「啪」地跳掉 16px。 */
  transition: width var(--duration-normal) var(--ease-standard),
              padding var(--duration-normal) var(--ease-standard);
}
html.no-flex-gap .notes-sidebar > * + * {
  margin-top: var(--gap-md);
}

/* 文件栏里的三块内容：搜索 / 文件夹栏 / 列表，统一成卡片。
   padding 16px、圆角 --radius-lg —— 直接照对话页的 wallet-card / conv-panel 规格，
   不要自己另定一套，那是「不统一」的开始。 */
.sidebar-card {
  padding: 16px;
  border-radius: var(--radius-lg);
}

/* 列表卡片要吃掉剩余高度，否则它后面的「新建笔记」按钮会被顶到列表下面。
   padding 与对话页的 wallet-card / conv-panel 保持 16px ——
   「统一」不只是有卡片，卡片内边距也要一样，
   否则三个 20px 圆角的卡片并排却有两种内缩，看着仍然不像一套。 */
.sidebar-file-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-radius: var(--radius-lg);
}

/* 手动收起文件栏：宽度归零并裁剪内容，把横向空间让给编辑区。
   ⚠️ 必须把 padding 一起归零：全局是 border-box，width:0 + 左右各 8px padding
   的最终宽度是 **16px**，实测收起后左边仍留一条玻璃边，还能看见卡片圆角。 */
.notes-body.sidebar-hidden .notes-sidebar {
  width: 0;
  padding-left: 0;
  padding-right: 0;
  border-right: none;
  overflow: hidden;
  box-shadow: none;
}

/* ---- 文件栏的节奏（原来四样控件四个高度、三种内缩，看着就是拼起来的）----
   实测改前：搜索框 44px、两个下拉 40px、新建文件夹按钮 40px、底部按钮 37px；
   左边距分别是 12 / 12 / 12 / 12，而文件列表容器只有 8px ——
   列表里的文字比上面所有控件都靠左 4px，一眼看过去就是散的。
   现在统一成一条线：**控件 44px + 左右内缩 12px**，
   44px 与页面工具栏、编辑区工具栏按钮一致，触屏目标也达标。 */

.sidebar-top {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 8px;
  flex-shrink: 0;
  /* 排序菜单从这里弹出，会盖住下面的「文件夹」卡片。
     .glass 的 backdrop-filter 会给这张卡单独一个层叠上下文，
     不显式抬高层级的话菜单会被后面的兄弟卡片盖住（点不着、也看不见）。
     z-index 只在本页文件栏内部比较，30 足够高于列表与底部卡片。 */
  position: relative;
  z-index: 30;
}
html.no-flex-gap .sidebar-top > * + * {
  margin-left: 8px;
}


.sidebar-search {
  flex: 1;
  /* input 的默认宽度（约 180px）就是它的 min-content：不写 min-width:0 的话
     `flex:1` 也压不下去，会把同一行的排序按钮挤出卡片外（实测按钮落到 x=225~269，
     而卡片右边界只有 227） */
  min-width: 0;
  display: flex;
  align-items: center;
  background: var(--bg-base);
  border-radius: var(--radius-md);
  padding: 0 12px;
  /* 与下面的下拉、按钮同高 44px（原来搜索框 44、下拉 40，同一列两种高度） */
  height: 44px;
  border: 1px solid var(--menu-border);
  transition: border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

.sidebar-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.sidebar-search-icon {
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  margin-right: 6px;
  flex-shrink: 0;
}

.sidebar-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  height: 100%;
  outline: none;
}

.sidebar-search-input::placeholder {
  color: var(--text-tertiary);
}

/* ---- 排序按钮（搜索行右侧，与文件夹行同一种材质 44×44）----
   为什么不做成下拉：这一行只有 204px，再塞一个 select 就是「两个都看不全」。
   图标按钮 + 弹出菜单，把宽度全留给文件夹名。 */
.sort-wrap {
  position: relative;
  flex-shrink: 0;
}

.sort-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  border: 1px solid var(--menu-border);
  background-color: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-standard),
              border-color var(--duration-fast) var(--ease-standard),
              background-color var(--duration-fast) var(--ease-standard);
}

/* 非默认排序时按钮亮起来：否则换了排序方式在收起状态毫无提示 */
.sort-btn.is-active {
  color: var(--accent);
  border-color: var(--accent);
  background-color: var(--accent-soft);
}

@media (hover: hover) {
  .sort-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

.sort-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.sort-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 168px;
  /* 浮层底色只能用 --menu-bg：--surface-* 是「层叠表面」，深色下只有 12% 白，
     盖在正文上会把下面的字透出来（实测深色下能读到笔记正文） */
  background: var(--menu-bg);
  border: 0.5px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-float);
  padding: 6px;
  z-index: 60;
}

.sort-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.sort-menu-item.is-active {
  color: var(--accent);
  background: var(--accent-soft);
}

.sort-menu-item .fa-check {
  font-size: var(--font-size-caption);
}

.sidebar-new-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: #FFFFFF;
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
  flex-shrink: 0;
  transition: background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.sidebar-new-btn:hover {
  opacity: 0.9;
}
}

.sidebar-import-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: 1px solid var(--menu-border);
  flex-shrink: 0;
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.sidebar-import-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
}

.tag-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px 8px;
  flex-shrink: 0;
}

.tag-filter-label {
  font-size: var(--font-size-sm);
  color: var(--accent);
  font-weight: var(--font-weight-semibold);
}

.tag-filter-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--text-tertiary);
  font-size: var(--font-size-caption2);
  cursor: pointer;
  border: none;
  background: none;
}

@media (hover: hover) {
.tag-filter-clear:hover {
  color: var(--danger);
  background: var(--danger-soft);
}
}

.tag-filter-clear:active {
  transform: scale(0.94);
  opacity: 0.7;
}

/* 左右内缩 12px，与搜索框 / 文件夹栏 / 底部按钮对齐。
   原来是 8px —— 列表里的文字比上面所有控件都靠左 4px，一眼就是散的。 */
.sidebar-file-list {
  flex: 1;
  overflow-y: auto;
  /* 内边距由 .sidebar-file-card 提供，这里不再重复加 ——
     两层 padding 叠加会让列表比卡片内容区窄一截，右侧留白比左边宽。 */
}

/* 虚拟列表接管滚动后，.sidebar-file-list 自己不能再滚 ——
   两个可滚容器套在一起会出现双滚动条，且外层那个永远滚不动。

   ⚠️ 这里刻意**不用** `:has(.file-list-virtual)` 来自动判定：
   :has() 需要 Chrome 105+，而本项目的基线是 Chrome 80 / Android 9 / 微信 X5
   （见 vite.config.js）。在旧内核上这条规则会被整条忽略，
   于是又退回双滚动条 —— 而双滚动条的表现是「外层滚不动」，
   很难被联想到是选择器不兼容。所以改用显式的修饰类 has-vlist。 */
.sidebar-file-list.has-vlist {
  overflow-y: hidden;
}

/* 虚拟列表容器：内边距由 .sidebar-file-card 提供，这里**不能再加**。
   占位 div（上下两条撑总高度的）也会被 padding 撑开，
   一旦这里再加一份，总高度就多出两个 padding，滚动条比例会失真。 */
.file-list-virtual {
  height: 100%;
}

.file-item {
  padding: 12px 14px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-standard);
  margin-bottom: 2px;
}

@media (hover: hover) {
.file-item:hover {
  background: var(--accent-soft);
}
}

.file-item:active {
  background: var(--menu-border);
}

.file-item.active {
  background: var(--accent-soft);
  border-left: 3px solid var(--accent);
}

.file-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
html.no-flex-gap .file-item-main > * + * {
  margin-top: 2px;
}


.file-item-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 6px;
}
html.no-flex-gap .file-item-title > * + * {
  margin-left: 6px;
}


.file-type-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.file-type-icon.note-type {
  color: var(--text-tertiary);
}

.file-type-icon.draw-type {
  color: var(--danger);
}

.file-item-date {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.file-item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
html.no-flex-gap .file-item-tags > * + * {
  margin-left: 4px;
}


.file-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  font-size: var(--font-size-caption2);
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.file-tag:hover {
  background: var(--accent-ring);
}
}

.sidebar-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--text-tertiary);
  gap: 8px;
  font-size: var(--font-size-sm);
}
html.no-flex-gap .sidebar-empty > * + * {
  margin-top: 8px;
}


.sidebar-empty i {
  font-size: var(--font-size-title1);
  opacity: 0.4;
}

.sidebar-bottom {
  padding: 16px;
  /* 原来用 border-top 把「操作区」与「列表」分开。
     改成卡片布局后，卡片之间的 gap 已经承担了分隔作用，
     这条线会变成「卡片里还画了一条分隔线」的双重边界，看着多余。 */
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
html.no-flex-gap .sidebar-bottom > * + * {
  margin-top: 4px;
}


/* 底部三行：与上面的控件同高 44px（原来 37px，同一列最后一段又矮一截）。
   保持透明底 —— 它们是「入口」不是「输入控件」，和上面那排实底控件分工不同，
   不硬凑成一种材质。 */
.sidebar-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
  background: none;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}
html.no-flex-gap .sidebar-entry > * + * {
  margin-left: 8px;
}

@media (hover: hover) {
  .sidebar-entry:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
}

.privacy-entry {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
  background: none;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}
html.no-flex-gap .privacy-entry > * + * {
  margin-left: 8px;
}


@media (hover: hover) {
  .privacy-entry:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
}

.notes-main {
  flex: 1;
  display: flex;
  min-height: 0;
  background: var(--surface-2);
  overflow: hidden;
}

.editor-area {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  /* 规范例外：侧栏收起展开，宽度即语义；scaleX 会压扁内部文字（§5.5.2 形状形变豁免） */
  transition: width var(--duration-slow) var(--ease-standard);
}

.editor-area.resizing {
  transition: none;
}

/* 标题与创建时间齐平：标题吃掉剩余宽度，时间靠右、垂直居中。
   输入框有 padding，所以用 align-items 而不是 baseline —— baseline 会让
   小字号的时间被输入框的文本基线拖着，看起来比标题低一截。 */
.editor-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  flex-shrink: 0;
  border-bottom: 0.5px solid var(--menu-border);
}

.editor-title-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  padding: 0;
  outline: none;
}

.editor-title-input::placeholder {
  color: var(--text-tertiary);
}

.editor-date {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  flex-shrink: 0;
  white-space: nowrap;
}

.editor-tag-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
  background: none;
  transition: color var(--duration-fast) var(--ease-standard), background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
  .editor-tag-btn:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
}

.editor-tag-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.editor-toolbar {
  display: flex;
  align-items: center;
  /* 组间 10px、组内 1px：分组本身就是分隔，不再画竖线
     （竖线在 flex-wrap 折行时会孤零零留在行尾，见模板注释） */
  gap: 10px;
  padding: 4px 12px;
  border-bottom: 0.5px solid var(--menu-border);
  flex-shrink: 0;
  /* **换行**，不再横向滚动。
     原来是 nowrap + overflow-x:auto + 隐藏滚动条：编辑区 564px 时一行要 1165px，
     13 个按钮被静默裁掉，而且没有任何「还能往右拖」的提示 —— 按钮等于不存在。
     44px 的触屏目标不能缩（项目基线），所以只能让行数变多，不能让按钮消失。 */
  flex-wrap: wrap;
  background: var(--bg-base);
}

/* 一个语义组（字形 / 标题 / 列表 / 插入）作为一个整体参与折行：
   组不会被拆到两行上，H1 也不会和 H2 H3 分开。 */
.toolbar-group {
  display: flex;
  align-items: center;
  gap: 1px;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  border: none;
  background: none;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
  position: relative;
  flex-shrink: 0;
}

/* hover 必须包在媒体查询里（项目约定，见 AppNavBar.vue）：
   触屏上 :hover 会在点按后粘住，按钮一直保持高亮，像坏了一样 */
@media (hover: hover) {
  .toolbar-btn:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
}

/* 「更多」展开时的选中态：不依赖 hover，触屏上也要看得见自己点开了 */
.toolbar-btn.is-active {
  background: var(--accent-soft);
  color: var(--accent);
}

.toolbar-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.toolbar-sub {
  font-size: var(--font-size-caption2);
  font-weight: 700;
  position: absolute;
  bottom: 4px;
  right: 4px;
}

.toolbar-latex {
  font-family: 'Times New Roman', serif;
  font-style: italic;
  font-size: var(--font-size-body);
}

/* ===== 工具栏「更多」菜单 =====
   收进来的都是低频但不能丢的能力：代码块 / 表格 / 分割线 / 批注 / 公式 / 四种图表 / 命令面板。
   菜单项写成「图标 + 文字」而不是纯图标 —— 纯图标在这里没有可 hover 的说明，
   而这些恰好是最需要解释的（公式和图表分不清的人很多）。 */
.more-menu-wrap {
  position: relative;
  display: inline-flex;
}

.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 176px;
  /* 11 个菜单项按 44px 触屏目标要 ~520px：上限给够，正常情况下一屏看全，
     不出现「菜单里还有东西但看不出来」的滚动条（滚动条只有真放不下时才出现，
     而这里的滚动条没有被隐藏） */
  max-height: min(70vh, 560px);
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 近不透明的浮层底色：--surface-3 在深色下只有 12% 白，实测能透出笔记正文 */
  background: var(--menu-bg);
  border: 0.5px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-float);
  padding: 6px;
  z-index: 60;
}

.more-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}
html.no-flex-gap .more-menu-item > * + * {
  margin-left: 10px;
}

.more-menu-item > i {
  width: 20px;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  flex-shrink: 0;
}

@media (hover: hover) {
  .more-menu-item:hover {
    background: var(--bg-base);
  }
}

.more-menu-item:active {
  background: var(--accent-soft);
}

.more-menu-sep {
  height: 0.5px;
  background: var(--menu-border);
  margin: 4px 6px;
}

.more-menu-latex {
  width: 20px;
  text-align: center;
  font-family: 'Times New Roman', serif;
  font-style: italic;
  font-size: var(--font-size-body);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.editor-content {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.editor-textarea {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--surface-2);
  color: var(--text-primary);
  /* 左右内边距随视口长：下限就是原来的 16px（保证窄屏一像素都没变），
     大屏上正文不再贴着分栏线 —— 分栏加宽后那 16px 看着像没留白 */
  padding: 12px clamp(16px, 2.2vw, 28px);
  line-height: 1.8;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', 'Menlo', monospace;
  resize: none;
  outline: none;
  tab-size: 2;
  box-sizing: border-box;
}

.editor-textarea::placeholder {
  color: var(--text-tertiary);
}

.editor-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 4px 12px;
  border-top: 0.5px solid var(--menu-border);
  flex-shrink: 0;
  background: var(--bg-base);
  /* 单行、不折行：折行会让状态栏从 30px 涨到 71px（实测窄屏），
     白吃掉编辑区的垂直空间 —— 而编辑区本来就嫌小。
     放不下时由下面两条规则收掉次要项，而不是换行。 */
  flex-wrap: nowrap;
  overflow: hidden;
  white-space: nowrap;
}
html.no-flex-gap .editor-footer > * + * {
  margin-left: 16px;
}


/* ===== AI 辅助（Cluss 特有）===== */
.assist-dropdown-wrap {
  position: relative;
  display: inline-flex;
}
.assist-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  background: var(--menu-bg);
  border: 0.5px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-float);
  padding: 6px;
  z-index: 60;
}
.assist-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
@media (hover: hover) {
.assist-menu-item:hover {
  background: var(--bg-base);
}
}
.assist-menu-item:active {
  transform: scale(0.97);
}
.assist-menu-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 4px;
  padding: 8px 12px 4px;
  border-top: 0.5px solid var(--menu-border);
  font-size: var(--font-size-xs, 11px);
  color: var(--text-tertiary);
}
html.no-flex-gap .assist-menu-foot > * + * {
  margin-left: 12px;
}

.assist-balance.is-empty {
  color: var(--danger);
}
.assist-result {
  flex-shrink: 0;
  max-height: 40%;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  margin: 8px 12px;
  border: 0.5px solid var(--menu-border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
}
.assist-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--menu-border);
  position: sticky;
  top: 0;
  background: var(--surface-2);
  z-index: 1;
}
html.no-flex-gap .assist-head > * + * {
  margin-left: 10px;
}

.assist-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
}
.assist-actions {
  display: flex;
  gap: 8px;
}
html.no-flex-gap .assist-actions > * + * {
  margin-left: 8px;
}

.assist-act-btn {
  padding: 5px 12px;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs, 12px);
  cursor: pointer;
  white-space: nowrap;
  /* 命中区向上下扩到 40px，视觉不变（原理见 styles/global.css「触控命中区」）。
     这是 AI 助手的「停止 / 替换正文」—— 「停止」在生成中要点，
     29px 的目标在平板上容易点空。 */
  position: relative;
}

.assist-act-btn::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 40px;
  transform: translateY(-50%);
  background: transparent;
  z-index: 1;
}
.assist-act-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.assist-act-btn:active {
  transform: scale(0.96);
}
.assist-body {
  padding: 10px 14px;
  font-size: var(--font-size-sm);
  overflow-wrap: break-word;
}
.assist-waiting {
  padding: 14px;
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  text-align: center;
}

.footer-stat {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

/* 状态栏放不下时的退让顺序：先收英文词数，再收阅读时长，最后收字号。
   数字本身不折行、也不换行 —— 宁可少显示，也不要把状态栏撑成两行。 */
@media (max-width: 1180px) {
  .editor-footer {
    gap: 12px;
  }
  html.no-flex-gap .editor-footer > * + * {
    margin-left: 12px;
  }
  .footer-stat.is-optional-1 {
    display: none;
  }
}
@media (max-width: 980px) {
  .footer-stat.is-optional-2 {
    display: none;
  }
}
@media (max-width: 820px) {
  .footer-stat.is-optional-3 {
    display: none;
  }
}

.save-indicator {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: color var(--duration-slow) var(--ease-standard);
}
html.no-flex-gap .save-indicator > * + * {
  margin-left: 4px;
}


.save-indicator i {
  font-size: var(--font-size-caption2);
}

.save-indicator.saved {
  color: var(--success);
}

.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-tertiary);
}
html.no-flex-gap .editor-empty > * + * {
  margin-top: 16px;
}


.empty-icon {
  font-size: 56px;
  opacity: 0.3;
}

.empty-text {
  font-size: var(--font-size-base);
}

.preview-area {
  border-left: 0.5px solid var(--menu-border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-2);
  min-width: 0;
  /* 规范例外：侧栏收起展开，宽度即语义；scaleX 会压扁内部文字（§5.5.2 形状形变豁免） */
  transition: width var(--duration-slow) var(--ease-standard);
}

.preview-area.resizing {
  transition: none;
}

.editor-resizer {
  width: 12px;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  z-index: 10;
  transition: background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.editor-resizer:hover {
  background: var(--accent-soft);
}
}

@media (hover: hover) {
.editor-resizer:hover .resizer-line {
  background: var(--accent);
}
}

.resizer-line {
  width: 2px;
  height: 32px;
  border-radius: var(--radius-pill);
  background: var(--menu-border);
  /* 规范例外：自定义滚动条，高度即语义（§5.5.2 形状形变豁免） */
  transition: background var(--duration-fast) var(--ease-standard), height var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.editor-resizer:hover .resizer-line {
  height: 48px;
}
}

.preview-header {
  padding: 6px 12px;
  border-bottom: 0.5px solid var(--menu-border);
  flex-shrink: 0;
  background: var(--bg-base);
}

.preview-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.preview-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  line-height: 1.8;
  font-size: var(--font-size-base);
  color: var(--text-primary);
  min-height: 0;
  word-break: break-word;
  overflow-wrap: break-word;
  /* 让 .annotation-overlay 的 absolute 定位以本元素为参照 */
  position: relative;
}

/* 内容内部容器：包裹渲染HTML和批注涂鸦层，作为滚动内容的一部分 */
.preview-content-inner {
  position: relative;
}

/* 承载 v-html 的容器 */
.preview-content-html {
  position: relative;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--mask-strong);
  backdrop-filter: var(--glass-blur-thin);
  -webkit-backdrop-filter: var(--glass-blur-thin);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 3000;
}

.modal-panel {
  width: 440px;
  max-width: 90vw;
  background: var(--surface-2);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 0.5px solid var(--menu-border);
}

.modal-title {
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
html.no-flex-gap .modal-title > * + * {
  margin-left: 8px;
}


.modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: var(--text-tertiary);
  font-size: var(--font-size-callout);
  cursor: pointer;
  border: none;
  background: none;
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.modal-close:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}
}

.modal-close:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.modal-body {
  padding: 20px;
}

.modal-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  font-size: var(--font-size-base);
  background: var(--bg-base);
  color: var(--text-primary);
  margin-bottom: 12px;
  box-sizing: border-box;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
}


/* 轻量输入弹窗（替代 ClassIntra 全局 $modal.prompt） */
.prompt-modal {
  width: min(360px, calc(100vw - 48px));
}
.prompt-modal .modal-input {
  margin-bottom: 0;
}

.modal-btn {
  width: 100%;
  margin-top: 4px;
}

.privacy-hint {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.privacy-setup {
  margin-top: 4px;
}

.privacy-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
html.no-flex-gap .privacy-toolbar > * + * {
  margin-left: 8px;
}


.privacy-toolbar .btn-secondary {
  font-size: var(--font-size-sm);
  padding: 8px 14px;
}

.privacy-file-list {
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 16px;
}

.tag-modal .tag-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
html.no-flex-gap .tag-modal .tag-input-row > * + * {
  margin-left: 8px;
}


.tag-modal .tag-input-row .modal-input {
  flex: 1;
  margin-bottom: 0;
}

.tag-modal .tag-input-row .btn-primary {
  flex-shrink: 0;
  padding: 10px 16px;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 16px;
  margin-bottom: 16px;
}
html.no-flex-gap .tag-list > * + * {
  margin-left: 6px;
}


.tag-item {
  display: inline-block;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  background: var(--bg-base);
  color: var(--text-secondary);
  cursor: pointer;
  border: 1px solid var(--menu-border);
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.tag-item:hover {
  border-color: var(--accent);
  color: var(--accent);
}
}

.tag-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}

.current-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding-top: 12px;
  border-top: 0.5px solid var(--menu-border);
}
html.no-flex-gap .current-tags > * + * {
  margin-left: 6px;
}


.current-tags-label {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin-right: 4px;
}

.current-tags .tag-item.active i {
  margin-left: 4px;
  font-size: var(--font-size-caption2);
}

.no-tags {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
}

.context-menu {
  position: fixed;
  /* 右键菜单盖在文件列表/正文上，必须不透明 */
  background: var(--menu-bg);
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 2000;
  min-width: 180px;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
  border: none;
  background: none;
  text-align: left;
  transition: background var(--duration-fast) var(--ease-standard);
}
html.no-flex-gap .context-menu-item > * + * {
  margin-left: 8px;
}


@media (hover: hover) {
  .context-menu-item:hover {
    background: var(--accent-soft);
  }
}

.context-menu-item.danger {
  color: var(--danger);
}

@media (hover: hover) {
  .context-menu-item.danger:hover {
    background: var(--danger-soft);
  }
}

/* 「移动到文件夹」子菜单
   不跳浮窗、不复用全局弹窗：就在菜单右侧就地展开，
   学生能同时看到「这一篇」和「这些文件夹」，不必来回对照。
   放在流程最后是为了防止父菜单被右边缘裁掉。 */
.context-menu-sub {
  position: relative;
}

.context-menu-item.has-sub {
  justify-content: flex-start;
}

.context-menu-item.has-sub .sub-arrow {
  margin-left: auto;
  font-size: var(--font-size-caption2);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.context-menu-item.has-sub .sub-arrow.open {
  transform: rotate(90deg);
}

.context-submenu {
  position: absolute;
  left: calc(100% - 4px);
  top: -4px;
  min-width: 168px;
  /* 子菜单也是浮层：--menu-bg 近不透明。用 --surface-2（深色下 8% 白）
     会直接透出背后的笔记正文，子菜单浮在编辑器上时字都读不稳。 */
  background: var(--menu-bg);
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 2001;
}

/* 右边放不下时翻到左侧（class 由 toggleFolderPicker 实测后加） */
.context-submenu.flip {
  left: auto;
  right: calc(100% - 4px);
}

/* 当前所在文件夹：勾 + 次级色，让人一眼看出「它已经在这儿了」，
   也避免误点同一个文件夹时以为没反应 */
.context-menu-item.current {
  color: var(--accent);
  font-weight: var(--font-weight-medium);
}

.context-menu-item .sub-check {
  margin-left: auto;
  font-size: var(--font-size-caption2);
}

.context-menu-sep {
  height: 0.5px;
  background: var(--menu-border);
  margin: 4px 8px;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.template-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 12px;
  border-radius: var(--radius-md);
  border: 2px solid var(--menu-border);
  cursor: pointer;
  transition: background-color var(--duration-normal) var(--ease-standard), border-color var(--duration-normal) var(--ease-standard), color var(--duration-normal) var(--ease-standard), transform var(--duration-normal) var(--ease-standard), opacity var(--duration-normal) var(--ease-standard), box-shadow var(--duration-normal) var(--ease-standard);
  background: var(--bg-base);
}

@media (hover: hover) {
.template-card:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
}

.template-icon {
  font-size: var(--font-size-title1);
  color: var(--accent);
  margin-bottom: 8px;
}

.template-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.version-modal .modal-panel {
  width: 520px;
}

.version-list {
  max-height: 400px;
  overflow-y: auto;
}

.version-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--menu-border);
  margin-bottom: 8px;
  transition: background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.version-item:hover {
  background: var(--accent-soft);
}
}

.version-info {
  flex: 1;
  min-width: 0;
}

.version-time {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 2px;
}

.version-summary {
  font-size: var(--font-size-sm);
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  margin-left: 12px;
}
html.no-flex-gap .version-actions > * + * {
  margin-left: 6px;
}


/* 次要按钮（取消 / 返回 / 查看 / 导入 …）。
   ⚠️ `.btn-secondary` 在本项目里**没有全局定义** —— global.css 只有 .btn / .btn-primary /
   .btn-ghost / .btn-stop / .btn-danger；DrawCanvas 自己带了一份，但 scoped 到它自己。
   笔记页用了 20 多次，不给定义就是彻底裸奔：没有底色、没有边框，只剩浏览器默认外观。
   这里补齐：填充底 + 令牌边框，与实心主按钮拉开一档，比 .btn-ghost（透明）重一档。 */
.btn-secondary {
  background: var(--glass-bg-strong);
  border-color: var(--ink-3);
  color: var(--text-primary);
}

@media (hover: hover) {
  .btn-secondary:hover {
    background: var(--bg-base);
    color: var(--text-primary);
  }
}

/* 版本历史里的「查看 / 恢复」：本来就该是小号按钮，
   原先这条 .btn-sm 覆盖写在页面全局（Notes.vue 里 .btn-sm 只此一处），
   于是页面工具栏的「导入」被一起压成 27px —— 和旁边的「新建」44px 差了一倍半，
   同一行两个按钮高度不齐。现在只作用于版本列表。 */
.version-actions .btn-sm {
  padding: 4px 10px;
  font-size: var(--font-size-sm);
}

/* 页面工具栏：三个按钮（文件栏开关 / 新建 / 导入）统一 44px 触屏目标。
   不加这条的话，它们的高度取决于各自命中的规则 —— 实测「新建」44px、「导入」27px，
   「文件栏开关」32px，一行里三个尺寸。 */
.notes-toolbar .btn {
  min-height: 44px;
}

.notes-toolbar .icon-btn {
  width: 44px;
  height: 44px;
}

.version-preview-modal {
  width: 600px;
  max-width: 90vw;
}

.version-preview-content {
  max-height: 400px;
  overflow-y: auto;
  padding: 16px;
  background: var(--bg-base);
  border-radius: var(--radius-md);
  line-height: 1.7;
  color: var(--text-primary);
}

/* ========== 批注系统 ========== */
.preview-anno-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--menu-border);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  margin-left: auto;
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
  touch-action: manipulation;
  min-height: 36px;
}
html.no-flex-gap .preview-anno-toggle > * + * {
  margin-left: 4px;
}


.preview-anno-toggle:active {
  transform: scale(0.95);
  opacity: 0.7;
}

.preview-anno-toggle.active {
  background: var(--accent);
  color: #FFFFFF;
  border-color: var(--accent);
}

.preview-content-wrap {
  position: relative;
  /* 在 .preview-area 的 flex 列布局中占满剩余空间并允许收缩 */
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.annotation-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  overflow: hidden;
  pointer-events: none;
  background: transparent;
}

.annotation-overlay.annotation-active {
  pointer-events: auto;
}

.anno-input-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 24px;
  background: var(--surface-2);
  border-bottom: 0.5px solid var(--menu-border);
}
html.no-flex-gap .anno-input-bar > * + * {
  margin-left: 8px;
}


.anno-input-field {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-sm);
  font-size: 14px;
  outline: none;
  background: var(--bg-base);
  color: var(--text-primary);
  min-height: 36px;
}

.anno-input-field:focus {
  border-color: var(--accent);
}

.annotation-cards-section {
  padding: 12px 24px 16px;
  border-top: 0.5px solid var(--menu-border);
}

.annotation-cards-label {
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
}
html.no-flex-gap .annotation-cards-label > * + * {
  margin-left: 6px;
}


.annotation-card {
  border-left: 4px solid var(--accent);
  background: var(--surface-2);
  padding: 10px 14px;
  margin-bottom: 10px;
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  box-shadow: var(--shadow-sm);
}

.annotation-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.annotation-card-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.annotation-card-del {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  font-size: 13px;
  touch-action: manipulation;
}

.annotation-card-del:active {
  color: var(--danger);
  transform: scale(0.9);
}

.annotation-card-quote {
  font-style: italic;
  color: var(--text-secondary);
  border-left: 2px solid var(--menu-border);
  padding-left: 10px;
  margin-bottom: 8px;
  font-size: 13px;
}

.annotation-card-text {
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.6;
}

/* ========== 画板模式 ========== */
.draw-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.draw-body--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-base);
}

.draw-empty-state {
  text-align: center;
  padding: 40px;
}

.draw-empty-icon {
  font-size: 64px;
  color: var(--text-tertiary);
  margin-bottom: 16px;
  display: block;
}

.draw-empty-state h3 {
  font-size: 18px;
  font-weight: var(--font-weight-semibold);
  margin-bottom: 8px;
  color: var(--text-primary);
}

.draw-empty-state p {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.resource-picker-item {
  display: flex;
  align-items: center;
  padding: 10px 16px;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: background var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.resource-picker-item:hover {
  background: var(--bg-base);
}
}

.resource-picker-item.is-dir {
  color: var(--accent);
  font-weight: var(--font-weight-semibold);
}

.resource-picker-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resource-picker-size {
  font-size: var(--font-size-caption);
  color: var(--text-tertiary);
  margin-left: 12px;
  flex-shrink: 0;
}

.mermaid-chart-wrapper {
  position: relative;
  margin: 12px 0;
  text-align: center;
  background: var(--surface-2);
  border-radius: var(--radius-md);
  padding: 16px;
  border: 1px solid var(--menu-border);
  overflow: hidden;
}

.mermaid-chart {
  display: flex;
  justify-content: center;
  overflow-x: auto;
}

.mermaid-chart svg {
  max-width: 100%;
  height: auto;
}

.mermaid-chart-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--duration-normal) var(--ease-standard);
}
html.no-flex-gap .mermaid-chart-actions > * + * {
  margin-left: 4px;
}


@media (hover: hover) {
.mermaid-chart-wrapper:hover .mermaid-chart-actions {
  opacity: 1;
}
}

.mermaid-edit-btn,
.mermaid-zoom-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  border: 1px solid var(--menu-border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-caption);
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

/* ⚠️ 这两条 hover 必须各自独立成块，不能写成
   `.a:hover, @media (hover: hover) { .b:hover {} }` ——
   那是**非法 CSS**：逗号后接 @media 会被 scoped 编译成
   `@media[data-v-xxx] (hover: hover)`，整条规则静默失效。
   构建时只报 "Unexpected @media" 警告但仍然通过，很容易被忽略。
   这是本文件里原本就存在的一处写法错误（此前「编辑图表」的
   hover 效果其实一直没生效），这次一并修掉。 */
@media (hover: hover) {
.mermaid-edit-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
}

@media (hover: hover) {
.mermaid-zoom-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}
}

.mermaid-edit-btn:active,
.mermaid-zoom-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.mermaid-error {
  color: var(--danger);
  background: var(--danger-soft);
  padding: 12px 16px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}

.mermaid-error-code {
  margin-top: 8px;
  background: var(--bg-base);
  padding: 8px 12px;
  border-radius: var(--radius-xs);
  font-family: monospace;
  font-size: var(--font-size-caption);
  white-space: pre-wrap;
}

.mermaid-zoom-panel {
  width: 95vw;
  max-width: 100vw;
  height: 92vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.zoom-overlay {
  z-index: 1000;
}

.zoom-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 0.5px solid var(--menu-border);
}
html.no-flex-gap .zoom-header > * + * {
  margin-left: 12px;
}


.zoom-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  margin-right: 8px;
}
html.no-flex-gap .zoom-controls > * + * {
  margin-left: 6px;
}


.zoom-ctrl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  border: 1px solid var(--menu-border);
  color: var(--text-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.zoom-ctrl-btn:hover {
  background: var(--accent);
  color: #FFFFFF;
  border-color: var(--accent);
}
}

.zoom-ctrl-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.zoom-level {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-secondary);
  min-width: 48px;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}

.zoom-viewport {
  flex: 1;
  overflow: hidden;
  position: relative;
  cursor: grab;
  background:
    repeating-linear-gradient(0deg, transparent, transparent 19px, var(--menu-border) 19px, var(--menu-border) 20px),
    repeating-linear-gradient(90deg, transparent, transparent 19px, var(--menu-border) 19px, var(--menu-border) 20px);
}

.zoom-viewport:active {
  cursor: grabbing;
}

.zoom-stage {
  position: absolute;
  top: 50%;
  left: 50%;
  transform-origin: 0 0;
  -webkit-user-select: none;
  user-select: none;
}

.zoom-stage .mermaid-zoom-content {
  display: inline-block;
}

.zoom-stage .mermaid-zoom-content svg {
  display: block;
  max-width: none;
  height: auto;
}

.zoom-hint {
  flex-shrink: 0;
  text-align: center;
  padding: 6px 16px;
  font-size: var(--font-size-caption2);
  color: var(--text-secondary);
  border-top: 0.5px solid var(--menu-border);
  -webkit-user-select: none;
  user-select: none;
}

/* Inline chart improvements for small screens */
.mermaid-chart-wrapper {
  position: relative;
  margin: 12px 0;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  background: var(--surface-2);
  overflow: hidden;
}

.mermaid-chart {
  padding: 12px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.mermaid-chart svg {
  display: block;
  max-width: none;
  min-width: 280px;
  height: auto;
}

.chart-editor-panel {
  width: 95vw;
  max-width: 1200px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}

.chart-editor-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 0.5px solid var(--menu-border);
  background: var(--bg-base);
  flex-shrink: 0;
  overflow-x: auto;
}
html.no-flex-gap .chart-editor-toolbar > * + * {
  margin-left: 4px;
}


.chart-toolbar-group {
  display: flex;
  align-items: center;
  gap: 4px;
}
html.no-flex-gap .chart-toolbar-group > * + * {
  margin-left: 4px;
}


.chart-toolbar-sep {
  width: 1px;
  height: 24px;
  background: var(--menu-border);
  margin: 0 6px;
  flex-shrink: 0;
}

.chart-tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--radius-md);
  background: none;
  border: 1px solid var(--menu-border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
  gap: 6px;
  white-space: nowrap;
}
html.no-flex-gap .chart-tool-btn > * + * {
  margin-left: 6px;
}


/* :hover 与 :active 必须拆开：
   合并写（`.x:hover, .x:active {}`）在触屏上点完之后，
   :hover 会「粘住」—— 按钮一直保持高亮，看起来像坏了。
   触屏只有 :active 是对的（有按下反馈、松开复原）。 */
.chart-tool-btn:active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}

@media (hover: hover) {
.chart-tool-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
}

.chart-preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-tertiary);
  padding: 40px;
}
html.no-flex-gap .chart-preview-empty > * + * {
  margin-top: 12px;
}


.chart-preview-empty i {
  font-size: 48px;
  opacity: 0.3;
}

.chart-editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
  max-height: calc(90vh - 140px);
}

.chart-editor-visual {
  flex: 1;
  display: flex;
  flex-direction: column;
  border-right: 0.5px solid var(--menu-border);
  min-width: 0;
}

.chart-preview-area {
  flex: 1;
  overflow: auto;
  padding: 16px;
  background: var(--surface-2);
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.chart-preview-svg {
  display: flex;
  justify-content: center;
}

.chart-preview-svg svg {
  max-width: 100%;
  height: auto;
}

.chart-editor-code {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chart-code-textarea {
  flex: 1;
  width: 100%;
  border: none;
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 16px;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  resize: none;
  outline: none;
  tab-size: 2;
}

.command-palette-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--mask);
  z-index: 3000;
  display: flex;
  justify-content: center;
  padding-top: 15vh;
}

.command-palette {
  width: 520px;
  max-width: 90vw;
  background: var(--menu-bg);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  max-height: 400px;
  display: flex;
  flex-direction: column;
}

.command-palette-input-wrap {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--menu-border);
}

.command-palette-icon {
  color: var(--text-tertiary);
  margin-right: 10px;
}

.command-palette-input {
  flex: 1;
  border: none;
  background: none;
  font-size: var(--font-size-md);
  color: var(--text-primary);
  outline: none;
}

.command-palette-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.command-palette-item {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-standard);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

@media (hover: hover) {
.command-palette-item:hover {
  background: var(--accent-soft);
}
}

.command-palette-label {
  flex: 1;
}

.command-palette-shortcut {
  font-size: var(--font-size-caption2);
  color: var(--text-tertiary);
  background: var(--bg-base);
  padding: 2px 8px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--menu-border);
}

.folder-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 原来这里是 0：卡片本身有 20px 圆角与玻璃底，但内容贴着边，
     上面「搜索」那张卡内缩 12px，到这里突然贴边 —— 一眼看过去像没做完。
     现在与 .sidebar-top 同一档内缩（12px）。 */
  padding: 12px;
  flex-shrink: 0;
}
html.no-flex-gap .folder-bar > * + * {
  margin-left: 6px;
}


/* 下拉与「新建文件夹」按钮统一 44px，与上面的搜索框同高。
   global.css 已经给所有 select 收掉了原生外观（appearance:none + 自绘箭头），
   这里只管尺寸与配色，不去覆盖那条；背景写 background-color 而不是
   background 简写 —— 简写会把 global 那张箭头背景图一起抹掉。 */
.folder-select {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 8px;
  border: 1px solid var(--menu-border);
  border-radius: var(--radius-md);
  background-color: var(--bg-base);
  color: var(--text-primary);
  font-size: var(--font-size-base);
  outline: none;
  cursor: pointer;
}

.folder-select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

/* 「新建文件夹」要和同一行的两个下拉**同一种材质**（实底 + 令牌边框）。
   原来是透明底带边框 —— 一个三件套里两种材质，怎么看都像拼上去的。 */
.folder-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  background-color: var(--bg-base);
  border: 1px solid var(--menu-border);
  color: var(--text-secondary);
  font-size: var(--font-size-base);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard), transform var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
  .folder-add-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

.folder-add-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

.file-item-meta {
  display: flex;
  align-items: center;
  gap: 4px;
}
html.no-flex-gap .file-item-meta > * + * {
  margin-left: 4px;
}


.file-badge-icon {
  font-size: var(--font-size-caption2);
  color: var(--text-tertiary);
}

.file-badge-icon.starred {
  color: var(--warning);
}

.search-highlight {
  background: rgba(var(--warning-rgb), 0.3);
  color: inherit;
  padding: 0 2px;
  border-radius: var(--radius-pill);
}

.markdown-body >>> h1 {
  font-size: 1.8em;
  font-weight: 700;
  margin: 16px 0 8px;
  padding-bottom: 6px;
  border-bottom: 0.5px solid var(--menu-border);
}

.markdown-body >>> h2 {
  font-size: 1.5em;
  font-weight: 600;
  margin: 14px 0 6px;
  padding-bottom: 4px;
  border-bottom: 0.5px solid var(--menu-border);
}

.markdown-body >>> h3 {
  font-size: 1.25em;
  font-weight: 600;
  margin: 12px 0 4px;
}

.markdown-body >>> h4 {
  font-size: 1.1em;
  font-weight: 600;
  margin: 10px 0 4px;
}

.markdown-body >>> h5,
.markdown-body >>> h6 {
  font-size: 1em;
  font-weight: 600;
  margin: 8px 0 4px;
}

.markdown-body >>> p {
  margin: 8px 0;
}

.markdown-body >>> ul,
.markdown-body >>> ol {
  padding-left: 20px;
  margin: 8px 0;
}

.markdown-body >>> li {
  margin: 4px 0;
}

.markdown-body >>> blockquote {
  border-left: 3px solid var(--accent);
  padding-left: 12px;
  margin: 8px 0;
  color: var(--text-secondary);
  background: var(--accent-soft);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  padding: 8px 12px;
}

.markdown-body >>> code {
  background: var(--bg-base);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-size: 0.9em;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
}

.markdown-body >>> pre {
  background: var(--bg-base);
  padding: 16px;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  margin: 8px 0;
  position: relative;
}

.markdown-body >>> pre code {
  background: none;
  padding: 0;
  display: block;
  white-space: pre;
  word-break: normal;
  word-wrap: normal;
  overflow-x: auto;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.9em;
  line-height: 1.5;
}

.markdown-body >>> .code-block-wrapper {
  position: relative;
  margin: 8px 0;
  border-radius: var(--radius-sm);
  overflow: hidden;
  /* 深浅主题共用同一个深色底 —— 见 global.css 里 --code-bg 的说明 */
  background: var(--code-bg);
}

.markdown-body >>> .code-block-inner {
  display: flex;
  overflow-x: auto;
  padding: 16px 0;
}

.markdown-body >>> .code-line-numbers {
  display: flex;
  flex-direction: column;
  padding: 0 12px;
  text-align: right;
  user-select: none;
  -webkit-user-select: none;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  min-width: 40px;
}

.markdown-body >>> .code-line-number {
  display: block;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.85em;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.25);
}

.markdown-body >>> .code-block-content {
  display: flex;
  flex-direction: column;
  padding: 0 16px;
  white-space: pre;
  word-break: normal;
  word-wrap: normal;
  font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
  font-size: 0.9em;
  line-height: 1.5;
  background: none;
  flex: 1;
  min-width: 0;
}

.markdown-body >>> .code-line {
  display: block;
}

.markdown-body >>> .code-lang-label {
  position: absolute;
  top: 6px;
  right: 8px;
  font-size: var(--font-size-caption2);
  color: rgba(255, 255, 255, 0.4);
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
}

.markdown-body >>> .table-wrapper {
  overflow-x: auto;
  margin: 8px 0;
  border-radius: var(--radius-sm);
  border: 1px solid var(--menu-border);
}

.markdown-body >>> table.md-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-size-sm);
}

.markdown-body >>> table.md-table th {
  background: var(--bg-base);
  font-weight: 600;
  color: var(--text-primary);
  padding: 10px 14px;
  text-align: left;
  border: 1px solid var(--menu-border);
}

.markdown-body >>> table.md-table td {
  padding: 8px 14px;
  text-align: left;
  border: 1px solid var(--menu-border);
  color: var(--text-primary);
}

@media (hover: hover) {
.markdown-body >>> table.md-table tr:hover td {
  background: var(--accent-soft);
}
}

.markdown-body >>> a {
  color: var(--accent);
  text-decoration: none;
}

@media (hover: hover) {
.markdown-body >>> a:hover {
  text-decoration: underline;
}
}

/* 无超能岛浏览器权限时链接转纯文本样式 */
.markdown-body >>> .msg-link-text {
  color: var(--text-primary);
  opacity: 0.85;
  word-break: break-all;
}
/* 无权限打开链接时，给纯文本加删除线提示 */
.markdown-body >>> .msg-link-no-perm {
  text-decoration: line-through;
  opacity: 0.6;
  cursor: not-allowed;
}

.markdown-body >>> img {
  max-width: 100%;
  border-radius: var(--radius-sm);
}

.markdown-body >>> hr {
  border: none;
  border-top: 0.5px solid var(--menu-border);
  margin: 16px 0;
}

.markdown-body >>> .katex {
  font-size: 1.1em;
}

.markdown-body >>> .katex-display-wrapper {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 0;
  text-align: center;
}

.markdown-body >>> .katex-display {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 0;
  margin: 4px 0;
}

.markdown-body >>> .katex-html {
  max-width: 100%;
  overflow-x: auto;
}

/* LaTeX 文档样式 */
.markdown-body >>> .latex-document {
  line-height: 1.6;
  padding: 16px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--menu-border);
  margin: 8px 0;
}
.markdown-body >>> .latex-tt {
  font-family: 'Menlo', 'Consolas', 'Courier New', monospace;
  background: rgba(127, 127, 127, 0.1);
  padding: 1px 4px;
  border-radius: var(--radius-xs);
}
.markdown-body >>> .latex-pagebreak {
  border: none;
  border-top: 1px dashed var(--menu-border);
  margin: 16px 0;
}
.markdown-body >>> .latex-block-wrapper {
  margin: 8px 0;
}
.markdown-body >>> .latex-colorbox {
  display: inline-block;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  line-height: 1.5;
}
.markdown-body >>> .latex-fbox {
  display: inline-block;
  border: 1px solid currentColor;
  padding: 4px 8px;
}
.markdown-body >>> .latex-parbox {
  display: block;
}
.markdown-body >>> .latex-list {
  padding-left: 2em;
  margin: 4px 0;
}
.markdown-body >>> .latex-list li {
  margin: 2px 0;
}
.markdown-body >>> .latex-quote {
  margin: 8px 0;
  padding: 8px 16px;
  border-left: 3px solid var(--menu-border);
  font-style: italic;
  opacity: 0.9;
}
.markdown-body >>> .latex-verbatim {
  background: rgba(127, 127, 127, 0.08);
  padding: 8px 12px;
  border-radius: var(--radius-xs);
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: var(--font-size-sm);
  white-space: pre-wrap;
}
.markdown-body >>> .latex-abstract {
  margin: 8px 0;
  padding: 8px 12px;
  font-size: 0.95em;
  opacity: 0.85;
}
.markdown-body >>> .latex-verse {
  margin: 8px 0;
  padding-left: 2em;
  white-space: pre-line;
}
/* LaTeX 字体大小 */
.markdown-body >>> .latex-tiny        { font-size: 0.5em; }
.markdown-body >>> .latex-footnotesize { font-size: 0.7em; }
.markdown-body >>> .latex-small       { font-size: 0.85em; }
.markdown-body >>> .latex-normalsize  { font-size: 1em; }
.markdown-body >>> .latex-large       { font-size: 1.2em; }
.markdown-body >>> .latex-Large       { font-size: 1.44em; }
.markdown-body >>> .latex-LARGE       { font-size: 1.73em; }
.markdown-body >>> .latex-huge        { font-size: 2.07em; }
.markdown-body >>> .latex-Huge        { font-size: 2.5em; }

.markdown-body >>> .latex-error {
  color: var(--danger);
  background: var(--danger-soft);
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  font-size: var(--font-size-sm);
  font-family: 'Menlo', 'Consolas', monospace;
}

.markdown-body >>> .note-annotation {
  background: rgba(var(--warning-rgb), 0.08);
  border-left: 3px solid var(--warning);
  padding: 10px 14px;
  margin: 8px 0;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-primary);
}

.markdown-body >>> .annotation-label {
  display: inline-block;
  background: var(--warning);
  color: var(--text-primary);
  font-size: var(--font-size-caption2);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--radius-xs);
  margin-right: 8px;
  vertical-align: middle;
}

.markdown-body >>> .todo-item {
  list-style: none;
  margin-left: -20px;
  padding-left: 4px;
}

.markdown-body >>> .todo-checkbox {
  margin-right: 6px;
  cursor: pointer;
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
  vertical-align: middle;
  position: relative;
}

.markdown-body >>> .todo-done {
  text-decoration: line-through;
  color: var(--text-tertiary);
}

.markdown-body >>> strong {
  font-weight: 600;
}

.markdown-body >>> del {
  color: var(--text-tertiary);
}

.cloud-panel {
  width: 600px;
  max-width: 90vw;
}

.cloud-panel-body {
  padding: 16px 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.cloud-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
html.no-flex-gap .cloud-toolbar > * + * {
  margin-left: 8px;
}


.cloud-note-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
html.no-flex-gap .cloud-note-list > * + * {
  margin-top: 8px;
}


.cloud-note-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--menu-border);
  transition: background var(--duration-fast) var(--ease-standard);
  gap: 12px;
}
html.no-flex-gap .cloud-note-item > * + * {
  margin-left: 12px;
}


@media (hover: hover) {
.cloud-note-item:hover {
  background: var(--accent-soft);
}
}

.cloud-note-info {
  flex: 1;
  min-width: 0;
}

.cloud-note-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cloud-note-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  font-size: var(--font-size-caption2);
  color: var(--text-tertiary);
}
html.no-flex-gap .cloud-note-meta > * + * {
  margin-left: 10px;
}


.cloud-note-folder,
.cloud-note-visibility,
.cloud-note-date {
  display: inline-flex;
  align-items: center;
}

.cloud-note-visibility.is-public {
  color: var(--success);
}

.cloud-note-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
html.no-flex-gap .cloud-note-actions > * + * {
  margin-left: 6px;
}


.cloud-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-size-sm);
  transition: background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}

@media (hover: hover) {
.cloud-action-btn:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
}

.cloud-action-btn:active {
  transform: scale(0.94);
  opacity: 0.7;
}

@media (hover: hover) {
.cloud-action-btn.danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
}

.cloud-folder-select {
  height: 30px;
  padding: 0 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--menu-border);
  background: var(--surface-2);
  color: var(--text-primary);
  font-size: var(--font-size-caption);
  cursor: pointer;
  max-width: 100px;
}

.cloud-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 16px;
  border-bottom: 2px solid var(--menu-border);
}

.cloud-tab-btn {
  flex: 1;
  padding: 10px 16px;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard);
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
}

.cloud-tab-btn.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

@media (hover: hover) {
.cloud-tab-btn:hover {
  color: var(--accent);
}
}

.public-note-item {
  cursor: pointer;
}

.cloud-note-author {
  display: inline-flex;
  align-items: center;
}

.cloud-note-fullscreen {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 4000;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.cloud-note-fullscreen-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 0.5px solid var(--menu-border);
  background: var(--surface-2);
  flex-shrink: 0;
}
html.no-flex-gap .cloud-note-fullscreen-header > * + * {
  margin-left: 12px;
}

.cloud-note-fullscreen-title {
  flex: 1;
  font-size: var(--font-size-subheadline);
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin: 0;
}
.cloud-note-fullscreen-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 20px;
  font-size: var(--font-size-caption);
  color: var(--text-tertiary);
  border-bottom: 0.5px solid var(--menu-border);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .cloud-note-fullscreen-meta > * + * {
  margin-left: 16px;
}

.cloud-note-fullscreen-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  line-height: 1.8;
  font-size: var(--font-size-body);
}

/* 画板只读查看：撑满内容区，无 max-width 限制 */
.cloud-note-draw-readonly {
  padding: 0;
  max-width: none;
  overflow: hidden;
}
.cloud-note-draw-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  color: var(--text-secondary);
}
.cloud-note-draw-empty i {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.5;
}
.cloud-note-draw-empty p {
  font-size: 15px;
  color: var(--text-primary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

@media (max-width: 768px) {
  .preview-area {
    border-left: none;
  }

  .editor-content {
    flex: 1;
  }

  /* Tablet Mermaid improvements */
  .mermaid-chart {
    padding: 8px;
  }

  .mermaid-chart svg {
    min-width: 220px;
  }

  .mermaid-edit-btn,
  .mermaid-zoom-btn {
    width: 36px;
    height: 36px;
    font-size: var(--font-size-callout);
    opacity: 1;
  }

  .mermaid-chart-actions {
    opacity: 0.85;
    top: 4px;
    right: 4px;
    gap: 6px;
  }

  .mermaid-zoom-panel {
    width: 100vw;
    height: 100vh;
    max-width: 100vw;
    border-radius: 0;
  }

  .zoom-ctrl-btn {
    width: 36px;
    height: 36px;
    font-size: var(--font-size-callout);
  }

  .zoom-level {
    font-size: var(--font-size-sm);
    min-width: 54px;
  }

  .zoom-hint {
    font-size: var(--font-size-caption);
    padding: 8px 16px;
  }
}

@media (min-width: 1024px) and (orientation: landscape) {
  .sidebar-search {
    height: 44px;
    padding: 0 12px;
  }

  .sidebar-search-input {
    font-size: var(--font-size-base);
  }

  .file-item {
    padding: 12px 14px;
  }

  .file-item-title {
    font-size: var(--font-size-base);
  }

  .editor-toolbar {
    padding: 6px 14px;
  }

  .toolbar-btn {
    width: 44px;
    height: 44px;
    font-size: var(--font-size-sm);
  }

  .editor-textarea {
    line-height: 2;
    /* 横屏大屏：内边距继续放宽（原来的 24px 是这档的下限，不动） */
    padding: 20px clamp(24px, 2.4vw, 40px);
  }

  .editor-resizer {
    width: 12px;
  }

  .chart-editor-body {
    flex-direction: column;
  }

  .chart-editor-visual {
    border-right: none;
    border-bottom: 0.5px solid var(--menu-border);
    min-height: 200px;
    max-height: 40vh;
  }

  .chart-editor-code {
    min-height: 150px;
  }

  .chart-tool-btn {
    min-width: 48px;
    height: 48px;
    font-size: var(--font-size-callout);
  }

  .mermaid-edit-btn,
  .mermaid-zoom-btn {
    width: 36px;
    height: 36px;
    font-size: var(--font-size-sm);
    opacity: 1;
  }

  .mermaid-chart-actions {
    opacity: 1;
  }

  .command-palette {
    width: 90vw;
  }

  .command-palette-item {
    padding: 14px 16px;
    font-size: var(--font-size-base);
  }

  .toolbar-btn {
    width: 44px;
    height: 44px;
    font-size: var(--font-size-sm);
  }

  /* 文件夹栏三件套在横屏大屏下也保持 44px —— 原来是这里单独给到 40px，
     而同列的搜索框是 44px，同一列又出现两种高度。 */
  .folder-select,
  .sort-select,
  .folder-add-btn {
    height: 44px;
    font-size: var(--font-size-base);
  }

  .folder-add-btn {
    width: 44px;
  }

  .chart-code-textarea {
    font-size: var(--font-size-body);
    padding: 16px;
    line-height: 1.8;
  }

  .modal-panel {
    max-height: 95vh;
  }

  /* :not(.btn-sm) 是必须的：这条规则给的是「标准尺寸」，
     而工具栏里的新建/导入是 .btn-sm。若不排除，实测「新建」会拿到 10px 20px 的
     padding、「导入」拿 .btn-sm 的 padding —— 高度被 min-height 拉齐了，
     宽度却又不一样，一行里两个按钮还是对不齐。 */
  .btn-primary:not(.btn-sm),
  .btn-secondary:not(.btn-sm) {
    min-height: 44px;
    padding: 10px 20px;
    font-size: var(--font-size-base);
  }
}
</style>
