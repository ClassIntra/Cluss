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
            <!-- 组网之后这个数字包含别的班。不标出来管理员会以为都是本机的 -->
            <div v-if="dashboard && dashboard.totals.remote_users" class="tiny muted metric-foot">
              其中 {{ dashboard.totals.remote_classes }} 个接入班共 {{ dashboard.totals.remote_users }} 人
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

        <!-- 云端接入状态：接上以后，管理员不用登云端网页也能确认「我在哪、连上没有、
             云端的配置我装到哪一版了」。以前这些字段只喂给 /api/health，
             管理台一个字都看不到，出问题只能翻服务器日志。 -->
        <section class="panel glass relay-panel">
          <h2 class="panel-title">
            云端接入
            <span class="relay-dot" :class="relayTone" :title="relayToneText"></span>
          </h2>
          <div v-if="!isNodeMode" class="tiny muted">
            本机当前是 {{ dashboard ? dashboard.mode : '—' }} 模式，未接入 Cluss-Cloud。
            接入方法：把云端注册时给的 <span class="mono">.env</span> 整块粘到
            <span class="mono">server/.env</span>（含 <span class="mono">CLUSS_MODE=node</span>、
            <span class="mono">CLUSS_RELAY_URL</span>、<span class="mono">CLUSS_RELAY_SECRET</span>、
            <span class="mono">CLUSS_ORG_ID</span>），重启服务即可。
          </div>
          <template v-else>
            <div class="row-line">
              <span class="line-key">学校编号</span>
              <span class="line-amount mono">{{ relay.org_id || '未配置' }}</span>
            </div>
            <div class="row-line">
              <span class="line-key">本机实例</span>
              <span class="line-amount mono">{{ relay.instance_id || '—' }}</span>
            </div>
            <div class="row-line">
              <span class="line-key">云端地址</span>
              <span class="line-amount mono tiny">{{ relay.relay_url || '—' }}</span>
            </div>
            <div class="row-line">
              <span class="line-key">连接</span>
              <span class="line-amount">{{ relayToneText }}</span>
            </div>
            <div class="row-line">
              <span class="line-key">写入权</span>
              <span class="line-amount">
                <template v-if="isSeatAdmin">管理员席位 · 本班改动会同步全校</template>
                <template v-else-if="relay.seat_instance">
                  <span class="muted">只读 · 管理员席位在 {{ relay.seat_instance }} 班</span>
                </template>
                <template v-else><span class="muted">只读 · 本校尚未认领管理员席位</span></template>
              </span>
            </div>
            <div v-if="isSeatAdmin && (relay.pending_allocations > 0 || relay.pending_policy)" class="row-line">
              <span class="line-key">待同步</span>
              <span class="line-amount warn-text">
                额度 {{ relay.pending_allocations }} 条<template v-if="relay.pending_policy"> · 模型配置</template>
                （正推往云端，失败会在下次轮询重试）
              </span>
            </div>
            <div v-if="relay.last_push_alloc_error || relay.last_push_policy_error" class="row-line">
              <span class="line-key">同步提示</span>
              <span class="line-amount danger-text">{{ relay.last_push_policy_error || relay.last_push_alloc_error }}</span>
            </div>
            <div class="row-line">
              <span class="line-key">额度策略</span>
              <span class="line-amount">
                云端 v{{ relay.assign_version }} · 本机 v{{ relay.local_assign_version }}
                <span v-if="relay.assign_pending" class="relay-lag">待同步</span>
              </span>
            </div>
            <div class="row-line">
              <span class="line-key">模型配置</span>
              <span class="line-amount">
                云端 v{{ relay.model_version }} · 本机 v{{ relay.local_model_version }}
                <span v-if="relay.model_pending" class="relay-lag">待同步</span>
              </span>
            </div>
            <div class="row-line">
              <span class="line-key">用量回传</span>
              <span class="line-amount">
                已传 {{ relay.reported_total }} 条<template v-if="relay.pending_usage"> · 待传 {{ relay.pending_usage }}</template>
              </span>
            </div>
            <div v-if="relay.last_push_at" class="row-line">
              <span class="line-key">最后回传</span>
              <span class="line-amount muted">{{ relay.last_push_at }}</span>
            </div>
            <div v-if="relay.clock_skew_ms !== null && relay.clock_skew_ms !== undefined" class="row-line">
              <span class="line-key">时钟偏差</span>
              <span class="line-amount" :class="Math.abs(relay.clock_skew_ms) > 60000 ? 'warn-text' : 'muted'">
                {{ (relay.clock_skew_ms / 1000).toFixed(1) }} 秒<template
                  v-if="Math.abs(relay.clock_skew_ms) > 60000">（过大会影响用量跨月统计）</template>
              </span>
            </div>
            <p v-if="relay.last_error" class="tiny" style="color: var(--danger-text, #d64545); margin: 8px 0 0;">
              最近错误：{{ relay.last_error }}
            </p>
          </template>
        </section>
      </template>

