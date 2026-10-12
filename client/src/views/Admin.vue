<template>
  <div class="admin-page">
    <AppNav active="admin" />

    <main class="body">
      <!-- 标签页 -->
      <div class="tabs glass">
        <Segmented v-model="tab" :options="tabOptions" />
        <span class="tiny muted tabs-note">{{ instanceLabel }}</span>
      </div>

      <div v-if="error" class="alert alert-danger">{{ error }}</div>

      <!-- ================= 总览（信息看板） ================= -->
      <template v-if="tab === 'overview'">
        <section class="metrics">
          <div class="metric glass">
            <div class="metric-label">学生数</div>
            <div class="metric-value">{{ (dashboard && dashboard.totals.users) || 0 }}</div>
            <!-- 管理员单列：他们也在额度表与消耗榜里，只是不计入「学生数」这个人数口径 -->
            <div v-if="dashboard && dashboard.totals.admins" class="tiny muted metric-foot">
              另含 {{ dashboard.totals.admins }} 个管理员账号
            </div>
          </div>
          <div class="metric glass">
            <div class="metric-label">已分配额度</div>
            <div class="metric-value">¥{{ (dashboard && dashboard.totals.allocated_yuan) || '0.00' }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">已消耗（累计）</div>
            <div class="metric-value">¥{{ (dashboard && dashboard.totals.used_yuan) || '0.00' }}</div>
          </div>
          <div class="metric glass metric-primary" :class="{ 'metric-alert': dashboard && dashboard.month && dashboard.month.exceeded }">
            <div class="metric-label">本月消耗<span v-if="dashboard && dashboard.month && dashboard.month.exceeded" class="badge badge-danger">超预算</span></div>
            <div class="metric-value">¥{{ (dashboard && dashboard.month && dashboard.month.cost_yuan) || '0.00' }}</div>
            <div class="budget-row tiny muted">
              <span>预算 ¥</span>
              <input v-model="budgetYuan" class="budget-input" type="number" min="0" step="1" title="0 = 不提醒" />
              <button class="btn btn-sm btn-ghost" @click="saveBudget">存</button>
            </div>
          </div>
          <div class="metric glass">
            <div class="metric-label">调用次数</div>
            <div class="metric-value">{{ (dashboard && dashboard.totals.calls) || 0 }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">峰谷</div>
            <div class="metric-value metric-value-sub">
              <span
                v-if="dashboard && dashboard.offpeak && dashboard.offpeak.enabled"
                class="badge"
                :class="dashboard.offpeak.active_now ? 'badge-success' : 'badge-accent'"
              >{{ dashboard.offpeak.active_now ? '谷时' : '峰时' }}</span>
              <span v-else class="badge">未启用</span>
            </div>
            <div class="tiny muted metric-foot">{{ (dashboard && dashboard.offpeak && dashboard.offpeak.text) || '—' }}</div>
          </div>
        </section>

        <div class="bottom-grid">
          <section class="panel glass">
            <h2 class="panel-title">消耗趋势（近 14 天）</h2>
            <UsageChart :items="trendItems" field="cost_yuan" />
          </section>

          <section class="panel glass" v-if="dashboard">
            <h2 class="panel-title">系统状态</h2>
            <div class="list-scroll">
              <div class="row-line">
                <span class="line-key">实例</span>
                <span class="line-amount">{{ dashboard.instance_id }}（{{ dashboard.mode }} 模式）</span>
              </div>
              <div class="row-line">
                <span class="line-key">版本</span>
                <span class="line-amount">v{{ dashboard.version }}</span>
              </div>
              <div class="row-line">
                <span class="line-key">峰谷</span>
                <span class="line-amount">{{ dashboard.offpeak.text }}</span>
              </div>
              <div class="row-line">
                <span class="line-key">本月预算</span>
                <span class="line-amount">{{ Number(dashboard.month.threshold_yuan) > 0 ? '¥' + dashboard.month.threshold_yuan : '未设' }}</span>
              </div>
              <div class="row-line">
                <span class="line-key">积分换算</span>
                <span class="line-amount">1 元 = {{ dashboard.points_per_yuan }} 积分</span>
              </div>
            </div>
          </section>
        </div>

        <div class="bottom-grid">
          <!-- 本班名册（ClassIntra 联动）：名册即世界边界 —— 本班不全就没法提前给全班开额度，
               他班残留会抢占同号学生的位置（学号体系与 CI 同构）。清理是破坏性动作，必须二次确认 -->
          <section class="panel glass roster-span">
            <h2 class="panel-title">本班名册（ClassIntra 联动）</h2>
            <div class="list-scroll" v-if="roster.status">
              <div class="row-line">
                <span class="line-key">本班</span>
                <span class="line-amount">{{ roster.status.enrollment_year }} 届 {{ roster.status.class_no }} 班 · 在册 {{ roster.status.in_class }} 人</span>
              </div>
              <div class="row-line">
                <span class="line-key">联动</span>
                <span class="line-amount">{{ roster.status.bridge_enabled ? '已接入 ClassIntra' : '未配置联动' }}</span>
              </div>
              <div class="row-line">
                <span class="line-key">非本班账号</span>
                <span class="line-amount">{{ roster.status.foreign_count ? roster.status.foreign_count + ' 个' : '无' }}</span>
              </div>
              <p v-if="roster.status.foreign_count" class="tiny muted roster-ids">
                {{ roster.status.foreign.map(function (u) { return u.user_id; }).join('、') }}
              </p>
              <div class="roster-actions">
                <button class="btn btn-sm btn-ghost roster-btn" type="button" :disabled="roster.busy" @click="syncRoster">
                  {{ roster.busy ? '同步中…' : '同步本班' }}
                </button>
                <button
                  class="btn btn-sm btn-ghost roster-btn roster-btn-danger"
                  type="button"
                  :disabled="roster.busy || !roster.status.foreign_count"
                  @click="pruneRoster"
                >清理非本班</button>
              </div>
              <p class="tiny muted roster-note">
                同步只增不删（幂等）；清理会连同这些账号的会话、额度与流水一并删除，不可恢复。
              </p>
            </div>
            <p v-else-if="roster.unavailable" class="tiny muted" style="padding: 6px 2px;">
              {{ roster.unavailable }}
            </p>
            <p v-else class="tiny muted" style="padding: 6px 2px;">{{ roster.loading ? '读取中…' : '暂无数据' }}</p>
          </section>
        </div>

        <div class="bottom-grid">
          <section class="panel glass">
            <h2 class="panel-title">班级概览</h2>
            <div class="list-scroll">
              <div v-for="c in classes" :key="c.class_no" class="row-line">
                <span class="line-key">{{ c.class_no === '--' ? '未填班级' : c.class_no + ' 班' }}</span>
                <span class="tiny muted">{{ c.students }} 人</span>
                <span class="line-amount">¥{{ c.allocated_yuan }}</span>
              </div>
              <div v-if="!classes.length" class="empty-cell muted tiny">{{ loading ? '读取中…' : '暂无数据' }}</div>
            </div>
          </section>

          <section class="panel glass">
            <h2 class="panel-title">消耗 Top 10（累计）</h2>
            <div class="table-wrap" v-if="dashboard && dashboard.top_users && dashboard.top_users.length">
              <table class="table">
                <thead>
                  <tr><th>账号</th><th class="num">消耗</th><th class="num">已分配</th><th class="num">次数</th></tr>
                </thead>
                <tbody>
                  <tr v-for="u in dashboard.top_users" :key="u.user_id">
                    <td>{{ u.name }}<span v-if="u.is_admin" class="badge badge-accent admin-badge">管理</span><span class="tiny muted mono"> {{ u.user_id }}</span></td>
                    <td class="num">¥{{ u.used_yuan }}</td>
                    <td class="num">¥{{ u.allocated_yuan }}</td>
                    <td class="num">{{ u.calls }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="tiny muted" style="padding: 6px 2px;">还没有用量记录</p>
          </section>
        </div>

        <!-- Cluss-Cloud 账号绑定：把「本班班管」和「云端学校管理员」认成同一个人。
             两边原本是两个账号两套密码，交接/换届时最容易乱；绑定后管理员在云端
             的每一次操作都落在「哪个班 + 哪个学号」上。方向必须从这台电脑发起 ——
             云端不存班级密码，网页上填学号等于谁都能声称自己是任何人，只有本机
             能证明「此刻登录的是本班学号 X 且他是班管」。 -->
        <section class="panel glass bind-panel">
          <h2 class="panel-title">Cluss-Cloud 账号绑定</h2>
          <div class="row-line">
            <span class="line-key">本机身份</span>
            <span class="line-amount mono">{{ meUserId || '未知' }} · {{ isNodeMode ? 'node 模式（可发起）' : '未接入中继' }}</span>
          </div>
          <div class="row-line">
            <span class="line-key">云端管理员</span>
            <span class="line-amount">
              <input
                class="input input-sm mono"
                v-model="cloudBind.adminUsername"
                placeholder="你在云端注册学校时填的用户名"
                autocapitalize="off" spellcheck="false"
              />
            </span>
          </div>
          <div class="roster-actions">
            <button
              class="btn btn-sm btn-ghost roster-btn"
              type="button"
              :disabled="cloudBind.busy || !cloudBind.adminUsername"
              @click="requestCloudBind"
            >{{ cloudBind.busy ? '生成中…' : '生成确认码' }}</button>
          </div>
          <div v-if="cloudBind.code" class="bind-code">
            <span class="tiny muted">确认码（15 分钟内有效，只能用一次）</span>
            <div class="bind-code-value mono">{{ cloudBind.code }}</div>
            <p class="tiny muted" style="margin: 6px 0 0;">
              打开 Cluss-Cloud 网页 → 用管理员账号登录 → 「账号绑定」页签 → 粘贴上面的码确认。
              一个学校只能有一个班管占管理员席位，别的班管来时会看到席位已被占用。
            </p>
          </div>
          <p v-if="cloudBind.error" class="tiny" style="color: var(--danger-text, #d64545); margin: 8px 0 0;">{{ cloudBind.error }}</p>
        </section>
      </template>

<!-- ================= 额度分配 ================= -->
        <!-- 列表含管理员：班管本人既管钱也是要用的学生，滤掉他就找不到自己那一行、
             连给自己充值都做不到（充值按钮挂在每行的操作列上）。管理员行加徽标区分。 -->
        <template v-else-if="tab === 'quota'">
          <section class="panel glass">
            <div class="panel-head">
              <div>
                <h2 class="panel-title">额度分配</h2>
                <p class="panel-sub tiny muted">充值按「追加」计算，在现有额度上累加，永不覆盖。带「管理」徽标的是管理员账号（含班管本人）——他们同样在这张表里</p>
              </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="exportSnapshot">导出台账</button>
              <button class="btn btn-sm btn-ghost" @click="loadQuotaTab">刷新</button>
              <button class="btn btn-sm btn-primary" :disabled="!selected.length" @click="openBatch">
                批量追加（{{ selected.length }}）
              </button>
            </div>
          </div>

          <div class="filters-row">
            <input
              v-model="keyword"
              class="input filter-input"
              type="text"
              placeholder="搜索学号 / 姓名 / 用户名"
              @keyup.enter="loadUsers"
            />
            <select v-model="classFilter" class="input filter-select">
              <option value="">全部班级</option>
              <option v-for="c in classes" :key="c.class_no" :value="c.class_no">
                {{ c.class_no === '--' ? '未填班级' : c.class_no + ' 班' }}（{{ c.students }} 人）
              </option>
            </select>
            <button class="btn btn-sm btn-primary" @click="loadUsers">搜索</button>
          </div>

          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th class="col-check"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
                  <th>学号</th>
                  <th>姓名</th>
                  <th>班级</th>
                  <th class="num">已分配</th>
                  <th class="num">已消耗</th>
                  <th class="num">余额</th>
                  <th class="num">调用</th>
                  <th class="col-op">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in filteredUsers" :key="u.user_id">
                  <td class="col-check"><input type="checkbox" :value="u.user_id" v-model="selected" /></td>
                  <td class="mono">{{ u.user_id }}</td>
                  <td>
                    {{ u.real_name }}
                    <span v-if="u.is_admin" class="badge badge-accent admin-badge">管理</span>
                  </td>
                  <td>{{ u.class_no ? u.class_no + ' 班' : '--' }}</td>
                  <td class="num">¥{{ u.allocated_yuan }}</td>
                  <td class="num">¥{{ u.used_yuan }}</td>
                  <td class="num" :class="{ 'text-danger': Number(u.remaining_yuan) <= 0 }">¥{{ u.remaining_yuan }}</td>
                  <td class="num">{{ u.calls }}</td>
                  <td class="col-op">
                    <button class="btn btn-sm btn-primary" @click="openSingle(u)">追加</button>
                    <button
                      v-if="Number(u.allocated_yuan) > 0"
                      class="btn btn-sm btn-ghost op-revoke"
                      @click="revokeQuota(u)"
                    >收回</button>
                  </td>
                </tr>
                <tr v-if="!filteredUsers.length">
                  <td colspan="9" class="empty-cell muted">{{ loading ? '读取中…' : '没有匹配的账号' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel glass">
          <h2 class="panel-title">充值流水</h2>
          <div class="list-scroll">
            <div v-for="l in logs" :key="l.id" class="log-row">
              <div class="log-main">
                <span class="log-user">{{ l.real_name || l.net_name || l.user_id }}</span>
                <span class="log-amount" :class="l.amount_micro >= 0 ? 'text-success' : 'text-danger'">
                  {{ l.amount_micro >= 0 ? '+' : '' }}{{ l.amount_yuan }}
                </span>
              </div>
              <div class="log-meta tiny muted">
                {{ l.kind }} · {{ l.reason || '无备注' }} · {{ formatTime(l.created_at) }}
              </div>
            </div>
            <div v-if="!logs.length" class="empty-cell muted tiny">{{ loading ? '读取中…' : '暂无流水' }}</div>
          </div>
        </section>
      </template>

      <!-- ================= 模型与单价 ================= -->
      <template v-else-if="tab === 'models'">
        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">模型与单价</h2>
              <p class="panel-sub tiny muted" v-if="baseModel">
                改动即时生效。计费基准 = 默认模型「{{ baseModel.label }}」：
                输入 {{ fmtPrice(baseModel.price_in) }} / 输出 {{ fmtPrice(baseModel.price_out) }} /
                缓存 {{ fmtPrice(baseModel.price_cache_hit) }}（元 / 百万 token），
                其他模型按「基准 × 倍率」扣积分，改基准价即全站调价。
              </p>
              <p class="panel-sub tiny muted" v-else>
                改动即时生效。尚未设置默认模型单价，各模型暂按自身单价计费——
                请先在默认模型的编辑页配置基准单价。
              </p>
            </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="loadModels">刷新</button>
              <button class="btn btn-sm btn-primary" @click="openModelForm(null)">新增模型</button>
            </div>
          </div>

          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>源</th>
                  <th>API 地址</th>
                  <th class="num">相对倍率</th>
                  <th>峰谷</th>
                  <th>能力</th>
                  <th>状态</th>
                  <th class="col-op-wide">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in models" :key="m.id">
                  <td>
                    <div class="model-cell">
                      <span class="model-name">{{ m.label }}</span>
                      <span class="tiny muted mono">{{ m.id }}</span>
                    </div>
                  </td>
                  <td class="tiny">
                    <span v-if="m.source_missing" class="badge badge-danger" :title="'所挂模型源「' + m.source_id + '」不存在或已停用'">源已失效</span>
                    <span v-else-if="m.source_id" class="badge badge-accent" :title="'连接信息来自模型源：' + m.source_id">{{ m.source_label || m.source_id }}</span>
                    <span v-else class="muted">自带</span>
                  </td>
                  <td class="tiny muted addr-cell" :title="m.api_url">{{ m.api_url || '未配置' }}</td>
                  <td class="num">
                    <span v-if="m.is_default" class="badge badge-accent" title="默认模型即计费基准">基准</span>
                    <span v-else>×{{ (Number(m.price_multiplier) || 1).toFixed(2) }}</span>
                  </td>
                  <td class="tiny">
                    <span v-if="m.is_free" class="muted">—</span>
                    <span v-else-if="!m.has_offpeak" class="muted" title="本模型不参与峰谷，全天按原价计">不参与</span>
                    <span v-else class="badge badge-success" :title="offpeakModelTip(m)">参与</span>
                  </td>
                  <td>
                    <span v-if="m.supports_vision" class="badge badge-accent">视觉</span>
                    <span v-if="m.is_free" class="badge badge-success">免费</span>
                    <span
                      v-if="m.free_active"
                      class="badge badge-accent"
                      :title="'限免至 ' + formatTime(m.free_until)"
                    >限免</span>
                    <span v-if="!m.supports_vision && !m.is_free && !m.free_active" class="tiny muted">—</span>
                  </td>
                  <td>
                    <span v-if="m.is_default" class="badge badge-accent">默认</span>
                    <span v-if="!m.enabled" class="badge badge-danger">已禁用</span>
                    <span v-else-if="m.source_missing" class="badge badge-danger">源失效</span>
                    <span v-else-if="!m.has_api_key" class="badge badge-danger">缺 Key</span>
                    <span v-else-if="!m.is_default" class="badge badge-success">可用</span>
                  </td>
                  <td class="col-op-wide">
                    <button class="btn btn-sm btn-ghost" @click="openModelForm(m)">编辑</button>
                    <button
                      v-if="!m.is_default && m.enabled"
                      class="btn btn-sm btn-ghost"
                      @click="setDefault(m)"
                    >设默认</button>
                    <button class="btn btn-sm btn-ghost danger-text" @click="deleteModel(m)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ================= 模型源（共享地址与密钥） ================= -->
        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">模型源</h2>
              <p class="panel-sub tiny muted">
                一个上游常一次提供多个模型：把地址与密钥放在这里共享，模型只挂源即可 ——
                上游换域名 / 换密钥只改一处。<strong>源是可选的</strong>：不挂源的模型继续用各自的地址与密钥。
              </p>
            </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="loadModels">刷新</button>
              <button class="btn btn-sm btn-primary" @click="openSourceForm(null)">新增模型源</button>
            </div>
          </div>

          <div v-if="!sources.length" class="tiny muted" style="padding: 4px 0 8px;">
            还没有模型源。需要给多个模型共享同一个地址与密钥时再建；单个模型直接自带连接信息也完全可以。
          </div>
          <div v-else class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>源</th>
                  <th>API 地址</th>
                  <th class="num">挂载模型</th>
                  <th>状态</th>
                  <th class="col-op-wide">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in sources" :key="s.id">
                  <td>
                    <div class="model-cell">
                      <span class="model-name">{{ s.label || s.id }}</span>
                      <span class="tiny muted mono">{{ s.id }}</span>
                    </div>
                  </td>
                  <td class="tiny muted addr-cell" :title="s.api_url">{{ s.api_url || '未配置' }}</td>
                  <td class="num">{{ s.model_count }}</td>
                  <td>
                    <span v-if="!s.enabled" class="badge badge-danger">已停用</span>
                    <span v-else-if="!s.has_api_key" class="badge badge-danger">缺 Key</span>
                    <span v-else class="badge badge-success">可用</span>
                  </td>
                  <td class="col-op-wide">
                    <button class="btn btn-sm btn-ghost" @click="openSourceForm(s)">编辑</button>
                    <button class="btn btn-sm btn-ghost danger-text" @click="deleteSource(s)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ================= 峰谷时段（全局默认） ================= -->
        <section class="panel glass">
          <h2 class="panel-title">峰谷时段（全局默认）</h2>
          <p class="panel-sub tiny muted">
            峰时段（忙时）内按基准价计费，其余时段（谷时 / 闲时）按折扣计，引导学生错峰使用。
            判定用服务器所在时区的墙上时间；每轮对话以「结算完成时刻」落进哪个时段为准。
            <strong>这份是全局默认值</strong>：逐个模型是否参与、用自己的峰窗与折扣，在模型编辑页里配
            —— 上游的峰谷政策逐模型不同，一刀切会给没有谷时价的模型凭空打折。
          </p>

          <div class="switch-list">
            <label class="switch-row">
              <input type="checkbox" v-model="offpeak.enabled" />
              <span>启用峰谷折扣（关闭后全天按原价计）</span>
            </label>
          </div>

          <div class="row-3">
            <label class="field">
              <span class="field-label">峰时段一 · 开始</span>
              <input v-model="offpeak.peaks[0].start" class="input" type="time" :disabled="!offpeak.enabled" />
            </label>
            <label class="field">
              <span class="field-label">峰时段一 · 结束</span>
              <input v-model="offpeak.peaks[0].end" class="input" type="time" :disabled="!offpeak.enabled" />
            </label>
            <label class="field">
              <span class="field-label">谷时折扣（折）</span>
              <input v-model="offpeak.discount" class="input" type="number" min="0.1" max="9.9" step="0.5" :disabled="!offpeak.enabled" />
            </label>
          </div>

          <div class="row-3">
            <label class="field">
              <span class="field-label">峰时段二 · 开始（可留空）</span>
              <input v-model="offpeak.peaks[1].start" class="input" type="time" :disabled="!offpeak.enabled" />
            </label>
            <label class="field">
              <span class="field-label">峰时段二 · 结束</span>
              <input v-model="offpeak.peaks[1].end" class="input" type="time" :disabled="!offpeak.enabled" />
            </label>
            <span></span>
          </div>

          <p class="tiny muted" style="margin: -4px 0 var(--gap-md);">
            参照 DeepSeek 官方峰谷：高峰 09:00–12:00、14:00–18:00，低谷约为高峰的一半（午休 12:00–14:00 属于低谷）；
            两个峰窗口不能重叠，结束小于开始表示跨午夜。
            <template v-if="offpeak.enabled">，当前：{{ offpeak.active_now ? '谷时（优惠中）' : '峰时' }}</template>
          </p>

          <div class="panel-actions">
            <button class="btn btn-primary" :disabled="savingOffpeak" @click="saveOffpeak">
              {{ savingOffpeak ? '保存中…' : '保存峰谷配置' }}
            </button>
          </div>
        </section>
      </template>

      <!-- ================= 视觉配置 ================= -->
      <template v-else-if="tab === 'vision'">
        <section class="panel glass">
          <h2 class="panel-title">看图能力</h2>
          <p class="panel-sub tiny muted">
            拍题解答与作业批改需要模型能看懂图片。模型本身支持视觉时直接传图；
            不支持时，用「转述模型」先把图片转成文字再回答。
          </p>

          <div v-if="!vision.sharp_available" class="alert alert-warning">
            服务器未安装 sharp 图片处理库，图片将不做压缩（原图直传，更慢也更费流量）。
            如需压缩，请在 server 目录执行 <code>npm install sharp</code>。
          </div>

          <div class="switch-list">
            <label class="switch-row">
              <input type="checkbox" v-model="vision.enabled" />
              <span>启用看图功能（关闭后拍题与批改入口不可用）</span>
            </label>
            <label class="switch-row">
              <input type="checkbox" v-model="vision.shrink_enabled" />
              <span>上传的图片自动压缩（手机照片常有 3~8MB，压缩后识别更快更省）</span>
            </label>
          </div>

          <label class="field">
            <span class="field-label">转述模型（用于不支持视觉的模型）</span>
            <select v-model="vision.relay_model_id" class="input">
              <option value="">不使用转述（只有支持视觉的模型能拍题）</option>
              <option v-for="m in relayCandidates" :key="m.id" :value="m.id">{{ m.label }}（{{ m.id }}）</option>
            </select>
            <span class="tiny muted field-note">
              只列出「已启用、配好 Key 且自身支持视觉」的模型。
            </span>
          </label>

          <div class="row-3">
            <label class="field">
              <span class="field-label">单次最多图片数</span>
              <input v-model="vision.max_images" class="input" type="number" min="1" max="6" />
            </label>
            <label class="field">
              <span class="field-label">压缩长边上限（px）</span>
              <input v-model="vision.image_max_edge" class="input" type="number" min="200" max="4096" />
            </label>
            <label class="field">
              <span class="field-label">压缩质量（1~100）</span>
              <input v-model="vision.image_quality" class="input" type="number" min="1" max="100" />
            </label>
          </div>

          <div class="panel-actions">
            <button class="btn btn-primary" :disabled="savingVision" @click="saveVision">
              {{ savingVision ? '保存中…' : '保存配置' }}
            </button>
          </div>
        </section>
      </template>

      <!-- ================= 用量统计 ================= -->
      <template v-else-if="tab === 'usage'">
        <!-- 异常检出：成本安全的短板在管理员的可见性 —— 这两个视图纯管理侧，学生永远看不到 -->
        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">异常检出</h2>
              <p class="panel-sub tiny muted">
                左：近 7 天消耗 Top 10。右：最近 24 小时消耗 ≥ 0.5 元且达到前 7 天日均 3 倍的账号
                （滚动窗口，避开日期边界）。
              </p>
            </div>
            <div class="panel-actions">
              <button class="btn btn-sm btn-ghost" @click="loadAnomalies">刷新</button>
            </div>
          </div>

          <div class="anomaly-grid">
            <div>
              <h3 class="anomaly-title tiny muted">近 7 天消耗 Top 10</h3>
              <table v-if="anomalies.top && anomalies.top.length" class="table">
                <thead>
                  <tr><th>账号</th><th>班级</th><th class="num">消耗</th><th class="num">次数</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in anomalies.top" :key="r.user_id">
                    <td>{{ r.name }}<span v-if="r.is_admin" class="badge badge-accent admin-badge">管理</span><span class="tiny muted mono"> {{ r.user_id }}</span></td>
                    <td>{{ r.class_no || '—' }}</td>
                    <td class="num">¥{{ r.cost_yuan }}</td>
                    <td class="num">{{ r.calls }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="tiny muted">近 7 天还没有用量记录</p>
            </div>
            <div>
              <h3 class="anomaly-title tiny muted">最近 24 小时突增</h3>
              <table v-if="anomalies.spikes && anomalies.spikes.length" class="table">
                <thead>
                  <tr><th>学生</th><th class="num">24h</th><th class="num">前 7 天日均</th><th class="num">倍数</th></tr>
                </thead>
                <tbody>
                  <tr v-for="r in anomalies.spikes" :key="r.user_id">
                    <td>{{ r.name }}<span v-if="r.is_admin" class="badge badge-accent admin-badge">管理</span><span class="tiny muted mono"> {{ r.user_id }}</span></td>
                    <td class="num">¥{{ r.day_yuan }}</td>
                    <td class="num">¥{{ r.avg_yuan }}</td>
                    <td class="num"><span class="badge badge-danger">{{ r.ratio }}×</span></td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="tiny muted">没有检出突增账号 —— 这是好事</p>
            </div>
          </div>
        </section>

        <div class="filters glass">
          <Segmented v-model="usageDays" :options="dayOptions" />
          <Segmented v-model="usageGroup" :options="usageGroupOptions" />
          <button class="icon-btn" title="刷新" @click="loadUsage">↻</button>
          <button class="btn btn-sm btn-ghost" @click="exportUsage">导出 CSV</button>
        </div>

        <section class="metrics">
          <div class="metric glass">
            <div class="metric-label">区间费用</div>
            <div class="metric-value">¥{{ usageTotals.cost_yuan || '0.00' }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">调用次数</div>
            <div class="metric-value">{{ usageTotals.calls || 0 }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">总 Token</div>
            <div class="metric-value">{{ formatTokens(usageTotals.total_tokens) }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">图片调用</div>
            <div class="metric-value">{{ usageTotals.image_count || 0 }}</div>
          </div>
        </section>

        <div class="panels">
          <section class="panel glass">
            <h2 class="panel-title">消耗趋势（元）</h2>
            <UsageChart :items="usageItems" field="cost_yuan" />
          </section>

          <section class="panel glass">
            <h2 class="panel-title">{{ usageGroupTitle }}</h2>
            <div class="list-scroll">
              <div v-for="(item, idx) in usageItems" :key="idx" class="row-line">
                <span class="line-key">{{ usageLabelOf(item) }}</span>
                <span class="tiny muted">{{ item.calls }} 次</span>
                <span class="line-amount">¥{{ item.cost_yuan }}</span>
              </div>
              <div v-if="!usageItems.length" class="empty-cell muted tiny">{{ usageLoading ? '读取中…' : '暂无数据' }}</div>
            </div>
          </section>
        </div>

        <section class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">调用明细</h2>
            <span class="tiny muted">共 {{ usageRecordTotal }} 条</span>
          </div>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>学生</th>
                  <th>类型</th>
                  <th>模型</th>
                  <th class="num">输入</th>
                  <th class="num">输出</th>
                  <th class="num">图片</th>
                  <th class="num">费用</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in usageRecords" :key="r.id">
                  <td class="tiny nowrap">{{ formatTimeShort(r.created_at) }}</td>
                  <td class="tiny">{{ r.user_name }}</td>
                  <td><span class="badge">{{ sourceLabel(r.source) }}</span></td>
                  <td class="tiny">{{ r.model_label }}</td>
                  <td class="num">{{ r.prompt_tokens }}</td>
                  <td class="num">{{ r.completion_tokens }}</td>
                  <td class="num">{{ r.image_count || '—' }}</td>
                  <td class="num">{{ r.estimated ? '~' : '' }}¥{{ r.cost_yuan }}</td>
                </tr>
                <tr v-if="!usageRecords.length">
                  <td colspan="8" class="empty-cell muted">{{ usageLoading ? '读取中…' : '暂无记录' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </main>

    <!-- 追加充值弹窗：叠加式，不覆盖原额度，可连续多轮追加 -->
    <transition name="fade">
      <div v-if="quotaModal.open" class="modal-mask" @click.self="closeQuota">
        <div class="modal glass">
          <h3 class="modal-title">
            {{ quotaModal.mode === 'batch' ? '批量追加充值' : '追加充值 · ' + quotaModal.targetName }}
          </h3>
          <p class="modal-sub tiny muted">
            {{ quotaModal.mode === 'batch'
              ? '已选择 ' + selected.length + ' 个学生，本次金额将各自累加到其现有额度上'
              : '学号 ' + quotaModal.userId }}
          </p>

          <!-- 叠加基准：现有额度，充值在它之上累加 -->
          <div v-if="quotaModal.mode === 'single'" class="quota-base">
            <span class="quota-base-label">当前额度</span>
            <span class="quota-base-value">¥{{ quotaModal.baseYuan }}</span>
            <span v-if="quotaModal.sessionYuan > 0" class="quota-session">
              本次会话已追加 ¥{{ quotaModal.sessionYuan.toFixed(2) }}
            </span>
          </div>

          <label class="field">
            <span class="field-label">本次追加（元）</span>
            <input v-model="quotaModal.addYuan" class="input" type="number" min="0" step="0.01" placeholder="如 30" @keyup.enter="submitQuota" />
            <span class="tiny muted field-hint">
              <template v-if="quotaModalAddPoints > 0">
                追加后学生端额度约 <strong>{{ quotaModalNewPoints }}</strong> 积分（1 元 = {{ pointsPerYuan }} 积分）
              </template>
              <template v-else>学生端按积分显示，1 元 = {{ pointsPerYuan }} 积分</template>
            </span>
          </label>

          <label class="field">
            <span class="field-label">周限额（元，选填）</span>
            <input v-model="quotaModal.weeklyYuan" class="input" type="number" min="0" step="0.01" placeholder="留空保持原值" />
            <span v-if="weeklyModalPoints > 0" class="tiny muted field-hint">
              学生端显示为每 7 天 {{ weeklyModalPoints }} 积分
            </span>
          </label>

          <label class="field">
            <span class="field-label">备注（选填）</span>
            <input v-model="quotaModal.reason" class="input" type="text" placeholder="如：微信转账 30 元" />
          </label>

          <!-- 追加后的额度预览（单用户可见），让金额一目了然 -->
          <div v-if="quotaModal.mode === 'single' && quotaModalAddYuan > 0" class="quota-preview">
            ¥{{ quotaModal.baseYuan }} <span class="quota-op">+</span> ¥{{ quotaModalAddYuan.toFixed(2) }}
            <span class="quota-op">=</span> <strong>¥{{ quotaModalNewYuan }}</strong>
          </div>

          <div class="modal-note tiny muted">
            充值按<strong>追加</strong>计算，在现有额度上累加，不会覆盖原额度；可连续追加多笔。
            需要下调额度时使用该账号的「收回额度」。管理台与对账一律用元，学生端只看到积分。
          </div>

          <div v-if="quotaModal.error" class="alert alert-danger">{{ quotaModal.error }}</div>

          <div class="modal-actions">
            <button class="btn btn-ghost" @click="closeQuota">{{ quotaModal.sessionYuan > 0 ? '完成' : '取消' }}</button>
            <button class="btn btn-primary" :disabled="quotaModal.saving || quotaModalAddYuan <= 0" @click="submitQuota">
              {{ quotaModal.saving ? '提交中…' : '确认追加' }}
            </button>
          </div>
        </div>
      </div>
    </transition>

    <!-- 模型编辑弹窗 -->
    <ModelForm
      v-if="modelFormOpen"
      :model="editingModel"
      :sources="sources"
      :global-offpeak="offpeakDefaults"
      @close="modelFormOpen = false"
      @saved="loadModels"
    />

    <!-- 模型源编辑弹窗 -->
    <SourceForm
      v-if="sourceFormOpen"
      :source="editingSource"
      @close="sourceFormOpen = false"
      @saved="loadModels"
    />
  </div>
</template>

<script>
import AppNav from '@/components/AppNav.vue';
import Segmented from '@/components/Segmented.vue';
import UsageChart from '@/components/UsageChart.vue';
import ModelForm from '@/components/ModelForm.vue';
import SourceForm from '@/components/SourceForm.vue';

var SOURCE_LABELS = {
  chat: '对话', study: '学习', solve: '拍题', grade: '批改', vision_relay: '图片识别'
};

export default {
  name: 'AdminView',
  components: { AppNav, Segmented, UsageChart, ModelForm, SourceForm },
  data: function() {
    return {
      tab: 'overview',
      error: '',

      // ---- Cluss-Cloud 账号绑定（班管本机发起，见「账号绑定」面板）----
      cloudBind: { adminUsername: '', busy: false, code: '', error: '' },

      // 加载态：请求回来之前不要先摆出「没有匹配的学生 / 暂无流水」这种空态文案
      loading: true,
      usageLoading: true,

      // ---- 额度 ----
      dashboard: null,
      users: [],
      logs: [],
      keyword: '',
      classFilter: '',
      selected: [],
      quotaModal: {
        open: false, mode: 'single', userId: '', targetName: '',
        baseYuan: '0.00', addYuan: '', weeklyYuan: '', reason: '',
        sessionYuan: 0, saving: false, error: ''
      },

      // ---- 模型 ----
      models: [],
      // 模型源（迁移 022）：地址/密钥可沉到源上供多个模型共享；源是可选的
      sources: [],
      // 全局峰谷默认（模型表单用它预填「留空 = 全局」的提示）
      offpeakDefaults: null,
      // 计费基准（默认模型的三档单价），来自 GET /admin/models 的 base_model
      baseModel: null,
      modelFormOpen: false,
      editingModel: null,
      sourceFormOpen: false,
      editingSource: null,

      // ---- 峰谷 ----
      offpeak: {
        enabled: false,
        peaks: [
          { start: '09:00', end: '12:00' },
          { start: '14:00', end: '18:00' }
        ],
        discount: 5, active_now: false, peak_now: false
      },
      savingOffpeak: false,

      // ---- 预算与异常检出 ----
      budgetYuan: '',
      anomalies: { top: [], spikes: [] },

      // ---- 总览看板 ----
      trendItems: [],

      // ---- 本班名册（ClassIntra 联动）----
      roster: {
        loading: true,
        busy: false,
        status: null,
        // 当前管理员不是班级账号（如开发账号）时，后端会说明原因，这里转成一句提示
        unavailable: ''
      },

      // ---- 视觉 ----
      vision: {
        enabled: true, relay_model_id: '', max_images: 4,
        image_max_edge: 1568, image_quality: 80,
        shrink_enabled: true, sharp_available: true
      },
      relayCandidates: [],
      savingVision: false,

      // ---- 用量 ----
      usageDays: '7',
      usageGroup: 'user',
      usageItems: [],
      usageTotals: {},
      usageRecords: [],
      usageRecordTotal: 0
    };
  },
  computed: {
    // 当前登录的学号：账号绑定面板要显示「这台电脑上的我是谁」。
    // 直接读本地存储，和 store/auth 保持同一份来源，但不去动那个模块
    meUserId: function() {
      try {
        var u = JSON.parse(localStorage.getItem('cluss_user') || 'null');
        return u && (u.user_id || u.id) ? (u.user_id || u.id) : '';
      } catch (e) {
        return '';
      }
    },
    // 只有 node 模式才谈得上向云端发起绑定（standalone/relay 没有中继可打）
    isNodeMode: function() {
      return !!(this.dashboard && this.dashboard.mode === 'node');
    },
    tabOptions: function() {
      return [
        { id: 'overview', label: '总览' },
        { id: 'quota', label: '额度分配' },
        { id: 'models', label: '模型与单价' },
        { id: 'vision', label: '视觉配置' },
        { id: 'usage', label: '用量统计' }
      ];
    },
    instanceLabel: function() {
      if (!this.dashboard) return '';
      return this.dashboard.instance_id + ' · ' + this.dashboard.mode + ' 模式';
    },
    // 换算率由服务端下发（自部署可配），前端不写死，避免两边不一致
    pointsPerYuan: function() {
      return Number((this.dashboard && this.dashboard.points_per_yuan) || 100);
    },
    quotaModalAddYuan: function() {
      var y = Number(this.quotaModal.addYuan);
      return isFinite(y) && y > 0 ? y : 0;
    },
    quotaModalAddPoints: function() {
      return Math.round(this.quotaModalAddYuan * this.pointsPerYuan);
    },
    // 追加后额度 = 现有额度 + 本次追加（叠加式）
    quotaModalNewYuan: function() {
      var base = Number(this.quotaModal.baseYuan) || 0;
      return (base + this.quotaModalAddYuan).toFixed(2);
    },
    quotaModalNewPoints: function() {
      var base = Number(this.quotaModal.baseYuan) || 0;
      return Math.round((base + this.quotaModalAddYuan) * this.pointsPerYuan);
    },
    weeklyModalPoints: function() {
      var y = Number(this.quotaModal.weeklyYuan);
      if (!isFinite(y) || y <= 0) return 0;
      return Math.round(y * this.pointsPerYuan);
    },
    classes: function() {
      return (this.dashboard && this.dashboard.by_class) || [];
    },
    filteredUsers: function() {
      var self = this;
      if (!this.classFilter) return this.users;
      return this.users.filter(function(u) { return (u.class_no || '--') === self.classFilter; });
    },
    allSelected: function() {
      return this.filteredUsers.length > 0 && this.selected.length === this.filteredUsers.length;
    },
    dayOptions: function() {
      return [
        { id: '7', label: '近 7 天' },
        { id: '30', label: '近 30 天' },
        { id: '90', label: '近 90 天' }
      ];
    },
    usageGroupOptions: function() {
      return [
        { id: 'user', label: '按学生' },
        { id: 'model', label: '按模型' },
        { id: 'source', label: '按类型' },
        { id: 'day', label: '按天' }
      ];
    },
    usageGroupTitle: function() {
      return { user: '账号明细', model: '模型明细', source: '类型明细', day: '每日明细' }[this.usageGroup] || '明细';
    }
  },
  watch: {
    tab: function(val) {
      // 切到某个标签才加载它的数据：避免进管理台就把三个大查询全跑一遍
      if (val === 'overview') this.loadOverview();
      else if (val === 'quota') this.loadQuotaTab();
      else if (val === 'models') { this.loadModels(); this.loadOffpeak(); }
      else if (val === 'vision') this.loadVision();
      else if (val === 'usage') { this.loadUsage(); this.loadAnomalies(); }
    },
    usageDays: function() { this.loadUsage(); },
    usageGroup: function() { this.loadUsageSummary(); }
  },
  mounted: function() {
    this.loadOverview();
  },
  methods: {
    sourceLabel: function(s) { return SOURCE_LABELS[s] || s || '对话'; },

    formatTokens: function(n) {
      var v = Number(n || 0);
      if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
      return String(v);
    },

    // ---------- 额度 ----------
    loadQuotaTab: function() {
      var self = this;
      this.error = '';
      this.loading = true;
      // 三个请求各自已 catch，不会 reject；都收尾后再关掉加载态，
      // 否则请求回来前会先闪一句「没有匹配的学生」
      return Promise.all([
        this.loadDashboard(), this.loadUsers(), this.loadLogs()
      ]).then(function() {
        self.loading = false;
      });
    },

    // ---------- 总览看板 ----------
    loadOverview: function() {
      return Promise.all([this.loadDashboard(), this.loadTrend(), this.loadRoster()]).then(function() {});
    },

    // ---------- 本班名册（ClassIntra 联动） ----------
    loadRoster: function() {
      var self = this;
      self.roster.loading = true;
      return this.$http.get('/admin/class-roster').then(function(r) {
        if (r.data.code === 200) {
          self.roster.status = r.data.data;
          self.roster.unavailable = '';
        } else {
          // 400 = 当前管理员学号里没有班级信息（开发账号），这是正常情况不是故障
          self.roster.status = null;
          self.roster.unavailable = r.data.message || '当前账号无法管理名册';
        }
      }).catch(function(err) {
        self.roster.status = null;
        self.roster.unavailable = err.message || '名册状态读取失败';
      }).then(function() {
        self.roster.loading = false;
      });
    },

    // 拉名册并纳入本班：幂等、只增不删，随时可以按
    // 生成 Cluss-Cloud 账号绑定确认码。
    // 失败原因原样透出（403「只有班管可以发起」/ 404「中继不支持」都要看得懂），
    // 这类错误都是「配置或身份对不上」，编一个友好提示只会把人带偏。
    requestCloudBind: function() {
      var self = this;
      self.cloudBind.busy = true;
      self.cloudBind.error = '';
      self.cloudBind.code = '';
      this.$http.post('/admin/cloud/bind-request', {
        admin_username: self.cloudBind.adminUsername
      }).then(function(r) {
        self.cloudBind.code = (r.data && r.data.bind_code) || '';
        if (!self.cloudBind.code) self.cloudBind.error = (r.data && r.data.message) || '中继没有返回确认码';
      }).catch(function(err) {
        var d = (err.response && err.response.data) || {};
        self.cloudBind.error = d.message || err.message || '生成失败';
      }).then(function() {
        self.cloudBind.busy = false;
      });
    },

    syncRoster: function() {
      var self = this;
      self.roster.busy = true;
      this.$http.post('/admin/class-roster/sync', {}).then(function(r) {
        if (r.data.code === 200) {
          var a = r.data.adopted || {};
          self.$store.dispatch('toast', {
            message: '本班 ' + r.data.roster_total + ' 人：新增 ' + (a.added || 0) + '、更新 ' + (a.updated || 0),
            type: 'success'
          });
        } else {
          self.$store.dispatch('toast', { message: r.data.message || '同步失败', type: 'error' });
        }
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '同步失败', type: 'error' });
      }).then(function() {
        self.roster.busy = false;
        self.loadRoster();
      });
    },

    // 清理非本班账号：破坏性（连会话/额度/流水一起删），先过一遍全局确认弹窗
    pruneRoster: function() {
      var self = this;
      var st = this.roster.status;
      var n = st ? st.foreign_count : 0;
      this.$store.dispatch('confirm', {
        title: '清理非本班账号',
        message: '将删除 ' + n + ' 个非本班账号，连同它们的会话、额度与流水一并清除，不可恢复。确定继续吗？',
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.roster.busy = true;
        self.$http.post('/admin/class-roster/prune', { confirm: true }).then(function(r) {
          if (r.data.code === 200) {
            var removed = (r.data.removed && r.data.removed.count) || 0;
            self.$store.dispatch('toast', {
              message: removed ? '已清理 ' + removed + ' 个非本班账号' : '没有需要清理的账号',
              type: 'success'
            });
          } else {
            self.$store.dispatch('toast', { message: r.data.message || '清理失败', type: 'error' });
          }
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '清理失败', type: 'error' });
        }).then(function() {
          self.roster.busy = false;
          self.loadRoster();
        });
      });
    },

    loadTrend: function() {
      var self = this;
      return this.$http.get('/admin/usage/summary', {
        params: { days: 14, group_by: 'day' }
      }).then(function(r) {
        if (r.data.code === 200) self.trendItems = r.data.data.items || [];
      }).catch(function() {});
    },

    loadDashboard: function() {
      var self = this;
      return this.$http.get('/admin/dashboard').then(function(r) {
        if (r.data.code === 200) {
          self.dashboard = r.data.data;
          // 预算输入框跟随服务端值（0 = 未设），避免编辑中的旧值被刷新覆盖
          self.budgetYuan = (self.dashboard.month && self.dashboard.month.threshold_yuan) || '';
        }
      }).catch(function(err) {
        self.error = err.message || '总览加载失败';
      });
    },

    // ---------- 预算 ----------
    saveBudget: function() {
      var self = this;
      var n = Number(this.budgetYuan);
      if (this.budgetYuan !== '' && this.budgetYuan !== null && (!isFinite(n) || n < 0)) {
        this.$store.dispatch('toast', { message: '预算必须是不小于 0 的数字（留空或 0 = 不提醒）', type: 'error' });
        return;
      }
      var val = (this.budgetYuan === '' || this.budgetYuan === null) ? 0 : n;
      this.$http.put('/admin/budget', { threshold_yuan: val }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: val > 0 ? '预算已设为 ¥' + val : '预算提醒已关闭', type: 'success' });
        self.loadDashboard();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '保存失败', type: 'error' });
      });
    },

    // ---------- 异常检出 ----------
    loadAnomalies: function() {
      var self = this;
      return this.$http.get('/admin/usage/anomalies').then(function(r) {
        if (r.data.code === 200) {
          self.anomalies = {
            top: r.data.data.top7d || [],
            spikes: r.data.data.spikes || []
          };
        }
      }).catch(function() {});
    },

    loadUsers: function() {
      var self = this;
      return this.$http.get('/admin/users', { params: { keyword: this.keyword, limit: 500 } }).then(function(r) {
        if (r.data.code === 200) {
          self.users = r.data.data.users || [];
          self.selected = [];
        }
      }).catch(function(err) {
        self.error = err.message || '加载失败';
      });
    },

    loadLogs: function() {
      var self = this;
      return this.$http.get('/admin/logs', { params: { limit: 60 } }).then(function(r) {
        if (r.data.code === 200) self.logs = r.data.data.logs || [];
      }).catch(function() {});
    },

    toggleAll: function(e) {
      this.selected = e.target.checked
        ? this.filteredUsers.map(function(u) { return u.user_id; })
        : [];
    },

    openSingle: function(u) {
      this.quotaModal = {
        open: true, mode: 'single', userId: u.user_id,
        targetName: u.real_name || u.net_name,
        // 叠加基准 = 现有额度；周限额预填现有值，基础信息无需重填
        baseYuan: u.allocated_yuan || '0.00',
        addYuan: '',
        weeklyYuan: (u.weekly_quota_yuan && u.weekly_quota_yuan !== '0.00') ? u.weekly_quota_yuan : '',
        reason: '', sessionYuan: 0, saving: false, error: ''
      };
    },

    openBatch: function() {
      if (!this.selected.length) return;
      this.quotaModal = {
        open: true, mode: 'batch', userId: '', targetName: '',
        baseYuan: '0.00', addYuan: '', weeklyYuan: '', reason: '',
        sessionYuan: 0, saving: false, error: ''
      };
    },

    closeQuota: function() { this.quotaModal.open = false; },

    // 收回额度：把该账号额度清零（叠加模式下的「下调/纠错」入口）
    revokeQuota: function(u) {
      var self = this;
      var name = u.real_name || u.net_name || u.user_id;
      this.$store.dispatch('confirm', {
        title: '收回额度',
        message: '将把「' + name + '」的额度清零（当前 ¥' + u.allocated_yuan + '）。已消耗记录与流水保留，不可恢复。确定继续吗？',
        confirmText: '收回',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/admin/users/' + u.user_id + '/quota', {
          data: { reason: '管理员收回额度' }
        }).then(function(r) {
          if (r.data.code !== 200) {
            self.$store.dispatch('toast', { message: r.data.message || '收回失败', type: 'error' });
            return;
          }
          self.$store.dispatch('toast', { message: '已收回额度', type: 'success' });
          self.loadQuotaTab();
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '收回失败', type: 'error' });
        });
      });
    },

    submitQuota: function() {
      var self = this;
      var m = this.quotaModal;
      var addYuan = Number(m.addYuan);
      if (m.addYuan === '' || !isFinite(addYuan) || addYuan <= 0) {
        m.error = '请填写本次追加金额（需大于 0）';
        return;
      }

      m.saving = true;
      m.error = '';

      var weekly = m.weeklyYuan === '' ? undefined : Number(m.weeklyYuan);
      var req;
      if (m.mode === 'batch') {
        var items = this.selected.map(function(uid) {
          return { user_id: uid, quota_yuan: addYuan };
        });
        req = this.$http.post('/admin/users/quota/batch', { items: items, weekly_yuan: weekly, reason: m.reason });
      } else {
        req = this.$http.put('/admin/users/' + m.userId + '/quota', {
          quota_yuan: addYuan,
          weekly_yuan: weekly,
          reason: m.reason
        });
      }

      req.then(function(r) {
        if (r.data.code !== 200) { m.error = r.data.message || '充值失败'; return; }
        self.$store.dispatch('toast', { message: r.data.message || ('已追加 ¥' + addYuan.toFixed(2)), type: 'success' });
        // 叠加充值：弹窗不关、只清空金额，可继续追加下一笔，基础信息与选择全部保留
        m.sessionYuan = Number(m.sessionYuan || 0) + addYuan;
        if (r.data.data && r.data.data.allocated_yuan) m.baseYuan = r.data.data.allocated_yuan;
        m.addYuan = '';
        m.error = '';
        self.loadQuotaTab();
      }).catch(function(err) {
        m.error = err.message || '充值失败';
      }).then(function() {
        m.saving = false;
      });
    },

    // ---------- 模型 ----------
    loadModels: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/admin/models').then(function(r) {
        if (r.data.code === 200) {
          self.models = r.data.data.models || [];
          self.sources = r.data.data.sources || [];
          self.offpeakDefaults = r.data.data.offpeak_defaults || null;
          self.baseModel = r.data.data.base_model || null;
        }
      }).catch(function(err) {
        self.error = err.message || '模型列表加载失败';
      });
    },

    openModelForm: function(m) {
      this.editingModel = m;
      this.modelFormOpen = true;
    },

    // ---------- 模型源 ----------
    openSourceForm: function(s) {
      this.editingSource = s || null;
      this.sourceFormOpen = true;
    },

    deleteSource: function(s) {
      var self = this;
      var tip = s.model_count > 0
        ? ('「' + (s.label || s.id) + '」上还挂着 ' + s.model_count + ' 个模型，删除后它们会回退到各自的地址/密钥（可能为空而不可用）。确定删除？')
        : ('确定删除模型源「' + (s.label || s.id) + '」？');
      this.$store.dispatch('confirm', {
        message: tip,
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/admin/sources/' + s.id, { params: { force: 1 } }).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
          self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
          self.loadModels();
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
        });
      });
    },

    // ---------- 峰谷 ----------
    loadOffpeak: function() {
      var self = this;
      return this.$http.get('/admin/offpeak').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data || {};
        var pw = (d.peak_windows && d.peak_windows.length) ? d.peak_windows : [];
        self.offpeak = {
          enabled: !!d.enabled,
          peaks: [
            { start: (pw[0] && pw[0].start) || '09:00', end: (pw[0] && pw[0].end) || '12:00' },
            { start: (pw[1] && pw[1].start) || '', end: (pw[1] && pw[1].end) || '' }
          ],
          discount: d.discount || 5,
          active_now: !!d.active_now,
          peak_now: !!d.peak_now
        };
      }).catch(function() {});
    },

    saveOffpeak: function() {
      var self = this;
      var zhe = Number(this.offpeak.discount);
      if (!isFinite(zhe) || zhe < 0.1 || zhe > 9.9) {
        this.$store.dispatch('toast', { message: '折扣必须在 0.1 ~ 9.9 折之间', type: 'error' });
        return;
      }

      // 只上交填了内容的峰窗口；开启时至少要有一个（服务端同样校验）
      var windows = [];
      for (var i = 0; i < this.offpeak.peaks.length; i++) {
        var s = String(this.offpeak.peaks[i].start || '').trim();
        var e = String(this.offpeak.peaks[i].end || '').trim();
        if (s || e) windows.push({ start: s, end: e });
      }
      if (this.offpeak.enabled && !windows.length) {
        this.$store.dispatch('toast', { message: '启用峰谷折扣时至少填写一个峰时段', type: 'error' });
        return;
      }

      this.savingOffpeak = true;
      this.$http.put('/admin/offpeak', {
        enabled: this.offpeak.enabled,
        peak_windows: windows,
        discount: zhe
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: r.data.message || '已保存', type: 'success' });
        self.loadOffpeak();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '保存失败', type: 'error' });
      }).then(function() {
        self.savingOffpeak = false;
      });
    },

    // 限免徽标 / 流水时间：UTC ISO → 本地可读时间（统一走 utils/fmt-time）
    formatTime: function(iso) {
      return this.$fmtLocal(iso);
    },

    formatTimeShort: function(iso) {
      return this.$fmtLocal(iso, { short: true });
    },

    // 库存单价（微元/千 token）→ 元/百万 token 展示（2000 → 2，40 → 0.04）
    fmtPrice: function(micro) {
      var n = Number(micro || 0) / 1000;
      return Number(n.toFixed(3));
    },

    // 模型峰谷配置的一句话说明：把"留空即用全局"到底等于什么讲清楚，
    // 否则管理员看到一个"参与峰谷"的徽标，不知道它到底按哪个窗口在算
    offpeakModelTip: function(m) {
      var g = this.offpeakDefaults || {};
      function text(list) {
        return (list || []).map(function(x) { return x.start + '–' + x.end; }).join('、');
      }
      var own = text(m.offpeak_peak_windows);
      var globW = text(g.peak_windows);
      var d = Number(m.offpeak_discount) || 0;
      var parts = [
        own ? ('峰窗 ' + own) : ('峰窗用全局（' + (globW || '未配置') + '）'),
        d ? (d + ' 折') : ('折扣用全局（' + (g.discount || 5) + ' 折）')
      ];
      return parts.join('，');
    },

    setDefault: function(m) {
      var self = this;
      this.$http.post('/admin/models/' + m.id + '/set-default', {}).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
        self.$store.dispatch('toast', { message: '已设为默认模型', type: 'success' });
        self.loadModels();
      }).catch(function(err) {
        self.$store.dispatch('toast', { message: err.message || '操作失败', type: 'error' });
      });
    },

    deleteModel: function(m) {
      var self = this;
      this.$store.dispatch('confirm', {
        message: '确定删除模型「' + m.label + '」？若已被会话使用，将改为禁用而非删除。',
        confirmText: '删除',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.delete('/admin/models/' + m.id).then(function(r) {
          if (r.data.code !== 200) throw new Error(r.data.message || '删除失败');
          self.$store.dispatch('toast', { message: r.data.message, type: 'success' });
          self.loadModels();
        }).catch(function(err) {
          self.$store.dispatch('toast', { message: err.message || '删除失败', type: 'error' });
        });
      });
    },

    // ---------- 视觉 ----------
    loadVision: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/admin/vision').then(function(r) {
        if (r.data.code !== 200) return;
        var d = r.data.data;
        self.vision = {
          enabled: d.enabled,
          relay_model_id: d.relay_model_id || '',
          max_images: d.max_images,
          image_max_edge: d.image_max_edge,
          image_quality: d.image_quality,
          shrink_enabled: d.shrink_enabled,
          sharp_available: d.sharp_available
        };
        self.relayCandidates = d.relay_candidates || [];
      }).catch(function(err) {
        self.error = err.message || '视觉配置加载失败';
      });
    },

    saveVision: function() {
      var self = this;
      this.savingVision = true;
      this.error = '';
      this.$http.put('/admin/vision', {
        enabled: this.vision.enabled,
        relay_model_id: this.vision.relay_model_id,
        max_images: Number(this.vision.max_images),
        image_max_edge: Number(this.vision.image_max_edge),
        image_quality: Number(this.vision.image_quality),
        shrink_enabled: this.vision.shrink_enabled
      }).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: '配置已保存，即时生效', type: 'success' });
        self.loadVision();
      }).catch(function(err) {
        self.error = err.message || '保存失败';
      }).then(function() {
        self.savingVision = false;
      });
    },

    // ---------- 用量 ----------
    loadUsage: function() {
      var self = this;
      this.usageLoading = true;
      return Promise.all([
        this.loadUsageSummary(), this.loadUsageRecords()
      ]).then(function() {
        self.usageLoading = false;
      });
    },

    loadUsageSummary: function() {
      var self = this;
      return this.$http.get('/admin/usage/summary', {
        params: { days: this.usageDays, group_by: this.usageGroup }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.usageItems = r.data.data.items || [];
        self.usageTotals = r.data.data.totals || {};
      }).catch(function() {});
    },

    loadUsageRecords: function() {
      var self = this;
      return this.$http.get('/admin/usage/records', {
        params: { days: this.usageDays, limit: 50 }
      }).then(function(r) {
        if (r.data.code !== 200) return;
        self.usageRecords = r.data.data.items || [];
        self.usageRecordTotal = r.data.data.total || 0;
      }).catch(function() {});
    },

    usageLabelOf: function(item) {
      if (this.usageGroup === 'source') return SOURCE_LABELS[item.key] || item.key;
      if (this.usageGroup === 'user') {
        return (item.label || item.key) +
          (item.class_no ? '（' + item.class_no + '班）' : '') +
          (item.is_admin ? ' · 管理' : '');
      }
      return item.label || item.key;
    },

    // ---------- 导出 ----------
    download: function(url, filename) {
      var self = this;
      var token = this.$store.state.auth.token;
      fetch(url, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        credentials: 'same-origin'
      }).then(function(resp) {
        if (!resp.ok) throw new Error('导出失败');
        return resp.blob();
      }).then(function(blob) {
        var objUrl = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objUrl);
      }).catch(function() {
        self.$store.dispatch('toast', { message: '导出失败，请重试', type: 'error' });
      });
    },

    exportSnapshot: function() {
      this.download('/api/admin/snapshot', 'cluss-snapshot.csv');
    },

    exportUsage: function() {
      this.download('/api/admin/usage/export.csv?days=' + this.usageDays, 'cluss-usage.csv');
    }
  }
};
</script>