<!-- ================= 额度分配 ================= -->
        <!-- 列表含管理员：班管本人既管钱也是要用的学生，滤掉他就找不到自己那一行、
             连给自己充值都做不到（充值按钮挂在每行的操作列上）。管理员行加徽标区分。 -->
        <template v-else-if="tab === 'mesh'">
        <section class="metrics">
          <div class="metric glass">
            <div class="metric-label">本机角色</div>
            <div class="metric-value metric-value-sub">
              <span v-if="meshStatus && meshStatus.is_hub" class="badge badge-success">组网中枢</span>
              <span v-else class="badge">未组网</span>
            </div>
            <div class="tiny muted metric-foot">{{ (meshStatus && meshStatus.instance_id) || '—' }}</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">接入密钥</div>
            <div class="metric-value metric-value-sub">
              <span
                class="badge"
                :class="meshStatus && meshStatus.secret_configured ? 'badge-success' : 'badge-danger'"
              >{{ meshStatus && meshStatus.secret_configured ? '已配置' : '未配置' }}</span>
            </div>
            <!-- 排障第一件事就是它：密钥不一致的表现是节点 403，日志里只一句「校验失败」 -->
            <div class="tiny muted metric-foot">节点要填同一个密钥</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">已接入班级</div>
            <div class="metric-value">{{ meshStatus ? meshStatus.nodes.length : 0 }}</div>
            <div class="tiny muted metric-foot">名册镜像 {{ meshStatus ? meshStatus.roster_count : 0 }} 人</div>
          </div>
          <div class="metric glass">
            <div class="metric-label">管理员席位</div>
            <div class="metric-value metric-value-sub">
              <span class="badge badge-accent">{{ (meshStatus && meshStatus.seat_instance) || '—' }}</span>
            </div>
            <div class="tiny muted metric-foot">
              {{ meshStatus && meshStatus.seat_is_self ? '在本机，可直接改全校配置' : '在别的班，本机只读' }}
            </div>
          </div>
        </section>

        <section class="panel glass">
          <h2 class="panel-title">已接入的班级</h2>
          <p class="panel-sub tiny muted">
            节点接入后默认跟随中枢。只想让它少拿几个模型，用「模型与单价」里的「下发」列筛；
            要它完全自己维护模型，才关掉下面的跟随开关。
          </p>
          <div v-if="meshLoading" class="tiny muted">读取中…</div>
          <div v-else-if="!meshStatus || !meshStatus.nodes.length" class="tiny muted">
            还没有班级连上来。节点侧需要三件事：<code>CLUSS_MODE=node</code>、
            <code>CLUSS_RELAY_URL</code> 指向本机、接入密钥与本机一致。
          </div>
          <div v-else class="mesh-nodes">
            <div v-for="n in meshStatus.nodes" :key="n.instance_id" class="mesh-node">
              <div class="mesh-node-head">
                <span class="mesh-node-id">{{ n.instance_id }}</span>
                <span class="badge" :class="nodeOnline(n) ? 'badge-success' : 'badge-danger'">
                  {{ nodeOnline(n) ? '在线' : '离线' }}
                </span>
                <span v-if="meshStatus.seat_instance === n.instance_id" class="badge badge-accent">管理员席位</span>
              </div>
              <div class="tiny muted mesh-node-meta">
                心跳 {{ lastSeenText(n) }} · 版本 {{ n.node_version || '未知' }} ·
                额度 v{{ n.last_assign_version }}/v{{ meshStatus.assign_version }} ·
                配置 v{{ n.last_model_version }}/v{{ meshStatus.model_version }}
                <!-- 「中枢有新版但它还没拉」是管理员唯一需要盯的异常：其余都由节点自己完成。
                     成对显示（节点/中枢）而不是只说「有新版本」——管理员要能一眼看出差几版、
                     是刚改的还是卡住了。 -->
                <span v-if="meshStatus.assign_version > n.last_assign_version" class="badge">额度待同步</span>
                <span v-if="meshStatus.model_version > n.last_model_version" class="badge">配置待同步</span>
                <!-- 模型是否跟随中枢：关掉的班会保留自己的渠道/Key/单价，
                     额度与名单照常跟随。放在状态行里，管理员一眼能看出「这个班没跟」是
                     有意为之还是卡住了 -->
                <!-- 模型同步档位（迁移 033 三态）：跟随 / 本班自选（可改不回传）/ 不同步。
                     三档的差别是「能不能改」和「改了去哪」，光看「跟没跟」看不出中间那档 -->
                <span class="badge" :class="n.model_sync === 1 ? '' : 'badge-accent'">
                  {{ nodeModelSyncLabel(n.model_sync) }}
                </span>
              </div>
              <div class="mesh-node-actions">
                <button v-if="meshStatus.seat_instance !== n.instance_id" class="btn btn-sm btn-ghost" @click="setSeat(n.instance_id)">设为管理员班</button>
                <select
                  class="input mesh-node-select"
                  :value="String(n.model_sync)"
                  @change="onNodeModelSyncChange(n, $event)"
                >
                  <option value="1">跟随中枢模型</option>
                  <option value="2">本班自选（可改·不回传）</option>
                  <option value="0">完全不同步</option>
                </select>
              </div>
            </div>
            <div v-if="!meshStatus.seat_is_self" class="mesh-node-actions">
              <button class="btn btn-sm btn-ghost" @click="setSeat('')">把席位收回本机</button>
            </div>
          </div>
        </section>
      </template>

      <template v-else-if="tab === 'quota'">
          <section class="panel glass">
            <div class="panel-head">
              <div>
                <h2 class="panel-title">额度分配</h2>
                <p class="panel-sub tiny muted">充值按「追加」计算，在现有额度上累加，永不覆盖。带「管理」徽标的是管理员账号（含班管本人）——他们同样在这张表里<template v-if="rosterLine">。{{ rosterLine }}</template></p>
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
                  <td>
                    {{ u.class_no ? u.class_no + ' 班' : '--' }}
                    <!-- 「外班」是管理员最需要看清的一列：这批学生不在本机账本里，
                         充的钱要同步回他自己的班。hover 说明里带上来源节点，
                         方便核对「这个学生到底是哪台机器报上来的」。 -->
                    <span
                      v-if="u.remote"
                      class="badge badge-remote"
                      :title="'本班没有这个学生——余额来自中枢账本，充值会同步到他所在的班' + (u.instance_id ? '（' + u.instance_id + '）' : '')"
                    >外班</span>
                  </td>
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
              <!-- 下发范围：一句话说清「哪些会到各班、几个班在跟」。
                   没有这一句时，管理员只能靠「班里看不到那个模型」去倒推 ——
                   而看不到的原因既可能是没下发，也可能是那个班改成了自选模型。 -->
              <p class="panel-sub tiny muted sync-scope-line" v-if="showSyncColumn && syncScope">
                <strong>下发范围</strong>：
                {{ syncScope.synced_models }} / {{ syncScope.models }} 个模型、
                {{ syncScope.synced_sources }} / {{ syncScope.sources }} 个模型源会发到各班。
                <template v-if="syncScope.nodes_following">全校 {{ syncScope.nodes_following }} 个班跟随中枢。</template>
                <template v-if="syncScope.nodes_total > syncScope.nodes_following">另有 {{ syncScope.nodes_total - syncScope.nodes_following }} 个班完全断开了模型同步，收不到这些配置。</template>
              </p>
            </div>
            <div class="panel-actions">
              <button
                v-if="modelLocalOnly && localChangeTotal"
                class="btn btn-sm btn-ghost"
                title="把所有「本班改过」的模型与源整行恢复成中枢版本（本班自建的条目不受影响）"
                @click="followHubAll"
              >全部恢复跟随中枢（{{ localChangeTotal }}）</button>
              <button class="btn btn-sm btn-ghost" @click="loadModels">刷新</button>
              <button class="btn btn-sm btn-primary" @click="openModelForm(null)" :disabled="modelReadOnly">新增模型</button>
            </div>
          </div>

          <div v-if="modelWritesToSchool" class="alert alert-info model-ro-notice">
            本班是本校管理员席位：在这里的改动会自动同步到全校所有班。改价等于给全校调价，请慎重。
          </div>
          <div v-else-if="modelReadOnly" class="alert alert-info model-ro-notice">
            {{ modelReadOnlyReason }}
          </div>
          <!-- 「本班自选 / 不同步」两档：可写，但必须说清改动只在本机生效。
               尤其是「与中枢同名的模型会被下次下发覆盖」这条 —— 不说的话，
               管理员改完发现自动回滚，会以为保存失败。 -->
          <div v-else-if="modelLocalOnly" class="alert alert-info model-ro-notice">
            {{ modelLocalOnlyHint }}
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
                  <th v-if="showSyncColumn" class="col-sync" title="关掉后只留在本机，不发到各班">下发</th>
                  <th class="col-op-wide">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in models" :key="m.id">
                  <td>
                    <div class="model-cell">
                      <span class="model-name">{{ m.label }}</span>
                      <span class="tiny muted mono">{{ m.id }}</span>
                      <!-- 「本班自选 / 不同步」档下才需要区分来源：跟随档里全是中枢下发的，
                           标出来只是噪音。迁移 034 起是**逐字段**跟随，所以徽标要说清
                           「哪几项偏离中枢」—— 这决定了中枢下次调价会不会覆盖它。 -->
                      <span
                        v-if="modelLocalOnly && m.local_change_count"
                        class="badge badge-warning"
                        :title="'本班改过这些字段，中枢的后续更新不会覆盖它们：' + localFieldNames(m) + '。其余字段仍跟随中枢；要整行回到中枢版本，点操作列的「恢复跟随」'"
                      >本班改过 {{ m.local_change_count }} 项</span>
                      <span
                        v-else-if="modelLocalOnly && m.origin === 'hub'"
                        class="badge"
                        title="整行跟随中枢：中枢改单价、倍率、Key 都会自动下发到本班"
                      >中枢下发</span>
                      <!-- 本班自建：中枢从来没有同名配置，既不会被下发覆盖，也
                           不会被下发删掉。「本班改过」「中枢下发」两个分支都轮不到它
                           —— 少了这一条，管理员新增完模型后看到的是一行裸配置，
                           无从判断它和中枢是什么关系。 -->
                      <span
                        v-else-if="modelLocalOnly && !m.has_hub_base"
                        class="badge badge-accent"
                        title="本班自建：中枢没有同名配置，永远不会被中枢下发改动或删除。它没有「中枢版本」可回退，所以没有「恢复跟随」这项操作；要去掉请直接删除"
                      >本班自建</span>
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
                  <td v-if="showSyncColumn" class="col-sync">
                    <ToggleSwitch
                      :checked="isModelSynced(m)"
                      :disabled="modelReadOnly || isSourceSyncOff(m)"
                      :label="'下发「' + m.label + '」到各班'"
                      @change="setModelSync(m, $event)"
                    />
                    <span
                      v-if="isSourceSyncOff(m)"
                      class="tiny muted sync-hint"
                      title="它挂的模型源已停止下发，模型会跟着不发"
                    >随源</span>
                  </td>
                  <td class="col-op-wide">
                    <button class="btn btn-sm btn-ghost" @click="openModelForm(m)" :disabled="modelReadOnly">编辑</button>
                    <!-- 恢复跟随：只在「本班改过」时出现。它是字段级合并的必需出口 ——
                         否则改错一个单价就再也收不到中枢对这个字段的调整。 -->
                    <button
                      v-if="modelLocalOnly && m.local_change_count"
                      class="btn btn-sm btn-ghost"
                      title="整行按中枢当前版本刷新：本班对这一条的修改会被覆盖"
                      @click="followHubModel(m)"
                    >恢复跟随</button>
                    <button
                      v-if="!m.is_default && m.enabled"
                      class="btn btn-sm btn-ghost"
                      @click="setDefault(m)"
                      :disabled="modelReadOnly"
                    >设默认</button>
                    <button class="btn btn-sm btn-ghost danger-text" @click="deleteModel(m)" :disabled="modelReadOnly">删除</button>
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
              <button class="btn btn-sm btn-primary" @click="openSourceForm(null)" :disabled="modelReadOnly">新增模型源</button>
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
                  <th v-if="showSyncColumn" class="col-sync" title="关掉后这个源及它挂的模型都不发到各班">下发</th>
                  <th class="col-op-wide">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in sources" :key="s.id">
                  <td>
                    <div class="model-cell">
                      <span class="model-name">{{ s.label || s.id }}</span>
                      <span class="tiny muted mono">{{ s.id }}</span>
                      <!-- 与模型行同一套语义（迁移 034）：源上的地址/Key 也能逐字段跟随 -->
                      <span
                        v-if="modelLocalOnly && s.local_change_count"
                        class="badge badge-warning"
                        :title="'本班改过这些字段，中枢的后续更新不会覆盖它们：' + localFieldNames(s) + '。其余字段（含地址与 Key）仍跟随中枢'"
                      >本班改过 {{ s.local_change_count }} 项</span>
                      <span
                        v-else-if="modelLocalOnly && s.origin === 'hub'"
                        class="badge"
                        title="整行跟随中枢：中枢换地址、换 Key 都会自动下发到本班"
                      >中枢下发</span>
                      <span
                        v-else-if="modelLocalOnly && !s.has_hub_base"
                        class="badge badge-accent"
                        title="本班自建：中枢没有同名配置，永远不会被中枢下发改动或删除。它没有「中枢版本」可回退，所以没有「恢复跟随」这项操作；要去掉请直接删除"
                      >本班自建</span>
                    </div>
                  </td>
                  <td class="tiny muted addr-cell" :title="s.api_url">{{ s.api_url || '未配置' }}</td>
                  <td class="num">{{ s.model_count }}</td>
                  <td>
                    <span v-if="!s.enabled" class="badge badge-danger">已停用</span>
                    <span v-else-if="!s.has_api_key" class="badge badge-danger">缺 Key</span>
                    <span v-else class="badge badge-success">可用</span>
                  </td>
                  <td v-if="showSyncColumn" class="col-sync">
                    <ToggleSwitch
                      :checked="s.sync_enabled !== 0"
                      :disabled="modelReadOnly"
                      :label="'下发模型源「' + (s.label || s.id) + '」到各班'"
                      @change="setSourceSync(s, $event)"
                    />
                  </td>
                  <td class="col-op-wide">
                    <button class="btn btn-sm btn-ghost" @click="openSourceForm(s)" :disabled="modelReadOnly">编辑</button>
                    <button
                      v-if="modelLocalOnly && s.local_change_count"
                      class="btn btn-sm btn-ghost"
                      title="整行按中枢当前版本刷新：本班对这个源的修改会被覆盖"
                      @click="followHubSource(s)"
                    >恢复跟随</button>
                    <button class="btn btn-sm btn-ghost danger-text" @click="deleteSource(s)" :disabled="modelReadOnly">删除</button>
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

      <!-- ================= 联网搜索 ================= -->
      <template v-else-if="tab === 'search'">
        <section class="panel glass">
          <h2 class="panel-title">联网搜索</h2>
          <p class="panel-sub tiny muted">
            开启后，AI 遇到不确定或需要最新信息的问题（天气、新闻、价格、赛事、版本号等）
            会自己调用搜索工具查证，并在回答里用 [1][2] 标注来源。
            不需要查资料的问题不会因此多花钱，也不会变慢。
          </p>

          <div v-if="search.last_error" class="alert alert-warning">
            上次搜索失败：{{ search.last_error }}
            <span v-if="search.last_error_at" class="tiny muted">（{{ search.last_error_at }}）</span>
          </div>

          <div class="switch-list">
            <label class="switch-row">
              <input type="checkbox" v-model="search.enabled" />
              <span>允许 AI 联网搜索（关闭后模型压根不会收到搜索工具，学生端毫无感知）</span>
            </label>
          </div>

          <div class="row-3">
            <label class="field">
              <span class="field-label">搜索服务</span>
              <select v-model="search.provider" class="input">
                <option v-for="p in search.providers" :key="p.id" :value="p.id">{{ p.label }}</option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">单次返回条数</span>
              <input v-model="search.max_results" class="input" type="number" min="1" max="10" />
            </label>
            <label class="field">
              <span class="field-label">超时（毫秒）</span>
              <input v-model="search.timeout_ms" class="input" type="number" min="3000" max="30000" step="1000" />
            </label>
          </div>

          <label class="field">
            <span class="field-label">API Key</span>
            <input
              v-model="searchKeyInput"
              class="input"
              type="password"
              :placeholder="search.has_key ? ('已配置：' + search.key_masked + '（留空表示不修改）') : '粘贴搜索服务的 API Key'"
            />
            <span class="tiny muted field-note">
              留空 = 保持原 Key 不变。换服务商时先改上面的「搜索服务」，再填新的 Key。
            </span>
          </label>

          <div class="panel-actions">
            <button class="btn btn-primary" :disabled="savingSearch" @click="saveSearch">
              {{ savingSearch ? '保存中…' : '保存配置' }}
            </button>
            <button class="btn btn-ghost" :disabled="testingSearch" @click="testSearch">
              {{ testingSearch ? '测试中…' : '测试一句' }}
            </button>
          </div>

          <div v-if="searchTestText" class="alert" :class="searchTestOk ? 'alert-success' : 'alert-danger'">
            {{ searchTestText }}
          </div>

          <div v-if="searchTestResults.length" class="search-test-list">
            <div v-for="(r, i) in searchTestResults" :key="i" class="search-test-item">
              <div class="search-test-title">{{ i + 1 }}. {{ r.title }}</div>
              <div class="search-test-meta tiny muted">
                <span v-if="r.source_type" class="search-test-tag">{{ r.source_type }}</span>
                <span v-if="r.published">{{ r.published }}</span>
              </div>
              <a class="search-test-url tiny" :href="r.url" target="_blank" rel="noopener">{{ r.url }}</a>
              <div v-if="r.snippet" class="tiny muted">{{ r.snippet }}</div>
            </div>
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

      <!-- ================= AI 洞察（管理员用 AI 读台账） ================= -->
      <template v-else-if="tab === 'ai'">
        <section class="panel glass">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">AI 洞察</h2>
              <p class="panel-sub tiny muted">
                让 AI 读一遍当前台账，给出体检结论与运维建议。数据来源与左侧各页同一口径
                （近 7 天用量、账目总盘、本月预算、模型与单价配置、异常检出）。每次分析会真实调用一次模型，
                但不计入学生额度。
              </p>
            </div>
          </div>

          <div class="insight-ask">
            <div class="insight-presets">
              <button
                v-for="(q, i) in insightPresets"
                :key="i"
                type="button"
                class="insight-chip"
                :disabled="insight.loading"
                @click="askInsight(q)"
              >{{ q }}</button>
            </div>

            <div class="insight-input">
              <textarea
                v-model="insight.question"
                class="insight-textarea"
                rows="2"
                maxlength="500"
                placeholder="也可以直接问一个具体问题，例如：本月会不会超预算？哪个班消耗最快？"
                @keydown.ctrl.enter="runInsight"
              ></textarea>
              <!-- 分析用的模型：与「模型与单价」里的默认模型互不影响。
                   下拉常驻在按钮左边，不给它单独一屏 —— 这是一个"顺手改"的次要选择，
                   但如果藏起来，管理员就会以为分析永远只能用系统默认那一只。 -->
              <div class="insight-model-pick">
                <label class="insight-model-label tiny muted" for="insight-model">分析模型</label>
                <select
                  id="insight-model"
                  v-model="insight.modelId"
                  class="input insight-model-select"
                  :disabled="insight.loading"
                >
                  <option value="">
                    自动{{ insight.autoLabel ? '（' + insight.autoLabel + '）' : '' }}
                  </option>
                  <option
                    v-for="m in insight.modelOptions"
                    :key="m.id"
                    :value="m.id"
                    :disabled="!m.ready"
                  >{{ m.label }}{{ m.ready ? '' : '（未配置 Key）' }}{{ m.is_default ? ' · 默认' : '' }}</option>
                </select>
              </div>
              <button
                class="btn btn-primary"
                :disabled="insight.loading"
                @click="runInsight"
              >{{ insight.loading ? '分析中…' : '开始分析' }}</button>
            </div>
            <p v-if="insight.error" class="insight-error">{{ insight.error }}</p>
          </div>
        </section>

        <section v-if="insight.loading" class="panel glass">
          <div class="insight-wait">
            <i class="insight-spin"></i>
            <span class="tiny muted">AI 正在读取台账并生成分析，通常十几秒，请稍候…</span>
          </div>
        </section>

        <section v-else-if="insight.answer" class="panel glass">
          <div class="panel-head">
            <h2 class="panel-title">分析结果</h2>
            <span class="tiny muted nowrap">
              {{ insight.model || 'AI' }} · 用时 {{ (insight.elapsed / 1000).toFixed(1) }}s
            </span>
          </div>
          <div class="insight-body md-body" v-html="insight.html"></div>

          <!-- 本次分析依据：AI 结论所依据的原始数字 + 当前模型单价。
               默认收起 —— 结论是主体，依据是给"想核对一下 / 想调配置"的管理员随手展开用的。
               单价在这里出现，是因为「该不该换模型 / 单价贵不贵」这类问题只有对着价目才谈得下去。 -->
          <details v-if="insight.context" class="insight-facts">
            <summary class="insight-facts-sum">本次分析依据（展开核对数字）</summary>

            <div class="insight-facts-grid">
              <div class="fact"><span class="fact-k">统计窗口</span><span class="fact-v">近 {{ insight.context.window_days }} 天</span></div>
              <div class="fact"><span class="fact-k">学生 / 管理员</span><span class="fact-v">{{ insight.context.students }} / {{ insight.context.admins }} 人</span></div>
              <div class="fact"><span class="fact-k">近 7 天活跃学生</span><span class="fact-v">{{ insight.context.active_students_7d }} 人</span></div>
              <div class="fact"><span class="fact-k">已分配额度</span><span class="fact-v">¥{{ insight.context.allocated_yuan }}</span></div>
              <div class="fact"><span class="fact-k">已消耗</span><span class="fact-v">¥{{ insight.context.used_yuan }}</span></div>
              <div class="fact"><span class="fact-k">剩余</span><span class="fact-v">¥{{ insight.context.remaining_yuan }}</span></div>
              <div class="fact"><span class="fact-k">消耗率</span><span class="fact-v">{{ insight.context.used_pct }}%</span></div>
              <div class="fact"><span class="fact-k">本月消耗</span><span class="fact-v">¥{{ insight.context.month.cost_yuan }}（{{ insight.context.month.calls }} 次）</span></div>
              <div class="fact">
                <span class="fact-k">本月预算</span>
                <span class="fact-v">{{ insight.context.month.threshold_yuan > 0 ? '¥' + insight.context.month.threshold_yuan : '未设置' }}</span>
              </div>
              <div class="fact"><span class="fact-k">异常突增</span><span class="fact-v">{{ insight.context.spike_count }} 处</span></div>
            </div>

            <div v-if="insight.context.models && insight.context.models.length" class="insight-models">
              <div class="insight-models-title tiny muted">当前启用模型与单价（元 / 百万 token）</div>
              <div v-for="m in insight.context.models" :key="m.id" class="model-row">
                <span class="model-name">{{ m.label }}</span>
                <span class="tiny muted">
                  输入 ¥{{ m.in_yuan_per_m }}/M · 输出 ¥{{ m.out_yuan_per_m }}/M{{ m.multiplier !== 1 ? ' · ×' + m.multiplier : '' }}{{ m.is_default ? ' · 默认' : '' }}{{ m.ready ? '' : ' · 未配 Key' }}
                </span>
              </div>
            </div>
          </details>

          <div class="panel-actions">
            <button class="btn btn-sm btn-ghost" @click="copyInsight">复制全文</button>
            <button class="btn btn-sm btn-ghost" :disabled="insight.loading" @click="runInsight">重新分析</button>
          </div>
        </section>

        <section v-else class="panel glass">
          <div class="insight-hint">
            <p class="tiny muted">
              点上面的问题开始一次分析，或自己输入问题。AI 只会依据页面上的数据作答，
              数据里没有的东西它不会编 —— 需要更多信息时会直接告诉你要导出哪份表。
            </p>
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
import ToggleSwitch from '@/components/ToggleSwitch.vue';
import { apiUrl } from '@/utils/base-path';
// AI 洞察的结果是 markdown（列表 / 加粗 / 表格）。复用全站同一个渲染入口，
// 不在这里另造一套 —— 它已内含 DOMPurify 净化，v-html 是安全的。
import { renderMarkdown } from '@/utils/markdown';

var SOURCE_LABELS = {
  chat: '对话', study: '学习', solve: '拍题', grade: '批改', vision_relay: '图片识别'
};

export default {
  name: 'AdminView',
  components: { AppNav, Segmented, UsageChart, ModelForm, SourceForm, ToggleSwitch },
  data: function() {
    return {
      tab: 'overview',
      error: '',

      // 加载态：请求回来之前不要先摆出「没有匹配的学生 / 暂无流水」这种空态文案
      loading: true,
      usageLoading: true,

      // ---- 额度 ----
      dashboard: null,
      users: [],

      // ---- 组网互联（mesh）----
      // null = 还没取过；取回来之前不显示空态文案，避免「还没加载」被当成「没有班级」
      meshStatus: null,
      meshLoading: false,
      logs: [],
      keyword: '',
      classFilter: '',
      // 全校花名册状态（GET /admin/users 的 roster 字段）：额度页副标题
      // 要回答「我看到的是不是全校、是什么时候的」
      usersRoster: {},
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
      // node 模式：模型由云端统一下发。**持有管理员席位的班可以改**，改完上行
      // 推给云端、同步全校；非席位班只读（改了既同步不了，也会被下次下发覆盖）。
      // 后端在 GET /admin/models 里给 read_only + 原因，这里只负责呈现。
      //
      // 初值必须是 true：权限是**问后端才知道**的，默认可写会出现一小段窗口期
      // （慢网下能有好几秒）按钮是亮的，管理员点进表单填完再保存才被打回 403 ——
      // 表现就是「明明能编辑，一保存就报错」。默认只读、读到 read_only=false 再放开，
      // 宁可闪一下灰按钮，也不给人白填一遍。
      modelReadOnly: true,
      modelReadOnlyReason: '',
      // 「本班自选 / 不同步」两档：可写但改动只在本机生效（迁移 033）。
      // 与 modelReadOnly 互斥，各自一条提示。
      modelLocalOnly: false,
      modelLocalOnlyHint: '',
      modelWritesToSchool: false,
      // 下发范围汇总（迁移 032）：{ models, synced_models, sources, synced_sources,
      // nodes_total, nodes_following }。为 null 表示还没读到，别渲染占位数字。
      syncScope: null,
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

      // ---- 联网搜索 ----
      // 默认值刻意写成"关 + 空 Key"：真正状态以服务端返回为准，
      // 这里只是避免首帧渲染时模板取到 undefined 而报错。
      search: {
        enabled: false, provider: 'tavily', provider_label: 'Tavily',
        has_key: false, key_masked: '', max_results: 5, timeout_ms: 12000,
        depth: 'basic', ready: false, providers: [], last_error: '', last_error_at: ''
      },
      // Key 单独放：输入框留空表示"不改动已有 Key"
      searchKeyInput: '',
      savingSearch: false,
      testingSearch: false,
      searchTestText: '',
      searchTestOk: false,
      searchTestResults: [],

      // ---- 用量 ----
      usageDays: '7',
      usageGroup: 'user',
      usageItems: [],
      usageTotals: {},
      usageRecords: [],
      usageRecordTotal: 0,

      // ---- AI 洞察 ----
      // 打开页签**不自动跑**：每次分析都是一次真实模型调用，
      // 不该因为"切了个页签"就发生（与「模型连通性测试」同一个原则）。
      insight: {
        question: '',
        answer: '',
        html: '',
        model: '',
        // 选中的模型 id：'' = 自动（第一个可用）。管理员可以「平时用便宜的、
        // 月底用强的」；这里只影响这一次分析，不改全站默认模型。
        modelId: '',
        modelOptions: [],
        // 「自动」会落到哪只模型 —— 把黑盒摊开，否则排查时分不清是人选错了还是系统选的
        autoId: '',
        autoLabel: '',
        modelsLoaded: false,
        elapsed: 0,
        context: null,
        loading: false,
        error: ''
      }
    };
  },
  computed: {
    // 「下发」这一列什么时候值得出现：
    //   只读的班（席位不在本机）改了也没用，列出来只会让人以为坏了；
    //   能改的机器上，哪怕暂时没有班接入，也要能提前把范围配好。
    showSyncColumn: function() {
      return !this.modelReadOnly;
    },
    // 「本班改过」的条目总数（模型 + 源）。给「全部恢复跟随中枢」按钮用 ——
    // 0 时这个按钮根本不该出现，否则它看起来像个随时可点的正常操作。
    localChangeTotal: function() {
      var n = 0;
      var list = this.models || [];
      for (var i = 0; i < list.length; i++) n += Number(list[i].local_change_count || 0) ? 1 : 0;
      var sl = this.sources || [];
      for (var j = 0; j < sl.length; j++) n += Number(sl[j].local_change_count || 0) ? 1 : 0;
      return n;
    },
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
    relay: function() {
      return (this.dashboard && this.dashboard.relay) || {};
    },
    // 是否持有云端管理员席位 —— 决定班管在本地能不能改全校配置。以云端告知为准。
    isSeatAdmin: function() {
      return !!this.relay.is_seat_admin;
    },
    // 三档状态：报错 → 报出来；从没成功过 → 提示重试；成功过 → 看距今多久。
    // 「连上了」不能只看 enabled（那是配置齐不齐），得看有没有真的握手成功。
    relayTone: function() {
      if (!this.isNodeMode) return 'off';
      if (this.relay.last_error) return 'err';
      if (!this.relay.last_ok_at) return 'wait';
      return 'ok';
    },
    relayToneText: function() {
      if (!this.isNodeMode) return '未接入';
      if (this.relay.last_error) return '连接异常';
      if (!this.relay.last_ok_at) return '等待首次同步';
      return '已连接 · 最后同步 ' + this.relay.last_ok_at;
    },
    tabOptions: function() {
      return [
        { id: 'overview', label: '总览' },
        // 组网互联：本机当中心时，别的班在这一页管理（在线状态、策略与额度的到达情况、管理员席位）
        { id: 'mesh', label: '班级组网' },
        { id: 'quota', label: '额度分配' },
        { id: 'models', label: '模型与单价' },
        { id: 'vision', label: '视觉配置' },
        { id: 'search', label: '联网搜索' },
        { id: 'usage', label: '用量统计' },
        { id: 'ai', label: 'AI 洞察' }
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
      var base = (this.dashboard && this.dashboard.by_class) || [];
      var out = base.slice();
      var have = {};
      out.forEach(function(c) { have[c.class_no || '--'] = true; });

      // 外班学生是花名册并进来的，本机 dashboard 的 by_class 只统计本班 ——
      // 不补的话班级下拉里根本没有「8 班」这一项，选了也是空列表。
      var count = {};
      (this.users || []).forEach(function(u) {
        var k = u.class_no || '--';
        count[k] = (count[k] || 0) + 1;
      });
      Object.keys(count).forEach(function(k) {
        if (have[k]) return;
        out.push({ class_no: k, students: count[k], allocated_yuan: '0.00' });
      });
      return out;
    },
    // 额度页副标题里那一句：现在看到的是不是全校、是哪个版本、什么时候拉的
    rosterLine: function() {
      if (!this.isSeatAdmin) return '';
      var r = this.usersRoster || {};
      if (r.error) return '全校花名册拉取失败：' + r.error;
      if (!r.count) return '全校花名册还没同步上（等别班上报后即可给外班学生充值）';
      var when = r.synced_at ? this.formatTime(r.synced_at) : '—';
      return '已载入全校花名册 v' + (r.version || 0) + ' · ' + r.count + ' 人 · ' + when +
        '，带「外班」标的学生可直接充值（钱走云端账本，会同步到他所在的班）';
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
    },
    // AI 洞察的预设问题：覆盖管理员最常关心的四件事（花钱进度 / 异常 / 结构 / 降本）。
    // 有预设是因为"不知道该问什么"是这类功能的第一个门槛。
    insightPresets: function() {
      return [
        '本月会不会超预算？',
        '近 7 天用量有没有异常？',
        '哪个班 / 哪些学生消耗最快？',
        '怎么把成本降下来？'
      ];
    }
  },
  watch: {
    tab: function(val) {
      // 切到某个标签才加载它的数据：避免进管理台就把三个大查询全跑一遍
      if (val === 'overview') this.loadOverview();
      else if (val === 'mesh') this.loadMeshStatus();
      else if (val === 'quota') this.loadQuotaTab();
      else if (val === 'models') { this.loadModels(); this.loadOffpeak(); }
      else if (val === 'vision') this.loadVision();
      else if (val === 'search') this.loadSearch();
      else if (val === 'usage') { this.loadUsage(); this.loadAnomalies(); }
      // ai 标签：只拉「可选模型清单」这个零成本的配置读接口，不跑任何分析。
      // 每次分析本身仍然只在点「开始分析」时发生（一次真实模型调用）。
      else if (val === 'ai') { this.loadInsightModels(); }
    },
    usageDays: function() { this.loadUsage(); },
    usageGroup: function() { this.loadUsageSummary(); }
  },
  mounted: function() {
    this.loadOverview();
  },
  methods: {
    // ---- 组网互联（mesh）----
    loadMeshStatus: function() {
      var self = this;
      this.meshLoading = true;
      this.$http.get('/admin/mesh/status').then(function(r) {
        if (r.data.code === 200) self.meshStatus = r.data.data;
      }).catch(function(e) {
        self.error = (e && e.message) || '读取组网状态失败';
      }).then(function() {
        self.meshLoading = false;
      });
    },

    // 心跳过去了多久（毫秒）。服务端给的是 UTC 且不带时区标记，按 Z 解析。
    seenMsAgo: function(n) {
      if (!n || !n.last_seen_at) return null;
      var t = Date.parse(String(n.last_seen_at).replace(' ', 'T') + 'Z');
      return isFinite(t) ? (Date.now() - t) : null;
    },

    // 离线与否由服务端判定 —— `online` 是 /mesh/status 一并算好的。
    // 之前这里自己掐表（3 分钟），接口那边又有另一个阈值（10 分钟），
    // 同一时刻同一节点在接口里算在线、在页面上算离线，对不了账。
    // seenMsAgo 那段本地计算留作兜底：老版本服务端还没这个字段时不至于全判离线。
    nodeOnline: function(n) {
      if (n && typeof n.online === 'boolean') return n.online;
      var ms = this.seenMsAgo(n);
      return ms !== null && ms < 3 * 60 * 1000;
    },

    lastSeenText: function(n) {
      var ms = this.seenMsAgo(n);
      if (ms === null) return '从未';
      if (ms < 60000) return '刚刚';
      var m = Math.floor(ms / 60000);
      if (m < 60) return m + ' 分钟前';
      var h = Math.floor(m / 60);
      if (h < 24) return h + ' 小时前';
      return Math.floor(h / 24) + ' 天前';
    },

    // 席位只能有一处：给出去本机就变只读，收回来本机才能改全校配置。
    // 这个按钮看起来像「授权」，实际是「移交」，所以文案要说清谁失去权限。
    setSeat: function(instanceId) {
      var self = this;
      this.$http.post('/admin/mesh/seat', { instance_id: instanceId || '' }).then(function(r) {
        if (r.data.code === 200) {
          self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
          self.loadMeshStatus();
        }
      }).catch(function(e) {
        var msg = (e && e.response && e.response.data && e.response.data.message) || '操作失败';
        self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
      });
    },

    // 节点卡上的「模型同步档位」文案。三档不是「开/关」的粗细版本，
    // 它们的差别在**改不动得动**与**改动去哪了**，所以文案必须短而互斥。
    nodeModelSyncLabel: function(v) {
      var n = Number(v);
      if (n === 2) return '模型本班自选（可改·不回传）';
      if (n === 0) return '模型不同步';
      return '模型跟随中枢';
    },

    // 切换某个班的模型同步档位（迁移 033 三态）：
    //   1 跟随中枢     —— 全量替换下发，该班只读
    //   2 本班自选     —— 合并下发，该班可改，改动不回传
    //   0 完全不同步   —— 不拉也不推
    //
    // 确认走全局自定义弹窗而不是 window.confirm：原生弹窗在 Android WebView 里
    // 是一块与界面无关的系统灰底，既打断玻璃拟态，也没法标出危险等级。
    //
    // 下拉而不是按钮循环：三档循环要连点两次才能到中间那档，
    // 而且用户看不到「还有哪些档」。列表里一眼可选完才对。
    onNodeModelSyncChange: function(node, ev) {
      var self = this;
      var current = Number(node.model_sync === undefined ? 1 : node.model_sync);
      var target = Number(ev.target.value);
      var inst = node.instance_id;

      // 取消时把下拉摆回原值：:value 绑定只在重渲染时生效，
      // 用户点了别的档再取消，DOM 会停在那个档上，看起来像已经改了。
      var reset = function() {
        try { if (ev.target) ev.target.value = String(current); } catch (e) { /* 元素已销毁 */ }
      };
      if (target === current) return;

      var conf = {
        1: {
          title: '让这个班跟随中枢模型？',
          message: '开启后 ' + inst + ' 下一轮同步会拉取中枢的模型配置，并全量替换它自己的'
            + '（只含勾了「下发」的模型与源）；该班的模型页会变回只读。',
          confirmText: '跟随中枢',
          danger: false
        },
        2: {
          title: '让这个班可以自己改模型？',
          message: '中枢新配的模型仍会下发给 ' + inst + '，本班自己建的模型与源会一直保留，'
            + '班管可以直接增删改；改动只在本机生效，不会同步回管理员班。'
            + '同一条模型逐字段跟随：班管改过的字段保留本班的值，没改过的（含单价、倍率、'
            + '峰谷、Key）继续跟中枢更新走。',
          confirmText: '改为本班自选',
          danger: false
        },
        0: {
          title: '停止给这个班下发模型？',
          message: '断开后 ' + inst + ' 保留自己现有的模型配置，中枢既不下发也不覆盖；'
            + '班管可以自由增删改，改动不回传。额度与名单照常同步。',
          confirmText: '停止下发',
          danger: true
        }
      }[target];

      if (!conf) { reset(); return; }

      this.$store.dispatch('confirm', conf).then(function(ok) {
        if (!ok) { reset(); return; }
        self.$http.post('/admin/mesh/node-model-sync', {
          instance_id: inst,
          mode: target
        }).then(function(r) {
          if (r.data.code === 200) {
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadMeshStatus();
          } else {
            reset();
          }
        }).catch(function(e) {
          reset();
          var msg = (e && e.response && e.response.data && e.response.data.message) || '操作失败';
          self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
        });
      });
    },

    // ---------- 下发范围（迁移 032）----------
    //
    // 别和上面的「启用 / 禁用」混了：enabled 是本机用不用，
    // sync_enabled 是发不发到别的班。一个模型完全可以「本机启用、暂不下发」。
    isSourceSyncOff: function(m) {
      if (!m || !m.source_id) return false;
      var sid = m.source_id;
      var s = (this.sources || []).filter(function(x) { return x.id === sid; })[0];
      return !!(s && s.sync_enabled === 0);
    },

    // 表格里那一列显示的「实际会不会发出去」：源关了，模型跟着不发
    isModelSynced: function(m) {
      if (this.isSourceSyncOff(m)) return false;
      return m.sync_enabled !== 0;
    },

    setModelSync: function(m, next) {
      var self = this;
      var run = function() {
        self.$http.post('/admin/models/' + m.id + '/sync', { enabled: next ? 1 : 0 })
          .then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadModels();
          })
          .catch(function(e) {
            var msg = (e && e.response && e.response.data && e.response.data.message)
              || (e && e.message) || '操作失败';
            // 失败时开关会自己弹回原位（ToggleSwitch 按 prop 对齐），
            // 所以这里只需要把原因说清楚
            self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
          });
      };
      if (next) return run();
      this.$store.dispatch('confirm', {
        title: '停止下发？',
        message: '「' + m.label + '」会保留在本机，但各班的模型列表里将不再出现它。'
          + '已在各班进行中的会话不受影响，下一轮同步（1 分钟内）生效。',
        confirmText: '停止下发',
        danger: true
      }).then(function(ok) { if (ok) run(); });
    },

    setSourceSync: function(s, next) {
      var self = this;
      var run = function() {
        self.$http.post('/admin/sources/' + s.id + '/sync', { enabled: next ? 1 : 0 })
          .then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadModels();
          })
          .catch(function(e) {
            var msg = (e && e.response && e.response.data && e.response.data.message)
              || (e && e.message) || '操作失败';
            self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
          });
      };
      if (next) return run();
      // 级联影响必须说清楚：关掉一个源等于同时关掉它下面所有模型，
      // 而源表格里只有一列「挂载模型」的数量，不说的话没人会联想到这一层
      var count = Number(s.model_count || 0);
      this.$store.dispatch('confirm', {
        title: '停止下发这个源？',
        message: '源「' + (s.label || s.id) + '」不再发到各班'
          + (count ? ('，挂在它上面的 ' + count + ' 个模型也会一并不再下发') : '')
          + '。本机照常使用，下一轮同步（1 分钟内）生效。',
        confirmText: '停止下发',
        danger: true
      }).then(function(ok) { if (ok) run(); });
    },

    sourceLabel: function(s) { return SOURCE_LABELS[s] || s || '对话'; },

    // ---------- 恢复跟随中枢（迁移 034 的字段级合并）----------
    //
    // 为什么需要：字段级合并下，本班改过的**那个字段**会一直保留本班的值
    // （有意的 —— 管理员在本机改的价不该被一次轮询抹掉）。但改错过一次就
    // 再也收不到中枢对这个字段的调整，所以必须有出口。
    //
    // 列名 → 中文：徽标 tooltip 要能说清「哪几项偏离」，只说「3 项」等于没说。
    localFieldNames: function(row) {
      var LABELS = {
        label: '显示名', api_url: 'API 地址', api_key: 'API Key', model_name: '模型名',
        api_style: '协议风格', supports_thinking: '深度思考', supports_stream: '流式',
        supports_vision: '视觉', vision_max_images: '图片上限',
        price_in: '输入单价', price_out: '输出单价', price_cache_hit: '缓存单价',
        price_multiplier_bp: '倍率', free_until: '限免截止', is_free: '免费',
        enabled: '启用', is_default: '默认', sort_order: '排序',
        source_id: '所挂源', has_offpeak: '峰谷', offpeak_peak_windows: '峰时段',
        offpeak_discount_bp: '谷时折扣', sync_enabled: '下发范围'
      };
      var fields = (row && row.local_fields) || [];
      var out = [];
      for (var i = 0; i < fields.length; i++) out.push(LABELS[fields[i]] || fields[i]);
      return out.join('、');
    },

    followHubModel: function(m) {
      var self = this;
      this.$store.dispatch('confirm', {
        title: '恢复跟随中枢？',
        message: '「' + (m.label || m.id) + '」将整行按中枢当前版本刷新：'
          + '本班改过的 ' + (m.local_change_count || 0) + ' 项（' + this.localFieldNames(m) + '）会被中枢的值覆盖。'
          + '如果只是想让某一项回到中枢，可以先手工改回去。',
        confirmText: '恢复跟随',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.post('/admin/models/' + m.id + '/follow', {})
          .then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadModels();
          })
          .catch(function(e) {
            var msg = (e && e.response && e.response.data && e.response.data.message)
              || (e && e.message) || '操作失败';
            self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
          });
      });
    },

    followHubSource: function(s) {
      var self = this;
      this.$store.dispatch('confirm', {
        title: '恢复跟随中枢？',
        message: '源「' + (s.label || s.id) + '」将整行按中枢当前版本刷新：'
          + '本班改过的 ' + (s.local_change_count || 0) + ' 项（' + this.localFieldNames(s) + '）会被中枢的值覆盖，'
          + '包括地址与 Key。',
        confirmText: '恢复跟随',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.post('/admin/sources/' + s.id + '/follow', {})
          .then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadModels();
          })
          .catch(function(e) {
            var msg = (e && e.response && e.response.data && e.response.data.message)
              || (e && e.message) || '操作失败';
            self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
          });
      });
    },

    followHubAll: function() {
      var self = this;
      this.$store.dispatch('confirm', {
        title: '全部恢复跟随中枢？',
        message: '本班改过的 ' + this.localChangeTotal + ' 条（模型与模型源）会整行恢复成中枢版本，'
          + '本班自建的条目不受影响。这个操作会覆盖你在本机的所有修改。',
        confirmText: '全部恢复',
        danger: true
      }).then(function(ok) {
        if (!ok) return;
        self.$http.post('/admin/model-config/follow-all', {})
          .then(function(r) {
            if (r.data.code !== 200) throw new Error(r.data.message || '操作失败');
            self.$store.commit('SHOW_TOAST', { message: r.data.message, type: 'success' });
            self.loadModels();
          })
          .catch(function(e) {
            var msg = (e && e.response && e.response.data && e.response.data.message)
              || (e && e.message) || '操作失败';
            self.$store.commit('SHOW_TOAST', { message: msg, type: 'error' });
          });
      });
    },

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
          self.usersRoster = r.data.data.roster || {};
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
          self.modelReadOnly = !!r.data.data.read_only;
          self.modelReadOnlyReason = r.data.data.read_only_reason || '';
          self.modelLocalOnly = !!r.data.data.local_only;
          self.modelLocalOnlyHint = r.data.data.local_only_hint || '';
          self.modelWritesToSchool = !!r.data.data.writes_to_school;
          self.syncScope = r.data.data.sync_scope || null;
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

    // ---------- 联网搜索 ----------
    loadSearch: function() {
      var self = this;
      this.error = '';
      return this.$http.get('/admin/search').then(function(r) {
        if (r.data.code !== 200) return;
        self.search = r.data.data;
        // 每次加载都清空输入框：否则上次没保存的 Key 会留在框里，
        // 下次点保存就把它当成"新 Key"又存一遍（看起来像没生效）。
        self.searchKeyInput = '';
      }).catch(function(err) {
        self.error = err.message || '联网搜索配置加载失败';
      });
    },

    saveSearch: function() {
      var self = this;
      this.savingSearch = true;
      this.error = '';
      var payload = {
        enabled: this.search.enabled,
        provider: this.search.provider,
        max_results: Number(this.search.max_results),
        timeout_ms: Number(this.search.timeout_ms),
        depth: this.search.depth
      };
      // 留空 = 不改 Key（三态语义见服务端 admin.js 的注释）
      if (this.searchKeyInput) payload.api_key = this.searchKeyInput;

      this.$http.put('/admin/search', payload).then(function(r) {
        if (r.data.code !== 200) throw new Error(r.data.message || '保存失败');
        self.$store.dispatch('toast', { message: '搜索配置已保存，即时生效', type: 'success' });
        return self.loadSearch();
      }).catch(function(err) {
        self.error = err.message || '保存失败';
      }).then(function() {
        self.savingSearch = false;
      });
    },

    testSearch: function() {
      var self = this;
      this.testingSearch = true;
      this.searchTestText = '';
      this.searchTestResults = [];
      this.$http.post('/admin/search/test', { query: '今天的新闻' }).then(function(r) {
        var d = (r.data && r.data.data) || {};
        self.searchTestOk = !!d.ok;
        self.searchTestResults = d.results || [];
        if (d.ok) {
          // 把「几组关键词 / 上游几条 → 重排后几条」写出来：
          // 老师判断"搜得准不准"靠的就是这几个数，而不是一句"搜索正常"。
          var qn = (d.queries || []).length;
          var extra = '';
          if (qn > 1) extra += '，' + qn + ' 组关键词交叉核对';
          if (d.total_before_rank && d.total_before_rank > self.searchTestResults.length) {
            extra += '，上游 ' + d.total_before_rank + ' 条重排后取前 ' + self.searchTestResults.length;
          }
          self.searchTestText = '搜索正常：' + d.provider + ' 返回 ' + self.searchTestResults.length +
            ' 条' + extra + '，用时 ' + d.took_ms + 'ms' + (d.cached ? '（命中缓存）' : '');
        } else {
          self.searchTestText = '搜索失败：' + (d.error || r.data.message || '未知原因');
        }
      }).catch(function(err) {
        self.searchTestOk = false;
        self.searchTestText = '搜索失败：' + (err.message || '请求出错');
      }).then(function() {
        self.testingSearch = false;
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

    // ---------- AI 洞察 ----------
    // 只读配置，不调模型，可以放心在切 tab 时拉。
    // 失败不弹 toast：模型清单拿不到时，「自动」仍然能用（服务端自己挑），
    // 为了一个下拉框的选项去打断管理员正在看台账，代价不对等。
    loadInsightModels: function() {
      var self = this;
      if (this.insight.modelsLoaded) return Promise.resolve();
      return this.$http.get('/admin/ai/insight/models').then(function(r) {
        var d = (r.data && r.data.data) || {};
        self.insight.modelOptions = Array.isArray(d.models) ? d.models : [];
        self.insight.autoId = d.auto_id || '';
        self.insight.autoLabel = d.auto_label || '';
        self.insight.modelsLoaded = true;
      }).catch(function() {
        // 静默降级：清单空 = 只有「自动」一项
        self.insight.modelsLoaded = true;
      });
    },

    runInsight: function() {
      var self = this;
      if (this.insight.loading) return Promise.resolve();
      this.insight.loading = true;
      this.insight.error = '';
      // 超时放宽到 90s：服务端那段分析读的是整份快照，比一轮普通对话长；
      // 沿用实例默认的 30s 会先被前端掐断 —— 明明服务端算得出来，前端却报"请求超时"。
      return this.$http.post('/admin/ai/insight', {
        question: this.insight.question.trim(),
        // '' = 自动（服务端挑第一个可用的）；指定了就只用这一只，服务端不会静默回退
        model_id: this.insight.modelId || ''
      }, { timeout: 90000 }).then(function(r) {
        // 失败走的是 HTTP 200 + data.ok:false（与「模型连通性测试」同风格），
        // 所以这里先判 ok，不能让 error 分支把 message 当成正文渲染出来
        var d = (r.data && r.data.data) || {};
        if (!d.ok) {
          self.insight.answer = '';
          self.insight.html = '';
          self.insight.error = d.error || '分析失败，请稍后重试';
          return;
        }
        self.insight.answer = d.answer || '';
        self.insight.html = renderMarkdown(d.answer || '');
        self.insight.model = d.model || '';
        self.insight.elapsed = d.elapsed_ms || 0;
        self.insight.context = d.context || null;
      }).catch(function(err) {
        self.insight.error = err.message || '分析失败，请稍后重试';
      }).then(function() {
        self.insight.loading = false;
      });
    },

    askInsight: function(q) {
      this.insight.question = q;
      return this.runInsight();
    },

    copyInsight: function() {
      var self = this;
      var text = this.insight.answer || '';
      var ok = function() {
        self.$store.dispatch('toast', { message: '已复制分析全文', type: 'success' });
      };
      var fail = function() {
        self.$store.dispatch('toast', { message: '复制失败，请手动选择后复制', type: 'error' });
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok).catch(fail);
        return;
      }
      // 老内核兜底：clipboard API 不可用时退回 textarea + execCommand
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok();
      } catch (e) {
        fail();
      }
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
      this.download(apiUrl('admin/snapshot'), 'cluss-snapshot.csv');
    },

    exportUsage: function() {
      this.download(apiUrl('admin/usage/export.csv?days=' + this.usageDays), 'cluss-usage.csv');
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

/* ---------- AI 洞察 ---------- */
.insight-ask {
  display: flex;
  flex-direction: column;
  gap: var(--gap-md);
}
html.no-flex-gap .insight-ask > * + * {
  margin-top: var(--gap-md);
}

.insight-presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--gap-sm);
}
html.no-flex-gap .insight-presets > * + * {
  margin-left: var(--gap-sm);
}