<style scoped>
.admin-page {
  display: flex;
  flex-direction: column;
  height: var(--app-height);
  /* 完全贴边：去掉固定留白，仅保留安全区边距（无刘海设备上为 0） */
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  gap: var(--gap-md);
}
html.no-flex-gap .admin-page > * + * {
  margin-top: var(--gap-md);
}






.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
  padding-bottom: var(--gap-md);
}
html.no-flex-gap .body > * + * {
  margin-top: var(--gap-md);
}






.tabs {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--gap-md);
  padding: 8px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}
html.no-flex-gap .tabs > * + * {
  margin-left: var(--gap-md);
}






.tabs-note {
  white-space: nowrap;
}

/* ---------- 指标卡 ---------- */
.metrics {
  display: grid;
  /* auto-fit：窄屏自动减列、宽屏自动铺满，避免固定 4 列在小屏被挤扁 */
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: var(--gap-md);
  flex-shrink: 0;
}

.metric {
  padding: 16px 18px;
  border-radius: var(--radius-lg);
}

/* 关键指标（本月消耗 + 预算）给一点视觉权重，便于一眼定位 */
.metric-primary .metric-value {
  color: var(--accent);
}

.metric-label {
  font-size: 12.5px;
  color: var(--text-secondary);
}

.metric-value {
  margin-top: 5px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

/* ---------- 面板 ---------- */
.panel {
  padding: 18px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--gap-md);
  margin-bottom: var(--gap-md);
}
html.no-flex-gap .panel-head > * + * {
  margin-left: var(--gap-md);
}