/* 预设问题做成胶囊按钮：与对话页的「场景标签」同一视觉语言，
   刻意不复用 Chat.vue 的 .chip-suggest —— 那是 scoped 样式，跨组件拿不到 */
.insight-chip {
  padding: 7px 13px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-pill);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.4;
  cursor: pointer;
  transition: border-color .16s ease, background .16s ease, color .16s ease;
}
.insight-chip:hover:not(:disabled) {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
}
.insight-chip:disabled {
  opacity: .55;
  cursor: default;
}

.insight-input {
  display: flex;
  align-items: flex-start;
  gap: var(--gap-sm);
}
html.no-flex-gap .insight-input > * + * {
  margin-left: var(--gap-sm);
}
.insight-textarea {
  flex: 1;
  min-width: 0;
  min-height: 78px;
  padding: 10px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--ink-1);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
}
.insight-textarea:focus {
  outline: none;
  border-color: var(--accent-border-strong);
  background: var(--surface-2);
}

/* 分析模型：固定一列，不跟输入的剩余空间抢宽度。
   标签在上、下拉在下（横排会挤成一串省略号，模型名往往很长）。
   放在按钮左边而不是另起一行：这是"顺手改"的次要选择，
   单独占一行会让它看起来和"开始分析"同等重要。 */
.insight-model-pick {
  display: flex;
  flex-direction: column;
  flex: 0 0 196px;
  min-width: 0;
}
html.no-flex-gap .insight-model-pick > * + * {
  margin-top: 4px;
}
.insight-model-label {
  margin-bottom: 4px;
  line-height: 1.2;
}
html.no-flex-gap .insight-model-label {
  margin-bottom: 0;
}
.insight-model-select {
  width: 100%;
  font-size: 13px;
}

.insight-error {
  margin: 0;
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-size: 13px;
  line-height: 1.5;
}

.insight-wait {
  display: flex;
  align-items: center;
  gap: var(--gap-sm);
  padding: 16px 18px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  color: var(--text-secondary);
  font-size: 14px;
}
html.no-flex-gap .insight-wait > * + * {
  margin-left: var(--gap-sm);
}
.insight-spin {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  border: 2px solid var(--ink-4);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: insight-rotate .8s linear infinite;
}
@keyframes insight-rotate {
  to { transform: rotate(360deg); }
}

/* 结果正文：复用 global.css 的 .md-body 排版，这里只管外层节奏 */
.insight-body {
  margin-top: var(--gap-md);
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--text-primary);
}

/* ---------- AI 洞察：本次分析依据 ----------
   结论是主体、依据是附注，所以整块做成默认收起的折叠区（原生 <details>，
   零 JS）。单价也放这里 —— 「该不该换模型 / 单价贵不贵」只有对着价目才谈得下去。 */