.panel-title {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.panel-sub {
  margin: 0;
  line-height: 1.5;
}

.panel-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  margin-top: var(--gap-md);
}
html.no-flex-gap .panel-actions > * + * {
  margin-left: 8px;
}






.panel-head .panel-actions {
  margin-top: 0;
}

.filters-row {
  display: flex;
  gap: 10px;
  margin-bottom: var(--gap-md);
}
html.no-flex-gap .filters-row > * + * {
  margin-left: 10px;
}






.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  flex-shrink: 0;
  flex-wrap: wrap;
}
html.no-flex-gap .filters > * + * {
  margin-left: 10px;
}






.filter-input {
  flex: 1;
}

.filter-select {
  max-width: 180px;
}

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

/* ---------- 表格 ---------- */
.table-wrap {
  overflow-x: auto;
  margin: 0 -4px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th {
  padding: 9px 11px;
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--ink-2);
  white-space: nowrap;
}

.table td {
  padding: 10px 11px;
  border-bottom: 1px solid var(--ink-1);
  white-space: nowrap;
}

@media (hover: hover) {
.table tbody tr:hover {
  background: var(--surface-1);
}
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.nowrap {
  white-space: nowrap;
}

.col-check {
  width: 38px;
}

.col-op {
  width: 132px;
  text-align: right;
  white-space: nowrap;
}

.col-op-wide {
  width: 200px;
  text-align: right;
}

/* .empty-cell 已提到 styles/global.css（表格空态，两处逐字相同） */

.text-danger {
  color: var(--danger);
}

.text-success {
  color: var(--success);
}

@media (hover: hover) {
.danger-text:hover {
  color: var(--danger);
  background: var(--danger-tint);
}
}

.model-cell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
html.no-flex-gap .model-cell > * + * {
  margin-top: 1px;
}






.model-name {
  font-weight: 500;
}

.addr-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 双栏 ---------- */
.bottom-grid,
.panels {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: var(--gap-md);
  flex-shrink: 0;
}

/* ---------- 本班名册（ClassIntra 联动） ---------- */
/* 这张卡一个人占满整行：要塞下「本班 / 联动 / 非本班」三行事实 + 两个按钮 + 一串学号 */
.roster-span {
  grid-column: 1 / -1;
}

.roster-ids {
  margin: 2px 0 0;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--ink-1);
  /* 学号串可能很长：折行比截断好 —— 班管要照着它核对名单 */
  word-break: break-all;
  line-height: 1.6;
}