.insight-facts {
  margin-top: var(--gap-md);
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-md);
  background: var(--ink-1);
  padding: 0 12px;
}
.insight-facts-sum {
  cursor: pointer;
  padding: 10px 0;
  font-size: 13px;
  color: var(--text-secondary);
  /* 去掉浏览器默认的三角标记，改用自绘，避免各端箭头样式不一 */
  list-style: none;
  user-select: none;
}
.insight-facts-sum::-webkit-details-marker { display: none; }
.insight-facts-sum::before { content: '▸ '; }
.insight-facts[open] .insight-facts-sum::before { content: '▾ '; }

/* 指标网格：CSS Grid 的 gap 在 Chrome 57+ 就有，不需要 no-flex-gap 兜底 */
.insight-facts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: var(--gap-sm);
  padding: 4px 0 12px;
}
.fact { display: block; }
.fact-k {
  display: block;
  font-size: 12px;
  color: var(--text-tertiary);
}
.fact-v {
  display: block;
  margin-top: 2px;
  font-size: 14px;
  color: var(--text-primary);
}

.insight-models {
  border-top: 1px solid var(--ink-3);
  padding: 10px 0 12px;
}
.insight-models-title { margin-bottom: 6px; }
.model-row {
  display: flex;
  align-items: baseline;
  gap: var(--gap-sm);
  padding: 5px 0;
  border-bottom: 1px dashed var(--ink-3);
  /* 窄屏下单价那一长串会换行，包住避免撑宽整块 */
  flex-wrap: wrap;
}
/* Chrome 80 不支持 flex gap：模型名与单价之间补左边距 */
html.no-flex-gap .model-row > * + * { margin-left: var(--gap-sm); }
.model-row:last-child { border-bottom: none; }
.model-name {
  font-size: 13px;
  color: var(--text-primary);
}

.insight-hint {
  margin: 0;
  padding: 16px 18px;
  border-radius: var(--radius-md);
  background: var(--ink-1);
  color: var(--text-tertiary);
  font-size: 13.5px;
  line-height: 1.7;
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

/* 下发开关列：只放一个 38px 开关（关闭级联时多一行「随源」小字）。
   给 74px 而不是撑满，是为了不把「操作」列挤到需要横向滚动。 */
.col-sync {
  width: 74px;
  text-align: center;
  white-space: nowrap;
}

.col-sync .sync-hint {
  display: block;
  margin-top: 2px;
}

.sync-scope-line {
  margin-top: 4px;
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
  /* Chrome 80 基线：这里没有 align-items，徽标会被 flex 拉伸成整列宽的色条
     （「中枢下发」「本班改过 1 项」都会变成一条横贯单元格的底纹，看着像表格
     出错）。徽标必须按内容宽度左对齐。 */
  align-items: flex-start;
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

/* 云端接入面板 */
.relay-panel .panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 状态点用「形状+颜色」双编码：只靠颜色的话，色觉障碍用户分不出绿黄红 */
.relay-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--muted, #8b8b8b);
}

.relay-dot.ok { background: var(--ok-text, #2f9e44); }
.relay-dot.err { background: var(--danger-text, #d64545); }
.relay-dot.wait {
  background: transparent;
  border: 2px solid var(--warn-text, #c58a12);
}

.relay-lag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: .75rem;
  line-height: 1.5;
  color: var(--warn-text, #c58a12);
  border: 1px solid currentColor;
}

.model-ro-notice {
  margin: 0 0 var(--gap-sm, 8px);
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
  /* AI 洞察：窄屏把「输入 + 分析」竖排，按钮铺满一行，避免输入框被挤成一条缝 */
  .insight-input {
    flex-direction: column;
    align-items: stretch;
  }
  /* 竖排后模型选择跟着铺满：固定 196px 在手机屏上会留出一道右侧空白 */
  .insight-model-pick {
    flex: 0 0 auto;
    width: 100%;
  }
  html.no-flex-gap .insight-input > * + * {
    margin-left: 0;
    margin-top: var(--gap-sm);
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
.search-test-list {
  margin-top: 14px;
}
.search-test-item {
  padding: 10px 0;
  border-top: 1px solid var(--border-color);
}
.search-test-item:first-child {
  border-top: none;
  padding-top: 0;
}
.search-test-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 2px;
}
.search-test-url {
  display: block;
  color: var(--accent-text);
  word-break: break-all;
  margin-bottom: 4px;
  text-decoration: none;
}
/* 来源类型标签：老师一眼看出这条是「政府/官方」还是「门户/聚合」。
   刻意不用 flex + gap —— 基线是 Chrome 80，flex 的 gap 在 81 之前无效。 */
.search-test-meta {
  margin-bottom: 3px;
}
.search-test-meta > span {
  display: inline-block;
  margin-right: 8px;
}
.search-test-tag {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--accent-text);
  background: var(--accent-soft, rgba(47, 107, 221, 0.12));
}

/* ---- 组网互联：已接入班级 ---- */
/* 一个班一行而不是表格：平板上表格要横向滚动才看得全，
   而这一页最需要一眼扫到的是「哪个班在线」，不是对齐的数字。 */
.mesh-nodes {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.mesh-node {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--ink-3);
  border-radius: var(--radius-sm);
  background: var(--ink-1);
  /* 用 margin 而不是 flex gap：基线是 Chrome 80，旧内核的 flex gap 不生效，
     节点之间会粘在一起 */
  margin-bottom: 10px;
}
.mesh-node:last-child { margin-bottom: 0; }
.mesh-node-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.mesh-node-id {
  margin-right: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.mesh-node-head .badge {
  margin-right: 6px;
}
.mesh-node-meta {
  margin-top: 4px;
}
.mesh-node-actions {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
}
/* 同上：不用 gap，旧内核不认 flex gap，按钮会粘成一串 */
.mesh-node-actions .btn {
  margin: 0 8px 4px 0;
}

/* 模型档位下拉：与 btn-sm 等高，宽度随内容（三档文案长短差别大，
   固定宽度会把「本班自选（可改·不回传）」截掉）。旧内核不认 flex gap，
   靠 margin 与左侧按钮留出间距。 */
.mesh-node-select {
  width: auto;
  min-width: 168px;
  height: 32px;
  padding: 0 8px;
  margin: 0 8px 4px 0;
  font-size: 12px;
  line-height: 30px;
  border-radius: var(--radius-sm);
}
</style>