.roster-actions {
  display: flex;
  align-items: center;
  margin-top: var(--gap-sm);
}
html.no-flex-gap .roster-actions > * + * {
  margin-left: var(--gap-sm);
}

.roster-btn-danger {
  color: var(--danger);
}

.roster-note {
  margin: var(--gap-sm) 0 0;
}

/* 账号绑定：确认码要一眼看清、方便照着敲，别缩在一行小字里 */
.bind-panel {
  margin-top: var(--gap);
}

.bind-panel .input-sm {
  max-width: 220px;
  padding: 6px 10px;
  font-size: .86rem;
}

.bind-code {
  margin-top: var(--gap-sm);
  padding: 12px 14px;
  border-radius: var(--radius-md, 12px);
  background: var(--accent-soft, rgba(47, 107, 221, .12));
}

.bind-code-value {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: .18em;
  margin-top: 2px;
}

.list-scroll {
  max-height: 260px;
  overflow-y: auto;
}

.row-line {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 2px;
  border-bottom: 1px solid var(--ink-1);
  font-size: 13px;
}
html.no-flex-gap .row-line > * + * {
  margin-left: 12px;
}






.line-key {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.log-row {
  padding: 9px 2px;
  border-bottom: 1px solid var(--ink-1);
}

.log-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}
html.no-flex-gap .log-main > * + * {
  margin-left: 12px;
}






.log-user {
  font-weight: 500;
}

.log-amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.log-meta {
  margin-top: 1px;
}

/* ---------- 视觉配置 ---------- */
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

.field-note {
  display: block;
  margin-top: 4px;
}

.row-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap-md);
}

.panel code {
  padding: 1px 5px;
  border-radius: var(--radius-2xs);
  background: var(--ink-2);
  font-size: 11.5px;
}

/* ---------- 弹窗 ---------- */
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
  width: 100%;
  max-width: 420px;
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
}

.modal-note {
  margin: 4px 0 var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--ink-1);
}

/* 叠加充值：当前额度基准条 */
.quota-base {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
}
.quota-base-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.quota-base-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--accent);
}
.quota-session {
  margin-left: auto;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

/* 追加后的额度预览 */
.quota-preview {
  margin: 0 0 var(--gap-md);
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--success-soft);
  color: var(--text-primary);
  font-size: 15px;
  text-align: center;
}
.quota-preview strong {
  color: var(--success);
  font-size: 17px;
}
.quota-op {
  margin: 0 6px;
  color: var(--text-tertiary);
}

.op-revoke {
  margin-left: 6px;
  color: var(--danger);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: var(--gap-md);
}
html.no-flex-gap .modal-actions > * + * {
  margin-left: 10px;
}






@media (max-width: 1000px) {
  .bottom-grid,
  .panels {
    grid-template-columns: 1fr;
  }
}

/* 小屏：压缩指标/面板留白，一屏容纳更多信息；操作区允许换行不裁切 */
@media (max-width: 640px) {
  .metric {
    padding: 12px 14px;
  }
  .metric-value {
    font-size: 20px;
  }
  .panel {
    padding: 14px;
  }
  .filters-row,
  .panel-head,
  .panel-actions {
    flex-wrap: wrap;
  }
  .panel-actions {
    margin-top: 8px;
  }
  .col-op {
    width: auto;
  }
}

@media (max-width: 700px) {
  .row-3 {
    grid-template-columns: 1fr;
    gap: 0;
  }

  .tabs-note {
    display: none;
  }
}

/* ---------- 本月消耗卡片 ---------- */
.metric.glass.metric-alert {
  border-color: var(--danger);
}

/* 峰谷卡片：值的位置放的是状态徽标而非大数字，字号收一档 */
.metric-value-sub {
  font-size: 16px;
}

.metric-foot {
  margin-top: 4px;
  line-height: 1.4;
}

/* 管理员徽标：管理员（含班管本人）现在也在额度表与消耗榜里，
   没有标记就分不清「这一行是班管自己」还是「这一行是学生」 */
.admin-badge {
  margin-left: 6px;
  vertical-align: middle;
}

.budget-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
html.no-flex-gap .budget-row > * + * {
  margin-left: 6px;
}






.budget-input {
  width: 76px;
  padding: 3px 6px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-2xs);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-primary);
  outline: none;
}

/* ---------- 异常检出 ---------- */
.anomaly-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gap-md);
}
html.no-flex-gap .anomaly-grid > * + * {
  margin-top: var(--gap-md);
}

.anomaly-title {
  margin: 0 0 8px;
  font-weight: 600;
}

@media (max-width: 900px) {
  .anomaly-grid {
    grid-template-columns: 1fr;
  }
}
</style>