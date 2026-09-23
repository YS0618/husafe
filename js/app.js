/* ==========================================================================
   朝夕 Husafe · 应用层
   路由 / 页面渲染 / 交互
   ========================================================================== */

const TABS = [
  { id: 'home',    label: '首页', icon: '🏠' },
  { id: 'records', label: '账目', icon: '📒' },
  { id: 'add',     label: '',     icon: '+'  },
  { id: 'goals',   label: '目标', icon: '🎯' },
  { id: 'me',      label: '我的', icon: '🐻' },
];

const app = {
  tab: 'home',
  month: currentMonth(),
  filter: 'all',          // all | shared | private
  statScope: 'shared',    // shared | mine
  detailId: null,
};

/**
 * 版本号 —— 显示在「我的」页底部，用来确认你打开的是不是最新代码。
 * 每次交付改一次，方便一眼判断浏览器有没有在用缓存的旧文件。
 */
const BUILD = 'v0.4';

/* ==========================================================================
   工具
   ========================================================================== */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('open'), 1800);
  if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) {} }
}

/* ==========================================================================
   主题（深色模式）
   ========================================================================== */

const THEMES = [
  { id: 'auto',  label: '跟随系统', icon: '🌗' },
  { id: 'light', label: '浅色',     icon: '☀️' },
  { id: 'dark',  label: '深色',     icon: '🌙' },
];

function applyTheme() {
  const t = getTheme();
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = t === 'dark' ||
      (t === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    meta.setAttribute('content', dark ? '#241F1C' : '#FFFBF5');
  }
}

function cycleTheme(next) {
  setTheme(next);
  applyTheme();
  render();
  toast(`主题：${THEMES.find(x => x.id === next).label}`);
}

/* ==========================================================================
   通用组件
   ========================================================================== */

/** 进度环（SVG，360° 起点在 12 点方向） */
function ring(percent, size = 84, stroke = 10, done = false) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, percent));
  const offset = c * (1 - p);
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  const from = done ? '#8FD3B6' : '#F5A3A3';
  const to   = done ? '#B6E8CE' : '#F9C784';
  return `
    <div class="ring" style="width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="${from}"/>
            <stop offset="100%" stop-color="${to}"/>
          </linearGradient>
        </defs>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
                stroke="var(--line)" stroke-width="${stroke}"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none"
                stroke="url(#${gid})" stroke-width="${stroke}" stroke-linecap="round"
                stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
                style="transition: stroke-dashoffset 600ms ease-out"/>
      </svg>
      <div class="ring-label">
        <div class="ring-pct ${done ? 'done' : ''}">${Math.round(p * 100)}%</div>
        <div class="ring-sub">已攒</div>
      </div>
    </div>`;
}

/** 账目行 */
function recRow(r) {
  const c = cat(r.categoryId);
  const isPrivate = r.visibility === 'private';
  const isIncome = r.type === 'income';

  const amtText = (isIncome ? '+' : '') + money(r.amount, false);

  // 副标题只放备注 —— 不再显示"算谁的"（v0.3 已删掉这一维）
  const subText = r.note || '';

  const badges = [];
  if (isPrivate) badges.push('<span class="badge badge-private">🔒 只我</span>');
  else badges.push('<span class="badge badge-shared">我们</span>');
  if (r.goalId) badges.push('<span class="badge badge-goal">目标</span>');

  return `
    <div class="rec ${isPrivate ? 'is-private' : ''}" data-rec="${r.id}">
      <div class="rec-icon">${c.icon}</div>
      <div class="rec-body">
        <div class="rec-name">${esc(r.note || c.name)} ${badges.join('')}</div>
        <div class="rec-sub">${esc(subText || c.name)}</div>
      </div>
      <div class="rec-amt ${isIncome ? 'income' : ''}">
        <span class="${isPrivate ? 'muted' : ''}">${isPrivate ? '· ' : ''}¥${amtText}</span>
        <span class="rec-amt-sub">${isPrivate ? '仅我可见' : payerText(r)}</span>
      </div>
    </div>`;
}

function emptyState(emoji, title, desc, btnLabel, btnAction) {
  return `
    <div class="empty">
      <div class="empty-emoji">${emoji}</div>
      <div class="empty-title">${esc(title)}</div>
      <div class="empty-desc">${esc(desc)}</div>
      ${btnLabel ? `<button class="btn btn-primary" data-action="${btnAction}">${esc(btnLabel)}</button>` : ''}
    </div>`;
}

/* ==========================================================================
   页面：首页
   ========================================================================== */

function screenHome() {
  const m = currentMonth();
  const shared = monthlyStats(m, 'shared');
  const budget = state.couple.monthlyBudget || 0;
  const usedPct = budget ? shared.total / budget : 0;
  const daysLeft = daysInMonthLeft();

  const goal = state.goals.find(g => g.status === 'active');
  const saved = goal ? goalSaved(goal.id) : 0;
  const gp = goal ? saved / goal.target : 0;

  const recent = visibleRecords()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 4);

  return `
    ${state.onboarded ? '' : onboardCard()}

    <div class="hero">
      <div class="hero-label">${monthLabel(m)}我们一起花了</div>
      <div class="hero-amount"><span class="cur">¥</span>${money(shared.total)}</div>
      <div class="hero-split">
        <div class="hs-item">
          <div class="hs-k">我付的</div>
          <div class="hs-v">¥${money(shared.paidByMe, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">${esc(state.partner.nickname)}付的</div>
          <div class="hs-v">¥${money(shared.paidByPartner, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">共 ${shared.count} 笔</div>
          <div class="hs-v">${daysLeft} 天后月末</div>
        </div>
      </div>
    </div>

    ${budgetAlertBar()}

    ${goal ? `
      <div class="card">
        <div class="card-title">
          <span>一起攒钱</span>
          <span class="ct-link" data-action="go-goals">全部目标 ›</span>
        </div>
        <div class="goal-card">
          ${ring(gp, 88, 10, gp >= 1)}
          <div class="goal-info">
            <div class="goal-name">${goal.icon} ${esc(goal.name)}</div>
            <div class="goal-meta">
              已攒 <strong>¥${money(saved, false)}</strong> / ${money(goal.target, false)}
            </div>
            <div class="goal-days">${goalDaysText(goal, saved)}</div>
          </div>
        </div>
      </div>` : ''}

    ${budget ? `
      <div class="card">
        <div class="card-title"><span>本月共同预算</span>
          <span class="ct-link">${Math.round(usedPct * 100)}%</span></div>
        <div class="bar"><div class="bar-fill ${usedPct > 0.9 ? 'over' : usedPct > 0.7 ? 'warn' : ''}"
             style="width:${Math.min(100, usedPct * 100)}%"></div></div>
        <div class="budget-hint">${budgetHint(shared.total, budget, daysLeft)}</div>
      </div>` : ''}

    ${privateCard()}

    <div class="section-label">最近账目</div>
    ${recent.length
      ? recent.map(r => recRow(r)).join('')
      : emptyState('🍡', '还没有账目哦', '记下第一笔，我们一起开始', '记一笔', 'open-add')}
  `;
}

/**
 * 我这个月的私密开销汇总。
 *
 * 私密账目不进共同统计（这是设计），但用户仍然需要看到"我这个月自己花了多少"——
 * 否则记了私账却在首页毫无反馈，会以为记账没生效。
 *
 * 只在真的有私密账目时显示，没记过就不占位置。
 */
function privateCard() {
  const mine = monthlyStats(currentMonth(), 'mine');
  if (!mine.count) return '';
  return `
    <div class="card">
      <div class="card-title">
        <span>🔒 我这个月的私密开销</span>
        <span class="ct-link" data-action="go-stats-mine">看明细 ›</span>
      </div>
      <div class="hero-split">
        <div class="hs-item">
          <div class="hs-k">共 ${mine.count} 笔</div>
          <div class="hs-v">¥${money(mine.total, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">这些不参与共同统计</div>
          <div class="hs-v"></div>
        </div>
      </div>
    </div>`;
}

function onboardCard() {
  return `
    <div class="onboard">
      <div class="ob-top">
        <span class="ob-emoji">🌗</span>
        <div>
          <div class="ob-title">欢迎来朝夕</div>
          <div class="ob-sub">这里是可点击的原型，数据都是示例</div>
        </div>
      </div>
      <ul class="ob-list">
        <li><b>🔒 私密是默认</b>：新记一笔默认「仅我可见」，TA 看不到、不进任何统计</li>
        <li><b>💗 共享要主动开</b>：打开开关后记的账，两个人都能看到</li>
        <li><b>👆 先试试这个</b>：点底部粉色 <b>＋</b> 记一笔，再点账目里的
          <b>🔒 楼下咖啡</b> 看私密账目的样子</li>
      </ul>
      <button class="btn btn-secondary btn-sm mt-3" data-action="dismiss-onboard">知道啦</button>
    </div>`;
}

function daysInMonthLeft() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return last - now.getDate();
}

/** 首页的分类预算提醒条 —— 只在真的有分类接近/超出预算时出现。文案中性。 */
function budgetAlertBar() {
  const alerts = budgetAlerts(currentMonth());
  if (!alerts.length) return '';
  const over = alerts.filter(a => a.status === 'over');
  const names = alerts.slice(0, 3).map(a => cat(a.catId).name).join('、');

  if (over.length) {
    const worst = over[0];
    return `
      <div class="alert-bar" data-action="edit-cat-budget">
        <span>💡</span>
        <span><b>${names}</b> 这个月超过分类预算了。
          ${cat(worst.catId).name}超了 ¥${money(worst.used - worst.budget, false)}，
          下个月我们一起注意～</span>
      </div>`;
  }
  return `
    <div class="alert-bar" data-action="edit-cat-budget">
      <span>💡</span>
      <span><b>${names}</b> 快到分类预算上限了，还剩 ¥${
        money(alerts.reduce((s, a) => s + a.left, 0), false)}，我们一起看着点～</span>
    </div>`;
}

function goalDaysText(goal, saved) {
  if (saved >= goal.target) return '攒够啦 🎉';
  if (!goal.deadline) return `还差 ¥${money(goal.target - saved, false)}`;
  const days = Math.ceil((new Date(goal.deadline) - new Date()) / 86400000);
  if (days < 0) return `已过期 · 还差 ¥${money(goal.target - saved, false)}`;
  const need = Math.ceil((goal.target - saved) / Math.max(1, days));
  return `还差 ¥${money(goal.target - saved, false)} · 还有 ${days} 天（每天约 ${money(need, false)}）`;
}

function budgetHint(used, budget, daysLeft) {
  const left = budget - used;
  const pct = used / budget;
  if (pct >= 1) return `这个月用超了一点点（超 ¥${money(used - budget, false)}），下个月我们一起注意～`;
  if (pct > 0.9) return `只剩 ¥${money(left, false)} 了，还有 ${daysLeft} 天，悠着点呀`;
  if (pct > 0.7) return `还剩 ¥${money(left, false)}，还有 ${daysLeft} 天，节奏刚好`;
  return `还剩 ¥${money(left, false)}，按现在节奏完全够用 ✨`;
}

/* ==========================================================================
   页面：账目列表
   ========================================================================== */

function screenRecords() {
  const all = visibleRecords()
    .filter(r => r.date.startsWith(app.month))
    .filter(r => app.filter === 'all' ? true : r.visibility === app.filter)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

  const groups = {};
  for (const r of all) (groups[r.date] = groups[r.date] || []).push(r);
  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  // 头部金额：跟着当前筛选走 —— 否则在「只有我」下会永远显示 0。
  // all 已经按可见性筛选过（私密账目只有本人可见），这里再按当前筛选聚合。
  const monthExpense = all
    .filter(r => r.type === 'expense')
    .reduce((s, r) => s + r.amount, 0);

  // 说清楚这个数字是什么口径，避免"首页和账目页数字不一样"的困惑
  const scopeLabel = app.filter === 'all'
    ? '本月合计'
    : (app.filter === 'shared' ? '我们共' : '🔒 只有我');

  return `
    <div class="topbar">
      <div>
        <div class="tb-title">账目</div>
        <div class="tb-sub">${monthLabel(app.month)} · ${scopeLabel} ¥${money(monthExpense, false)}</div>
      </div>
      <div class="tb-actions">
        <button class="icon-btn" data-action="prev-month" aria-label="上个月">‹</button>
        <button class="icon-btn" data-action="next-month" aria-label="下个月">›</button>
      </div>
    </div>

    <div class="chips">
      ${chip('all', '全部')}${chip('shared', '只有我们')}${chip('private', '🔒 只有我')}
    </div>

    ${dates.length ? dates.map(d => {
      const list = groups[d];
      const sum = list.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      return `
        <div class="day-group">
          <div class="day-head">
            <span>${dayLabel(d)}</span>
            <span class="dh-sum">${sum ? '¥' + money(sum, false) : ''}</span>
          </div>
          ${list.map(r => recRow(r)).join('')}
        </div>`;
    }).join('') : emptyState('📒', '这个月还没有账目', '记下第一笔，我们一起开始', '记一笔', 'open-add')}
  `;
}

function chip(key, label) {
  return `<button class="chip ${app.filter === key ? 'on' : ''}" data-filter="${key}">${label}</button>`;
}

/* ==========================================================================
   页面：目标
   ========================================================================== */

function screenGoals() {
  // 🔑 排除软删除的（deletedAt）和已归档的（archived）——
  //    少了 deletedAt 这个条件，删掉的目标还会留在列表里。
  const goals = state.goals.filter(g => !g.deletedAt && g.status !== 'archived');
  const totalSaved = goals.reduce((s, g) => s + goalSaved(g.id), 0);
  const totalTarget = goals.reduce((s, g) => s + g.target, 0);

  return `
    <div class="topbar">
      <div>
        <div class="tb-title">一起攒钱</div>
        <div class="tb-sub">共攒了 ¥${money(totalSaved, false)} / ${money(totalTarget, false)}</div>
      </div>
    </div>

    ${goals.length ? goals.map(g => {
      const saved = goalSaved(g.id);
      const p = saved / g.target;
      const done = p >= 1;
      const recent = state.records
        .filter(r => !r.deletedAt && r.goalId === g.id)
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 2);
      return `
        <div class="goal-item ${done ? 'done' : ''}">
          <div class="goal-top">
            <div class="goal-emoji">${g.icon}</div>
            <div class="goal-info">
              <div class="goal-name">${esc(g.name)}</div>
              <div class="goal-meta">${done ? '攒够啦 🎉' : `${Math.round(p * 100)}% · ${goalDaysText(g, saved)}`}</div>
            </div>
            ${ring(p, 62, 8, done)}
          </div>
          <div class="bar mt-3"><div class="bar-fill"
               style="width:${Math.min(100, p * 100)}%;${done ? 'background:linear-gradient(90deg,#8FD3B6,#B6E8CE)' : ''}"></div></div>
          <div class="goal-amt">已攒 <strong>¥${money(saved, false)}</strong> / ${money(g.target, false)}</div>
          ${recent.length ? `<div class="muted mt-2">最近存入：${recent.map(r =>
            `${dayLabel(r.date)} ¥${money(r.amount, false)}`).join(' · ')}</div>` : ''}
          <div class="goal-actions">
            <button class="btn btn-primary btn-sm" data-action="deposit" data-goal="${g.id}">
              ${done ? '再存一点' : '存入一笔'}
            </button>
            <button class="btn btn-secondary btn-sm" data-action="goal-detail" data-goal="${g.id}">明细</button>
          </div>
        </div>`;
    }).join('') : emptyState('🎯', '还没有共同目标', '一起攒一笔钱，去做点什么吧', '新建目标', 'open-goal')}

    <button class="btn btn-secondary mt-3" data-action="open-goal">＋ 新建共同目标</button>
  `;
}

/* ==========================================================================
   页面：统计
   ========================================================================== */

function screenStats() {
  const m = app.month;
  const scope = app.statScope;
  const st = monthlyStats(m, scope);
  const mono = trend(6, scope);
  const max = Math.max(...mono.map(x => x.value), 1);

  const byCat = st.byCat.slice(0, 6);
  const top = byCat[0];
  const topCat = top ? cat(top.catId) : null;

  return `
    <div class="topbar">
      <div>
        <div class="tb-title">统计</div>
        <div class="tb-sub">${monthLabel(m)}</div>
      </div>
      <div class="tb-actions">
        <button class="icon-btn" data-action="prev-month" aria-label="上个月">‹</button>
        <button class="icon-btn" data-action="next-month" aria-label="下个月">›</button>
      </div>
    </div>

    <div class="seg">
      <div class="seg-item ${scope === 'shared' ? 'on' : ''}" data-scope="shared">我们共同</div>
      <div class="seg-item ${scope === 'mine' ? 'on' : ''}" data-scope="mine">仅我自己</div>
    </div>

    <div class="hero">
      <div class="hero-label">${scope === 'shared' ? '我们一起花了' : '我自己花了'}</div>
      <div class="hero-amount"><span class="cur">¥</span>${money(st.total)}</div>
      <div class="hero-split">
        <div class="hs-item">
          <div class="hs-k">我付的</div>
          <div class="hs-v">¥${money(st.paidByMe, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">${esc(state.partner.nickname)}付的</div>
          <div class="hs-v">¥${money(st.paidByPartner, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">共 ${st.count} 笔</div>
          <div class="hs-v"></div>
        </div>
      </div>
    </div>

    ${byCat.length ? `
      <div class="card">
        <div class="card-title"><span>花在哪了</span><span class="ct-link">共 ${st.count} 笔</span></div>
        <div class="donut-wrap">
          <div class="ring" style="width:120px;height:120px">
            <canvas id="donut" width="240" height="240" style="width:120px;height:120px"></canvas>
            <div class="donut-center">
              <div class="dc-k">合计</div>
              <div class="dc-v">¥${money(st.total, false)}</div>
            </div>
          </div>
          <div class="legend">
            ${byCat.map(c => {
              const cd = cat(c.catId);
              return `<div class="legend-item">
                <span class="legend-dot" style="background:${cd.color}"></span>
                <span class="legend-name">${cd.icon} ${cd.name}</span>
                <span class="legend-val">${Math.round(c.amount / (st.total || 1) * 100)}%</span>
              </div>`;
            }).join('')}
          </div>
        </div>
        ${topCat ? `<div class="insight">💡 <span>${topCat.name}占了 ${Math.round(top.amount / (st.total || 1) * 100)}%，是${monthLabel(m)}的最大头</span></div>` : ''}
      </div>` : emptyState('📊', '这个月还没有数据', '记几笔就能看到图啦', '记一笔', 'open-add')}

    <div class="card">
      <div class="card-title"><span>近 6 个月趋势</span></div>
      <div class="trend">
        ${mono.map(x => `
          <div class="trend-col">
            <div class="trend-bar ${x.month === m ? 'on' : ''}"
                 style="height:${Math.max(4, x.value / max * 100)}%"></div>
            <div class="trend-lbl ${x.month === m ? 'on' : ''}">${x.label}</div>
          </div>`).join('')}
      </div>
    </div>

    ${byCat.length ? `
      <div class="card">
        <div class="card-title"><span>分类排行</span></div>
        ${st.byCat.map(c => {
          const cd = cat(c.catId);
          return `
            <div class="rank-row">
              <div class="rank-head">
                <span>${cd.icon} ${cd.name} <span class="muted">${c.count} 笔</span></span>
                <span class="rk-pct">¥${money(c.amount, false)}</span>
              </div>
              <div class="bar"><div class="bar-fill" style="width:${c.amount / (st.byCat[0].amount || 1) * 100}%;
                   background:${cd.color}"></div></div>
            </div>`;
        }).join('')}
      </div>` : ''}

    ${scope === 'shared' ? payerCard(m) : ''}
    ${catBudgetCard()}
  `;
}

/** 谁付的钱 —— 不做 AA，所以这里只陈述事实，不算谁欠谁 */
function payerCard(month) {
  const st = monthlyStats(month, 'shared');
  if (!st.total) return '';
  const mePct = Math.round(st.paidByMe / st.total * 100);
  const taPct = 100 - mePct;
  return `
    <div class="card">
      <div class="card-title"><span>这个月谁付的</span></div>
      <div class="bar" style="display:flex;height:10px">
        <div style="width:${mePct}%;background:linear-gradient(90deg,#F5A3A3,#F9C784);border-radius:999px"></div>
        <div style="width:${taPct}%;background:#C9B6E4;border-radius:999px;margin-left:2px"></div>
      </div>
      <div class="hero-split mt-3">
        <div class="hs-item">
          <div class="hs-k">我付的 · ${mePct}%</div>
          <div class="hs-v">¥${money(st.paidByMe, false)}</div>
        </div>
        <div class="hs-item">
          <div class="hs-k">${esc(state.partner.nickname)}付的 · ${taPct}%</div>
          <div class="hs-v">¥${money(st.paidByPartner, false)}</div>
        </div>
      </div>
      <div class="muted mt-3">只是记录谁掏的钱，不计算谁欠谁 —— 我们的钱是一起的。</div>
    </div>`;
}

/** 分类预算卡片 */
function catBudgetCard() {
  const usage = allCatBudgetUsage(app.month);
  const totalBudget = usage.reduce((s, u) => s + u.budget, 0);
  const totalUsed = usage.reduce((s, u) => s + u.used, 0);

  if (!usage.length) {
    return `
      <div class="card">
        <div class="card-title">
          <span>分类预算</span>
          <span class="ct-link" data-action="edit-cat-budget">去设置 ›</span>
        </div>
        <div class="muted" style="line-height:1.7">
          还没设置分类预算。<br>
          给「餐饮」「购物」这类容易超的分类定个上限，超了两个人一起知道。
        </div>
        <button class="btn btn-secondary btn-sm mt-3" data-action="edit-cat-budget">设置分类预算</button>
      </div>`;
  }

  return `
    <div class="card">
      <div class="card-title">
        <span>分类预算</span>
        <span class="ct-link" data-action="edit-cat-budget">调整 ›</span>
      </div>
      ${usage.map(u => {
        const cd = cat(u.catId);
        const over = u.pct >= 1;
        return `
          <div class="budget-item">
            <div class="budget-head">
              <span class="bh-name">${cd.icon} ${cd.name}</span>
              <span class="bh-val">
                ¥${money(u.used, false)} / ${money(u.budget, false)}
                <span style="color:${over ? 'var(--coral)' : 'var(--ink-soft)'}">${Math.round(u.pct * 100)}%</span>
              </span>
            </div>
            <div class="bar">
              <div class="bar-fill ${u.status === 'over' ? 'over' : u.status === 'warn' ? 'warn' : ''}"
                   style="width:${Math.min(100, u.pct * 100)}%"></div>
            </div>
            <div class="budget-hint">${catBudgetHint(u)}</div>
          </div>`;
      }).join('')}
      <div class="budget-total">
        <span>分类预算合计</span>
        <span><b>¥${money(totalUsed, false)}</b> / ${money(totalBudget, false)}</span>
      </div>
      <div class="muted mt-3" style="line-height:1.6">
        🔒 预算只统计「我们共同的」支出，你自己记的私密账目不计入——
        这样你不会因为怕超预算而不敢记账。
      </div>
    </div>`;
}

function catBudgetHint(u) {
  const cd = cat(u.catId);
  if (u.status === 'over') return `${cd.name}用超了 ¥${money(u.used - u.budget, false)}，下个月一起注意～`;
  if (u.status === 'warn') return `只剩 ¥${money(u.left, false)} 了，悠着点呀`;
  return `还剩 ¥${money(u.left, false)}，节奏刚好`;
}

/** 环形图（Canvas 手绘，零依赖） */
function drawDonut() {
  const cv = $('#donut');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const st = monthlyStats(app.month, app.statScope);
  const data = st.byCat.slice(0, 6);
  const size = 240, cx = size / 2, cy = size / 2;
  const outer = 112, inner = 69;   // 内径 62%
  ctx.clearRect(0, 0, size, size);
  if (!data.length) return;

  const total = data.reduce((s, d) => s + d.amount, 0) || 1;
  let angle = -Math.PI / 2;

  for (const d of data) {
    const sweep = d.amount / total * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, angle, angle + sweep);
    ctx.arc(cx, cy, inner, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = cat(d.catId).color;
    ctx.fill();
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--surface').trim() || '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.stroke();
    angle += sweep;
  }
}

/* ==========================================================================
   页面：我的
   ========================================================================== */

function screenMe() {
  const goals = state.goals.filter(g => g.status === 'active').length;
  const privCount = state.records.filter(r =>
    !r.deletedAt && r.visibility === 'private' && r.creatorId === state.me.id).length;
  const theme = getTheme();

  return `
    <div class="topbar"><div><div class="tb-title">我的</div></div></div>

    <div class="couple-card">
      <div class="avatar">${state.me.avatar}</div>
      <div class="couple-heart">💗</div>
      <div class="avatar partner">${state.partner.avatar}</div>
      <div class="couple-info">
        <div class="couple-names">${esc(state.me.nickname)} & ${esc(state.partner.nickname)}</div>
        <div class="couple-days">${boundDaysText()} · ${goals} 个目标进行中</div>
      </div>
    </div>

    <div class="section-label">外观</div>
    <div class="card">
      <div class="theme-picker">
        ${THEMES.map(t => `
          <button class="theme-opt ${theme === t.id ? 'on' : ''}" data-theme-opt="${t.id}">
            <span class="to-ico">${t.icon}</span>
            <span class="to-name">${t.label}</span>
          </button>`).join('')}
      </div>
    </div>

    <div class="section-label">设置</div>
    <div class="card">
      <div class="row" data-action="open-setup">
        <span class="row-ico">✏️</span>
        <div class="row-body"><div class="row-k">改一下称呼和头像</div>
          <div class="row-sub">现在显示的是 ${esc(state.me.nickname)} & ${esc(state.partner.nickname)}</div></div>
        <span class="row-arrow">›</span>
      </div>
      <div class="row" data-action="open-goal">
        <span class="row-ico">🎯</span>
        <div class="row-body"><div class="row-k">共同目标</div>
          <div class="row-sub">一起攒钱去做点什么</div></div>
        <div class="row-v">${goals} 个</div><span class="row-arrow">›</span>
      </div>
      <div class="row" data-action="open-budget">
        <span class="row-ico">📊</span>
        <div class="row-body"><div class="row-k">每月共同预算</div>
          <div class="row-sub">超支时两个人一起知道</div></div>
        <div class="row-v">¥${money(state.couple.monthlyBudget || 0, false)}</div>
        <span class="row-arrow">›</span>
      </div>
      <div class="row" data-action="edit-cat-budget">
        <span class="row-ico">🏷️</span>
        <div class="row-body"><div class="row-k">分类预算</div>
          <div class="row-sub">餐饮、购物这些容易超的分类</div></div>
        <div class="row-v">${allCatBudgetUsage().length} 个</div>
        <span class="row-arrow">›</span>
      </div>
      <div class="row" data-action="open-couple">
        <span class="row-ico">💌</span>
        <div class="row-body"><div class="row-k">情侣绑定</div>
          <div class="row-sub">邮箱登录 · 邀请码绑定</div></div>
        <div class="row-v">已绑定</div><span class="row-arrow">›</span>
      </div>
    </div>

    <div class="section-label">关于隐私</div>
    <div class="note">
      你现在有 <strong>${privCount} 笔</strong>私密账目。<br>
      🔒 <strong>仅我可见</strong>的账目，TA 看不到、不会出现在 TA 的统计里。<br>
      💗 <strong>共享</strong>的账目，我们两个都能看到。<br>
      每一笔都默认「仅我可见」，共享需要你自己打开——不会有任何账目被自动公开。
    </div>

    <div class="section-label">同步状态</div>
    <div class="card">
      <div class="row" data-action="${syncAction()}">
        <span class="row-ico">${syncIcon()}</span>
        <div class="row-body">
          <div class="row-k">${syncTitle()}</div>
          <div class="row-sub">${syncSub()}</div>
        </div>
        <span class="row-arrow">›</span>
      </div>
      ${syncQueueRow()}
      ${syncErrorRow()}
      ${uploadLocalRow()}
    </div>

    ${ledgerAuditCard()}

    <div class="section-label">数据</div>
    <div class="card">
      <div class="row" data-action="reset">
        <span class="row-ico">♻️</span>
        <div class="row-body"><div class="row-k">清空本机账目</div>
          <div class="row-sub">把本机恢复成空账本（云端和 TA 那边不受影响）</div></div>
        <span class="row-arrow">›</span>
      </div>
      <div class="row" data-action="wipe">
        <span class="row-ico">🧹</span>
        <div class="row-body"><div class="row-k">彻底重置本机</div>
          <div class="row-sub">清掉登录状态和所有本地数据，页面异常时用</div></div>
        <span class="row-arrow">›</span>
      </div>
    </div>

    <div class="tc muted mt-6" style="padding-bottom:20px">
      朝夕 Husafe ${BUILD}<br>数据存在本机浏览器，并同步到你们的云端
    </div>
  `;
}

/** 同步状态（用于「我的」页，方便一眼判断连上没） */
function syncIcon() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline()) return '📴';
  if (!s.isSignedIn()) return '🔑';
  if (s.queueLength() > 0) return '⏳';
  if (!s.getCoupleId()) return '🔗';
  return '☁️';
}
function syncTitle() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline()) return '未连接云端';
  if (!s.isSignedIn()) return '已配置，未登录';
  if (s.queueLength() > 0) return '有内容待同步';
  if (!s.getCoupleId()) return '还没绑定情侣空间';
  return '已登录云端';
}
function syncSub() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline()) {
    return '现在是纯本地模式，只能记在这台设备上';
  }
  if (!s.isSignedIn()) return '点这里用邮箱登录，登录后和 TA 共用一本账';
  const q = s.queueLength();
  if (q > 0) return `待同步 ${q} 笔 · 点这里立即重试`;
  if (!s.getCoupleId()) return '还没绑定情侣空间，先用邀请码绑定';

  // 说明同步方式：实时推送通了就是秒级，否则靠轮询（最多 15 秒）
  const alive = typeof s.isRealtimeAlive === 'function' && s.isRealtimeAlive();
  return alive
    ? '已连接 · 对方记账会立刻出现'
    : '已连接 · 每 15 秒自动刷新（对方改动最多延迟 15 秒）';
}
/** 点击同步卡时该做什么 */
function syncAction() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline() || !s.isSignedIn()) return 'open-couple';
  if (s.queueLength() > 0 && s.getCoupleId()) return 'retry-sync';
  return 'open-couple';
}

/**
 * 账本健康检查。
 *
 * 排错时最有用的一块：把「谁记了多少笔、其中多少是私密」摊开，
 * 任何归属错位（比如私密账记到了对方名下）一眼就能看出来。
 */
function ledgerAudit() {
  const recs = state.records.filter(r => !r.deletedAt);
  const count = key => recs.filter(r => r.creatorId === key).length;
  const priv = key => recs.filter(r => r.creatorId === key && r.visibility === 'private').length;

  const meN = count(state.me.id), meP = priv(state.me.id);
  const taN = count(state.partner.id), taP = priv(state.partner.id);

  // 归属不明的记录：creatorId 既不是我也不是 TA
  const orphans = recs.filter(r =>
    r.creatorId !== state.me.id && r.creatorId !== state.partner.id);

  return { total: recs.length, meN, meP, taN, taP, orphans: orphans.length };
}

function ledgerAuditCard() {
  const a = ledgerAudit();
  const meName = esc(state.me.nickname);
  const taName = esc(state.partner.nickname);
  const susp = a.orphans > 0 || a.meP > 0 && a.taP > 0 &&
    a.orphans === 0 && false;   // 有孤儿记录才警告

  return `
    <div class="section-label">账本明细</div>
    <div class="card">
      <div class="row" style="align-items:flex-start">
        <span class="row-ico">📋</span>
        <div class="row-body">
          <div class="row-k">共 ${a.total} 笔账目</div>
          <div class="row-sub" style="white-space:normal;line-height:1.7">
            ${meName}记了 <b>${a.meN}</b> 笔（其中私密 ${a.meP} 笔）<br>
            ${taName}记了 <b>${a.taN}</b> 笔（其中私密 ${a.taP} 笔）
          </div>
        </div>
      </div>
      ${a.orphans > 0 ? `
        <div class="row" style="align-items:flex-start">
          <span class="row-ico">⚠️</span>
          <div class="row-body">
            <div class="row-k" style="color:var(--coral)">有 ${a.orphans} 笔归属不明</div>
            <div class="row-sub" style="white-space:normal;line-height:1.6">
              这些记录的记账人既不是你也不是 TA —— 很可能是原型自带的示例数据。
              建议点下面「清空本地数据并重载」清掉，避免跟真账目混在一起。
            </div>
          </div>
        </div>` : ''}
      <div class="row" data-action="clear-local-records">
        <span class="row-ico">🧹</span>
        <div class="row-body">
          <div class="row-k">清空本机账目</div>
          <div class="row-sub">只清这台设备，云端和 TA 那边不受影响</div>
        </div>
        <span class="row-arrow">›</span>
      </div>
    </div>`;
}
/** 有待同步内容时，单独给一个明确的重试入口 */
function syncQueueRow() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline() || !s.isSignedIn() || s.queueLength() === 0) return '';
  return `
    <div class="row" data-action="retry-sync">
      <span class="row-ico">🔄</span>
      <div class="row-body">
        <div class="row-k">立即重试上传</div>
        <div class="row-sub">有 ${s.queueLength()} 笔还没推上云端，TA 现在还看不到</div>
      </div>
      <span class="row-arrow">›</span>
    </div>`;
}

/**
 * 手动把本机数据推上云端。
 *
 * 自动补传（登录时）失败时的兜底入口 —— 给用户一个"我自己点一下试试"的选择，
 * 比让他对着"数据没同步"干等要好。
 */
function uploadLocalRow() {
  const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  if (!s || !s.isOnline() || !s.isSignedIn()) return '';
  return `
    <div class="row" data-action="upload-local">
      <span class="row-ico">☁️</span>
      <div class="row-body">
        <div class="row-k">把本机数据推上云端</div>
        <div class="row-sub">如果 TA 那边看不到你记的账，点这里强制同步一次</div>
      </div>
      <span class="row-arrow">›</span>
    </div>`;
}

/**
 * 显示最近一次同步失败的原因。
 * 排错时这个比翻控制台方便得多 —— 直接截图就能定位问题。
 */
function syncErrorRow() {
  const msg = typeof getLastSyncError === 'function' ? getLastSyncError() : null;
  if (!msg) return '';
  return `
    <div class="row" style="align-items:flex-start">
      <span class="row-ico">⚠️</span>
      <div class="row-body">
        <div class="row-k" style="color:var(--coral)">上次同步失败的原因</div>
        <div class="row-sub" style="white-space:normal;word-break:break-all;line-height:1.6">${esc(msg)}</div>
      </div>
    </div>`;
}

/**
 * 「在一起第几天」。
 *
 * ⚠️ 只认从云端同步回来的真实绑定日期（state.couple.boundAtSynced）。
 *    本地种子里那个写死的日期不能用来显示 —— 否则会显示一个假的天数。
 */
function boundDaysText() {
  if (!state.couple.boundAtSynced || !state.couple.boundAt) {
    const s = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
    if (s && s.isOnline() && !s.isSignedIn()) return '登录后显示在一起的天数';
    if (s && s.isOnline() && s.isSignedIn()) return '正在同步绑定时间…';
    return '还没绑定情侣空间';
  }
  const days = Math.floor((Date.now() - new Date(state.couple.boundAt).getTime()) / 86400000);
  if (!isFinite(days)) return '在一起';
  if (days <= 0) return '今天刚绑定 💗';
  return `在一起第 ${days + 1} 天`;
}

/* ==========================================================================
   记账弹层
   ========================================================================== */

const addState = {
  amount: '',
  categoryId: 'food',
  date: isoDay(0),
  note: '',
  visibility: 'private',     // 默认私密 —— 隐私是默认，共享是动作
  payerId: state.me.id,
};

function openAdd() {
  Object.assign(addState, {
    amount: '', categoryId: 'food', date: isoDay(0), note: '',
    visibility: 'private', payerId: state.me.id,
  });
  renderSheet();
  $('#sheet').classList.add('open');
  $('#scrim').classList.add('open');
}

function closeAdd() {
  $('#sheet').classList.remove('open');
  $('#scrim').classList.remove('open');
  setTimeout(() => { const s = $('#sheet'); if (s) s.innerHTML = ''; }, 320);
}

function parseAmount() {
  const v = parseFloat(addState.amount);
  if (!v || isNaN(v) || v <= 0) return 0;
  return Math.round(v * 100);
}

/** 白话预览 —— 把这次记账的结果翻译成一句人话 */
function plainPreview() {
  const cents = parseAmount();
  if (!cents) return '输入金额后，这里会告诉你这笔账怎么算';

  const meName = state.me.nickname;
  const pName = state.partner.nickname;
  const amt = `¥${money(cents, false)}`;

  if (addState.visibility === 'private') {
    return `只有我能看到这笔 ${amt}，TA 不会知道，也不进共同统计和预算。`;
  }

  const payerName = addState.payerId === state.me.id ? meName : pName;
  return `${payerName}付了 ${amt}，算是我们一起花的——会进共同开销和预算。`;
}

function renderSheet() {
  const cents = parseAmount();
  const isPrivate = addState.visibility === 'private';

  $('#sheet').innerHTML = `
    <div class="sheet-head">
      <button class="btn btn-ghost" style="width:auto" data-action="close-add">取消</button>
      <div class="sheet-title">记一笔</div>
      <div style="width:52px"></div>
    </div>

    <div class="sheet-body">
      <div class="amount-display ${cents ? '' : 'zero'}">
        <span class="cur">¥</span>${cents ? money(cents) : '0.00'}
      </div>

      <div class="cat-grid">
        ${CATEGORIES.slice(0, 10).map(c => `
          <button class="cat-cell ${addState.categoryId === c.id ? 'on' : ''}" data-cat="${c.id}">
            <span class="cc-emoji">${c.icon}</span>
            <span class="cc-name">${c.name}</span>
          </button>`).join('')}
      </div>

      <div class="field mt-4">
        <div class="field-label">备注</div>
        <input class="input" id="note-input" placeholder="写点什么，比如「一起吃了火锅」"
               value="${esc(addState.note)}">
      </div>

      <div class="field">
        <div class="field-label">日期</div>
        <input class="input" type="date" id="date-input" value="${addState.date}">
      </div>

      <div class="card" style="box-shadow:none;background:var(--surface);border:1.5px solid var(--line)">
        <div class="row" style="padding-top:0">
          <span class="row-ico">${isPrivate ? '🔒' : '💗'}</span>
          <div class="row-body">
            <div class="row-k">${isPrivate ? '仅我可见' : '我们共享'}</div>
            <div class="row-sub">${isPrivate ? 'TA 看不到这笔，也不进任何统计' : '两个人都能看到这笔'}</div>
          </div>
          <div class="switch ${isPrivate ? '' : 'on'}" data-action="toggle-visibility"
               role="switch" aria-checked="${isPrivate ? 'false' : 'true'}"></div>
        </div>
      </div>

      ${!isPrivate ? `
        <div class="field mt-4">
          <div class="field-label">谁付的钱</div>
          <div class="opts">
            <button class="opt ${addState.payerId === state.me.id ? 'on' : ''}" data-payer="${state.me.id}">
              ${state.me.avatar} 我付的</button>
            <button class="opt ${addState.payerId === state.partner.id ? 'on' : ''}" data-payer="${state.partner.id}">
              ${state.partner.avatar} TA 付的</button>
          </div>
          <div class="muted mt-2">只是记一下谁掏的钱，不算谁欠谁</div>
        </div>` : ''}

      <div class="plain-preview mt-4">
        <span>💡</span><span>${plainPreview()}</span>
      </div>

      ${isPrivate ? `
        <div class="note mt-3">
          ✨ 想给 TA 一个惊喜？私密账目可以用来记录礼物的钱，
          在 TA 看到之前只属于你。等送出去之后，可以在账目详情里改成共享。
        </div>` : ''}
    </div>

    <div class="sheet-foot">
      <div class="keypad">
        ${['1','2','3','⌫','4','5','6','.','7','8','9','0'].map(k =>
          `<button class="key ${'⌫.'.includes(k) ? 'key-fn' : ''}" data-key="${k}">${k}</button>`
        ).join('')}
        <button class="key key-ok" data-action="save-record">记好<br>啦</button>
      </div>
    </div>
  `;
}

function handleKey(k) {
  if (k === '⌫') {
    addState.amount = addState.amount.slice(0, -1);
  } else if (k === '.') {
    // 只在还没有小数点时补一个；空值补成 '0.'
    if (!addState.amount.includes('.')) addState.amount = (addState.amount || '0') + '.';
  } else {
    const [, dec] = addState.amount.split('.');
    if (dec && dec.length >= 2) return;                    // 最多两位小数
    if (addState.amount === '0') addState.amount = k;      // 前导 0 被替换
    else if (addState.amount.replace('.', '').length >= 8) return;  // 最长 8 位
    else addState.amount += k;
  }
  // 只重绘金额显示与预览，避免整页重绘导致输入框失焦
  const disp = $('.amount-display');
  const cents = parseAmount();
  if (disp) {
    disp.className = 'amount-display' + (cents ? '' : ' zero');
    disp.innerHTML = `<span class="cur">¥</span>${cents ? money(cents) : '0.00'}`;
  }
  const pv = $('.plain-preview span:last-child');
  if (pv) pv.innerHTML = plainPreview();
}

function saveFromSheet() {
  const cents = parseAmount();
  if (!cents) { toast('先输入金额呀'); return; }

  const isPrivate = addState.visibility === 'private';
  const rec = {
    amount: cents,
    categoryId: addState.categoryId,
    date: addState.date,
    note: ($('#note-input')?.value || '').trim(),
    visibility: addState.visibility,
    payerId: isPrivate ? state.me.id : addState.payerId,
    creatorId: state.me.id,
    type: 'expense',
  };

  const res = addRecord(rec);
  if (!res.ok) { toast(res.errors[0]); return; }

  closeAdd();
  toast(isPrivate ? '记好啦 ✓ 只有你能看到' : '记好啦 ✓');
  render();
}

/* ==========================================================================
   弹层
   ========================================================================== */

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = html;
  m.classList.add('open');
  $('#scrim').classList.add('open');
}
function closeModal() {
  $('#modal').classList.remove('open');
  if (!$('#sheet').classList.contains('open')) $('#scrim').classList.remove('open');
}

function openRecordDetail(id) {
  const r = state.records.find(x => x.id === id);
  if (!r) return;
  const c = cat(r.categoryId);
  const isPrivate = r.visibility === 'private';
  const canEdit = r.creatorId === state.me.id;

  openModal(`
    <div class="modal-emoji">${c.icon}</div>
    <div class="modal-title">${esc(r.note || c.name)}</div>
    <div class="modal-desc">
      <div style="font-size:26px;font-weight:700;color:var(--ink);margin-bottom:8px">
        ¥${money(r.amount)}</div>
      ${c.name} · ${dayLabel(r.date)} · ${payerText(r)}
      <br>${isPrivate ? '🔒 仅我可见，TA 看不到这笔' : '💗 我们共享 · 算我们一起花的'}
      ${r.goalId ? '<br>🎯 存进了目标' : ''}
    </div>
    <div class="modal-actions">
      ${canEdit ? `
        <button class="btn btn-secondary btn-sm" style="flex:1" data-action="toggle-vis" data-rec="${r.id}">
          ${isPrivate ? '改为共享' : '改为私密'}</button>
        <button class="btn btn-danger btn-sm" style="flex:1" data-action="del-rec" data-rec="${r.id}">删除</button>`
      : `<button class="btn btn-secondary" data-action="close-modal">知道了</button>`}
    </div>
    <button class="btn btn-ghost mt-2" data-action="close-modal">关闭</button>
  `);
}

function openGoalModal() {
  openModal(`
    <div class="modal-emoji">🎯</div>
    <div class="modal-title">新建共同目标</div>
    <div class="modal-desc">一起攒一笔钱，去做点什么</div>
    <div class="field mt-4" style="text-align:left">
      <div class="field-label">目标名称</div>
      <input class="input" id="goal-name" placeholder="比如：北海道之旅">
    </div>
    <div class="field" style="text-align:left">
      <div class="field-label">目标金额（元）</div>
      <input class="input" id="goal-amount" type="number" inputmode="decimal" placeholder="12000">
    </div>
    <div class="field" style="text-align:left">
      <div class="field-label">截止日期（可选）</div>
      <input class="input" id="goal-deadline" type="date" value="${plusDays(90)}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" data-action="close-modal">取消</button>
      <button class="btn btn-primary" style="flex:1" data-action="save-goal">创建</button>
    </div>
  `);
}

function openDepositModal(goalId) {
  const g = state.goals.find(x => x.id === goalId);
  if (!g) return;
  const saved = goalSaved(g.id);
  openModal(`
    <div class="modal-emoji">${g.icon}</div>
    <div class="modal-title">存进「${esc(g.name)}」</div>
    <div class="modal-desc">已攒 ¥${money(saved, false)} / ${money(g.target, false)}</div>
    <div class="field mt-4" style="text-align:left">
      <div class="field-label">存入金额（元）</div>
      <input class="input" id="dep-amount" type="number" inputmode="decimal" placeholder="500">
    </div>
    <div class="field" style="text-align:left">
      <div class="field-label">谁存的</div>
      <div class="opts">
        <button class="opt on" data-dep-payer="${state.me.id}">${state.me.avatar} 我</button>
        <button class="opt" data-dep-payer="${state.partner.id}">${state.partner.avatar} TA</button>
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" data-action="close-modal">取消</button>
      <button class="btn btn-primary" style="flex:1" data-action="save-deposit" data-goal="${g.id}">存入</button>
    </div>
  `);
  $('#modal').dataset.payer = state.me.id;
}

function openBudgetModal() {
  openModal(`
    <div class="modal-emoji">📊</div>
    <div class="modal-title">每月共同预算</div>
    <div class="modal-desc">预算只提醒「我们」，不做单人消费考核</div>
    <div class="field mt-4" style="text-align:left">
      <div class="field-label">每月共同预算（元）</div>
      <input class="input" id="budget-amount" type="number" inputmode="decimal"
             value="${(state.couple.monthlyBudget || 0) / 100}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" data-action="close-modal">取消</button>
      <button class="btn btn-primary" style="flex:1" data-action="save-budget">保存</button>
    </div>
  `);
}

/**
 * 分类预算编辑弹层
 * 默认值取该分类近 3 个月的最高支出，向上取整到 10 元 ——
 * 空输入框是设置类功能最大的流失点。
 */
function openCatBudgetModal() {
  const rows = CATEGORIES.map(c => {
    const cur = catBudget(c.id);
    const sug = suggestCatBudget(c.id);
    const used = monthlyStats(app.month, 'shared').byCat.find(x => x.catId === c.id)?.amount || 0;
    const placeholder = sug ? `建议 ${sug / 100}` : '不限';
    return `
      <div class="budget-edit ${cur ? 'on' : ''}" data-budget-row="${c.id}">
        <div class="be-ico">${c.icon}</div>
        <div class="be-name">
          ${c.name}
          <div class="be-suggest">本月已花 ¥${money(used, false)}${sug ? ` · 近3月最高 ¥${money(sug, false)}` : ''}</div>
        </div>
        <input class="be-input" type="number" inputmode="decimal"
               data-budget-input="${c.id}"
               placeholder="${placeholder}"
               value="${cur ? cur / 100 : ''}">
      </div>`;
  }).join('');

  const total = allCatBudgetUsage(app.month).reduce((s, u) => s + u.budget, 0);

  openModal(`
    <div class="modal-emoji">🏷️</div>
    <div class="modal-title">分类预算</div>
    <div class="modal-desc">留空表示不限。预算只算「我们共同的」支出</div>
    <div class="budget-total mt-4">
      <span>当前分类预算合计</span>
      <span><b>¥${money(total, false)}</b> / 月</span>
    </div>
    <div style="text-align:left;max-height:300px;overflow:auto">
      ${rows}
    </div>
    <div class="modal-actions">
      <button class="btn btn-secondary" style="flex:1" data-action="close-modal">取消</button>
      <button class="btn btn-primary" style="flex:1" data-action="save-cat-budget">保存</button>
    </div>
  `);
}

function collectCatBudgets() {
  const result = [];
  $$('[data-budget-input]').forEach(inp => {
    const catId = inp.dataset.budgetInput;
    const v = parseFloat(inp.value || '0');
    result.push({ catId, amount: v > 0 ? Math.round(v * 100) : 0 });
  });
  return result;
}

/** 情侣绑定 / 登录（Supabase 未配置时降级为说明页） */
function openCoupleModal() {
  const sync = typeof HusafeSync !== 'undefined' ? HusafeSync : null;
  const online = !!(sync && sync.isOnline());
  const signedIn = !!(sync && sync.isSignedIn());

  // --- 未配置 Supabase：只做说明，并明确当前限制 ---
  if (!online) {
    openModal(`
      <div class="modal-emoji">💌</div>
      <div class="modal-title">情侣绑定</div>
      <div class="modal-desc">朝夕是两个人共用一本账，绑定后才算「我们」</div>
      <div class="mt-4" style="text-align:left">
        ${bindStep('1️⃣', '各自用邮箱注册登录', '邮箱 + 验证码，不需要手机号')}
        ${bindStep('2️⃣', '一方生成 6 位邀请码', '24 小时内有效，用过即失效')}
        ${bindStep('3️⃣', '另一方输入邀请码', '绑定成功，两个人的账就合在一起了')}
        ${bindStep('🔒', '私密账目永远不共享', '在服务器层就隔离，不是前端藏起来')}
      </div>
      <div class="alert-bar mt-3" style="margin-bottom:0">
        <span>⚠️</span>
        <span><b>当前还没接后端</b>，你和 TA 各自的手机上是
          <b>两份独立的数据</b>，互相看不到。
          要真正共享需要先配好 Supabase（见 supabase/README-接入指南.md）。</span>
      </div>
      <button class="btn btn-secondary mt-4" data-action="close-modal">知道了</button>
    `);
    return;
  }

  // --- 已配置但未登录：登录 ---
  if (!signedIn) {
    const mode = app.loginMode || 'password';   // password（推荐） | otp
    openModal(`
      <div class="modal-emoji">✉️</div>
      <div class="modal-title">登录</div>
      <div class="modal-desc">两个人各自登录，然后用邀请码绑定</div>

      <div class="seg mt-4">
        <div class="seg-item ${mode === 'password' ? 'on' : ''}" data-login-mode="password">邮箱 + 密码</div>
        <div class="seg-item ${mode === 'otp' ? 'on' : ''}" data-login-mode="otp">邮箱验证码</div>
      </div>

      ${mode === 'password' ? `
        <div class="field" style="text-align:left">
          <div class="field-label">邮箱</div>
          <input class="input" id="login-email" type="email" inputmode="email"
                 placeholder="you@example.com">
        </div>
        <div class="field" style="text-align:left">
          <div class="field-label">密码</div>
          <input class="input" id="login-pass" type="password" placeholder="至少 6 位">
        </div>
        <div class="note" style="text-align:left">
          💡 <b>推荐用这个。</b>邮箱 + 密码不需要邮件服务，
          免费版也能正常用。<br>
          如果还没有账号，去 Supabase 后台
          <b>Authentication → Users → Add user</b> 建两个账号，
          或者直接点下面的「注册」。
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" style="flex:1" data-action="sign-up-pass">注册</button>
          <button class="btn btn-primary" style="flex:1" data-action="sign-in-pass">登录</button>
        </div>
      ` : `
        <div class="field" style="text-align:left">
          <div class="field-label">邮箱</div>
          <input class="input" id="login-email" type="email" inputmode="email"
                 placeholder="you@example.com">
        </div>
        <div class="field" style="text-align:left">
          <div class="field-label">验证码（先点下面的「发验证码」）</div>
          <input class="input" id="login-code" inputmode="numeric" placeholder="6 位数字">
        </div>
        <div class="alert-bar" style="margin-bottom:0">
          <span>⚠️</span>
          <span><b>需要自定义 SMTP 才能给非项目成员发信。</b>
            免费版的默认邮件服务每小时只允许 2 封，且只能发给项目成员邮箱 ——
            这意味着你女朋友收不到验证码。建议改用「邮箱 + 密码」。</span>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" style="flex:1" data-action="send-otp">发验证码</button>
          <button class="btn btn-primary" style="flex:1" data-action="verify-otp">登录</button>
        </div>
      `}

      <button class="btn btn-ghost mt-2" data-action="close-modal">稍后</button>
    `);
    return;
  }

  // --- 已登录：绑定状态 ---
  const uid = sync.currentUserId() || '';
  openModal(`
    <div class="modal-emoji">💗</div>
    <div class="modal-title">情侣绑定</div>
    <div class="modal-desc">已登录<br><span class="muted">${esc(uid.slice(0, 8))}…</span></div>

    <div class="field mt-4" style="text-align:left">
      <div class="field-label">生成邀请码给 TA</div>
      <button class="btn btn-secondary" data-action="gen-invite">生成 6 位邀请码</button>
    </div>

    <div class="field" style="text-align:left">
      <div class="field-label">或输入 TA 给你的邀请码</div>
      <div class="setup-row">
        <input class="input" id="invite-input" placeholder="比如 7K2M9P"
               style="text-transform:uppercase;letter-spacing:2px">
        <button class="btn btn-primary btn-sm" data-action="redeem-invite">绑定</button>
      </div>
    </div>

    <div class="note" style="text-align:left">
      🔒 绑定之后，你们能看到彼此的<b>共享</b>账目；
      标记为「仅我可见」的账目在服务器层就被隔离，对方永远拿不到。
    </div>

    <div class="modal-actions">
      <button class="btn btn-ghost" style="flex:1" data-action="sign-out">退出登录</button>
      <button class="btn btn-secondary" style="flex:1" data-action="close-modal">关闭</button>
    </div>
  `);
}

function bindStep(icon, title, sub) {
  return `
    <div class="row">
      <span class="row-ico">${icon}</span>
      <div class="row-body">
        <div class="row-k">${title}</div>
        <div class="row-sub">${sub}</div>
      </div>
    </div>`;
}

/* --- 登录 / 绑定动作 --- */

async function doSignInPassword() {
  const email = ($('#login-email')?.value || '').trim();
  const pass = $('#login-pass')?.value || '';
  if (!email || !email.includes('@')) { toast('填个正确的邮箱呀'); return; }
  if (!pass) { toast('填一下密码'); return; }
  toast('登录中…');
  const r = await HusafeSync.signInWithPassword(email, pass);
  if (!r.ok) { toast(r.reason); return; }
  closeModal(); render(); toast('登录成功 ✨');
  await pullAndMerge();
}

async function doSignUpPassword() {
  const email = ($('#login-email')?.value || '').trim();
  const pass = $('#login-pass')?.value || '';
  if (!email || !email.includes('@')) { toast('填个正确的邮箱呀'); return; }
  if (!pass || pass.length < 6) { toast('密码至少 6 位'); return; }
  toast('注册中…');
  const r = await HusafeSync.signUpWithPassword(email, pass);
  toast(r.reason || '注册成功，已登录 ✨');
  if (r.ok) { closeModal(); render(); await pullAndMerge(); }
}

async function doSendOtp() {
  const email = ($('#login-email')?.value || '').trim();
  if (!email || !email.includes('@')) { toast('填个正确的邮箱呀'); return; }
  toast('发送中…');
  const r = await HusafeSync.signInWithOtp(email);
  toast(r.ok ? '验证码发出去啦，去邮箱看看 ✉️' : r.reason);
}

async function doVerifyOtp() {
  const email = ($('#login-email')?.value || '').trim();
  const code = ($('#login-code')?.value || '').trim();
  if (!email || !code) { toast('邮箱和验证码都要填哦'); return; }
  const r = await HusafeSync.verifyOtp(email, code);
  if (!r.ok) { toast(r.reason); return; }
  closeModal();
  render();
  toast('登录成功 ✨');
  await pullAndMerge();
}

async function doGenInvite() {
  const r = await HusafeSync.createInviteCode();
  if (!r.ok) { toast(r.reason); return; }
  // 邀请码直接展示出来，方便念给对方或复制
  openModal(`
    <div class="modal-emoji">🎟️</div>
    <div class="modal-title">邀请码</div>
    <div class="modal-desc">把它发给 TA，让 TA 在「情侣绑定」里输入</div>
    <div style="text-align:center;font-size:34px;font-weight:700;letter-spacing:8px;
                margin:22px 0;color:var(--pink-deep);font-variant-numeric:tabular-nums">
      ${esc(r.code)}
    </div>
    <div class="note" style="text-align:left">
      ⏰ 24 小时内有效，用过一次就失效。<br>
      重新生成会让旧码立刻作废。
    </div>
    <button class="btn btn-secondary mt-4" data-action="open-couple">返回</button>
  `);
}

async function doRedeemInvite() {
  const code = ($('#invite-input')?.value || '').trim();
  if (!code) { toast('输入 TA 给你的邀请码'); return; }
  toast('绑定中…');
  const r = await HusafeSync.redeemInviteCode(code);
  if (!r.ok) { toast(r.reason); return; }
  closeModal();
  render();
  toast('绑定成功，我们是一本账啦 💗');
  await pullAndMerge();
}

/**
 * 从服务端拉全量数据并合并进本地。
 *
 * 注意顺序：先拿到 couple_id（推送时需要它），再拉账目。
 * 私密账目由 RLS 在服务端过滤，前端拿不到对方的私账。
 */
async function pullAndMerge() {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline()) return;

  // 先补 profile（里面有 couple_id 和双方 UUID），否则推送会因为
  // 缺少 couple_id / 身份没翻译而被拒绝（uuid 报错）
  const prof = await HusafeSync.fetchMyProfile();
  if (prof.ok) {
    if (prof.me) {
      // 🔑 「用户自己改的」优先于云端。
      //
      // 之前是无条件用云端值覆盖本地 —— 于是只要云端还是旧值
      //（推送失败过、或用户改完称呼才登录），每次登录都会把昵称打回去。
      // 表现就是「头像和昵称不随着登录更新」（其实是反方向被覆盖了）。
      if (state.me.profileEdited) {
        // 本地是用户亲手设的 → 把本地值推上去，别让云端覆盖
        HusafeSync.updateProfile({
          nickname: state.me.nickname,
          avatar: state.me.avatar,
        }).then(r => {
          if (r.ok) {
            state.me.profileEdited = false;   // 云端已对齐，之后可以正常拉取
            save();
          }
        }).catch(() => {});
      } else {
        if (prof.me.nickname) state.me.nickname = prof.me.nickname;
        if (prof.me.avatar) state.me.avatar = prof.me.avatar;
      }
      state.me.cloudId = prof.me.id;
    }

    // TA 的称呼只能从云端来（本机改不了对方的）
    if (prof.partner) {
      state.partner.cloudId = prof.partner.id;
      if (prof.partner.nickname) state.partner.nickname = prof.partner.nickname;
      if (prof.partner.avatar) state.partner.avatar = prof.partner.avatar;
    }
    // 把翻译表同步给数据层，供 isMe / isPartner 判断
    setCloudIdentities(prof.me ? prof.me.id : null, prof.partner ? prof.partner.id : null);
    save();
  }
  if (!HusafeSync.getCoupleId()) {
    toast('还没绑定情侣空间，先去「情侣绑定」用邀请码绑定');
  }

  // 同步情侣空间信息（绑定时间、共同预算）。
  // 之前漏了这一步，导致「绑定 N 天」一直用本地种子里写死的假日期。
  const cpl = await HusafeSync.fetchCouple();
  if (cpl.ok && cpl.couple) {
    if (cpl.couple.boundAt) {
      state.couple.boundAt = cpl.couple.boundAt;
      state.couple.boundAtSynced = true;      // 🔑 标记：这是真实日期，可以显示
    }
    if (typeof cpl.couple.monthlyBudget === 'number') {
      state.couple.monthlyBudget = cpl.couple.monthlyBudget;
    }
    if (cpl.couple.status) state.couple.status = cpl.couple.status;
    state.couple.id = cpl.couple.id || state.couple.id;
  }

  const r = await HusafeSync.pullAll();
  if (!r.ok) { toast('同步失败：' + r.reason); return; }

  if (r.me) {
    if (r.me.nickname) state.me.nickname = r.me.nickname;
    if (r.me.avatar) state.me.avatar = r.me.avatar;
  }
  if (Array.isArray(r.records)) {
    // 服务端为准：同 id 覆盖；本地独有且未同步的保留
    const byId = {};
    for (const rec of state.records) byId[rec.id] = rec;
    for (const rec of r.records) byId[rec.id] = rec;
    state.records = Object.values(byId);
  }
  // 目标合并：和账目同样的思路 —— 云端为准，同 id 覆盖，本地独有的保留。
  //
  // ⚠️ 之前写的是 `if (r.goals.length) state.goals = r.goals`，
  //    云端返回空数组时【根本不更新目标】—— 于是对方新建的目标永远拉不过来。
  if (Array.isArray(r.goals)) {
    const gById = {};
    for (const g of state.goals) gById[g.id] = g;
    for (const g of r.goals) gById[g.id] = g;
    state.goals = Object.values(gById).filter(g => !g.deletedAt);
  }
  save();

  // 🔑 登录后把「本地有、云端没有」的记录自动补传上去。
  //
  //    这是「换设备/先在本地记账再登录」的关键：
  //    之前这类记录只被"保留"，从不自动上传 —— 于是永远卡在本机，
  //    另一台设备看不到。
  //
  //    判据是 syncedAt 标记：从云端拉下来的有，本机新记的没有。
  const pend = HusafeSync.pendingUploads(state.records);
  if (pend.length) {
    const up = await HusafeSync.uploadPending(state.records, state.goals);
    if (up.ok && up.count > 0) {
      save();
      toast(`把本机的 ${up.count} 笔记录同步上去了 ☁️`);
    } else if (!up.ok) {
      console.warn('补传本地记录失败：', up.reason);
    }
  }

  // 关键：补推积压的账目。
  // 绑定之前记的账没有 couple_id，会卡在待同步队列里；
  // 现在 couple_id 有了，必须主动补推一次，否则队列永远不消。
  syncFlushQueue();

  render();
}

/* ==========================================================================
   首次设置：改成你们自己的名字
   ========================================================================== */

const AVATARS = ['🐻', '🦊', '🐱', '🐶', '🐰', '🐼', '🐨', '🦁', '🐯', '🐹', '🐧', '🦄', '🌸', '🌙', '⭐', '🍀'];

const setupState = { me: '🐻', partner: '🦊' };

/** 首次打开时引导设置称呼，避免看到「阿满 & 小鹿」以为是别人的数据 */
function openSetupModal(isFirstRun) {
  setupState.me = state.me.avatar || '🐻';
  setupState.partner = state.partner.avatar || '🦊';

  openModal(`
    <div class="modal-emoji">🌅</div>
    <div class="modal-title">先设置一下称呼吧</div>
    <div class="modal-desc">这只是个原型，数据只存在这台设备上</div>

    <div class="field mt-4" style="text-align:left">
      <div class="field-label">你的称呼</div>
      <div class="setup-row">
        <button class="avatar-pick" id="me-avatar">${setupState.me}</button>
        <input class="input" id="setup-me" placeholder="比如：小明" value="${esc(state.me.nickname)}">
      </div>
    </div>

    <div class="field" style="text-align:left">
      <div class="field-label">TA 的称呼</div>
      <div class="setup-row">
        <button class="avatar-pick" id="ta-avatar">${setupState.partner}</button>
        <input class="input" id="setup-ta" placeholder="比如：小红" value="${esc(state.partner.nickname)}">
      </div>
    </div>

    <div class="note" style="text-align:left">
      💡 现在是空账本，从第一笔开始记吧。<br>
      想清空重来可以点「我的 → 清空本机账目」。
    </div>

    <div class="modal-actions">
      ${isFirstRun
        ? `<button class="btn btn-ghost" style="flex:0 0 auto;width:auto;padding:0 12px" data-action="close-modal">先跳过</button>`
        : `<button class="btn btn-secondary" style="flex:1" data-action="close-modal">取消</button>`}
      <button class="btn btn-primary" style="flex:1" data-action="save-setup">就这样</button>
    </div>
  `);

  // 点头像循环切换（比弹一个 emoji 选择器轻得多）
  // 注意：必须判空，否则元素缺失时这里会抛异常并让整个启动流程中断
  const meBtn = $('#me-avatar');
  const taBtn = $('#ta-avatar');
  if (meBtn) meBtn.onclick = () => {
    setupState.me = nextAvatar(setupState.me);
    meBtn.textContent = setupState.me;
  };
  if (taBtn) taBtn.onclick = () => {
    setupState.partner = nextAvatar(setupState.partner);
    taBtn.textContent = setupState.partner;
  };
}

function nextAvatar(cur) {
  const i = AVATARS.indexOf(cur);
  return AVATARS[(i + 1) % AVATARS.length];
}

/** 打开首次设置时，如果还没设置过就自动弹 */
function maybeOpenSetup() {
  if (state.setupDone) return;
  openSetupModal(true);
}

/* ==========================================================================
   渲染
   ========================================================================== */

function screenFor(tab) {
  switch (tab) {
    case 'home':    return screenHome();
    case 'records': return screenRecords();
    case 'goals':   return screenGoals();
    case 'stats':   return screenStats();
    case 'me':      return screenMe();
    default:        return screenHome();
  }
}

function render() {
  const scr = $('#screen');
  if (!scr) throw new Error('找不到 #screen 容器，index.html 可能未正确加载');
  scr.innerHTML = `<div class="screen-enter">${screenFor(app.tab)}</div>`;
  renderTabbar();
  const ver = $('#build-tag');
  if (ver) ver.textContent = BUILD;
  if (app.tab === 'stats') requestAnimationFrame(drawDonut);
}

function renderTabbar() {
  const tb = $('#tabbar');
  if (!tb) return;
  tb.innerHTML = TABS.map(t => {
    if (t.id === 'add') {
      return `<div class="tab-add"><button class="add-btn" data-action="open-add" aria-label="记一笔">+</button></div>`;
    }
    const on = app.tab === t.id;
    return `<button class="tab ${on ? 'on' : ''}" data-tab="${t.id}">
      <span class="tab-ico">${t.icon}</span>
      <span>${t.label}</span>
      <span class="tab-dot"></span>
    </button>`;
  }).join('');
}

/* ==========================================================================
   事件绑定（统一委托）
   ========================================================================== */

document.addEventListener('click', e => {
  try {
    handleClick(e);
  } catch (err) {
    // 兜底：任何渲染/交互异常都要让用户看见，而不是「点了没反应」
    console.error('点击处理出错：', err);
    toast('出了点问题：' + (err && err.message ? err.message : '未知错误'));
  }
});

function handleClick(e) {
  const t = e.target;

  // --- Tab 切换 ---
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) { app.tab = tabBtn.dataset.tab; render(); return; }

  // --- 主题 ---
  const themeBtn = t.closest('[data-theme-opt]');
  if (themeBtn) { cycleTheme(themeBtn.dataset.themeOpt); return; }

  // --- 筛选 ---
  const chipEl = t.closest('[data-filter]');
  if (chipEl) { app.filter = chipEl.dataset.filter; render(); return; }

  // --- 统计口径 ---
  const segEl = t.closest('[data-scope]');
  if (segEl) { app.statScope = segEl.dataset.scope; render(); return; }

  // --- 登录方式切换 ---
  const lmEl = t.closest('[data-login-mode]');
  if (lmEl) { app.loginMode = lmEl.dataset.loginMode; openCoupleModal(); return; }

  // --- 键盘 ---
  const keyEl = t.closest('[data-key]');
  if (keyEl) { handleKey(keyEl.dataset.key); return; }

  // --- 记账表单 ---
  const catEl = t.closest('[data-cat]');
  if (catEl) { addState.categoryId = catEl.dataset.cat; renderSheet(); return; }

  const payerEl = t.closest('[data-payer]');
  if (payerEl) {
    addState.payerId = payerEl.dataset.payer;
    $$('[data-payer]').forEach(el => el.classList.toggle('on', el.dataset.payer === addState.payerId));
    const pv = $('.plain-preview span:last-child'); if (pv) pv.innerHTML = plainPreview();
    return;
  }


  const depPayerEl = t.closest('[data-dep-payer]');
  if (depPayerEl) {
    $('#modal').dataset.payer = depPayerEl.dataset.depPayer;
    $$('[data-dep-payer]').forEach(el =>
      el.classList.toggle('on', el.dataset.depPayer === depPayerEl.dataset.depPayer));
    return;
  }

  // --- 遮罩层内的操作优先于账目详情 ---
  const actEl = t.closest('[data-action]');
  if (actEl) { runAction(actEl, t); return; }

  // --- 账目详情 ---
  const recEl = t.closest('[data-rec]');
  if (recEl) { openRecordDetail(recEl.dataset.rec); return; }
}

function runAction(actEl, t) {
  const action = actEl.dataset.action;

  switch (action) {
    case 'open-add': openAdd(); break;
    case 'dismiss-onboard': state.onboarded = true; save(); render(); break;
    case 'close-add': closeAdd(); break;
    case 'save-record': saveFromSheet(); break;

    case 'toggle-visibility': {
      const isPrivate = addState.visibility === 'private';
      addState.visibility = isPrivate ? 'shared' : 'private';
      if (addState.visibility === 'private') {
        addState.payerId = state.me.id;
      }
      renderSheet();
      break;
    }

    case 'prev-month': app.month = shiftMonth(app.month, -1); render(); break;
    case 'next-month': {
      const next = shiftMonth(app.month, 1);
      if (next <= currentMonth()) { app.month = next; render(); }
      else toast('还没到未来呢～');
      break;
    }

    case 'go-goals': app.tab = 'goals'; render(); break;
    case 'go-stats': app.tab = 'stats'; render(); break;
    case 'go-stats-mine': app.tab = 'stats'; app.statScope = 'mine'; render(); break;
    case 'go-me': app.tab = 'me'; render(); break;

    case 'open-goal': openGoalModal(); break;
    case 'open-budget': openBudgetModal(); break;
    case 'open-couple': openCoupleModal(); break;
    case 'open-setup': openSetupModal(false); break;
    case 'edit-cat-budget': openCatBudgetModal(); break;
    case 'close-modal': closeModal(); break;

    // --- Supabase 登录 / 绑定（未配置时这些入口不会出现）---
    case 'sign-in-pass': doSignInPassword(); break;
    case 'sign-up-pass': doSignUpPassword(); break;
    case 'send-otp': doSendOtp(); break;
    case 'verify-otp': doVerifyOtp(); break;
    case 'gen-invite': doGenInvite(); break;
    case 'redeem-invite': doRedeemInvite(); break;

    case 'upload-local': {
      // 手动把本机还没同步的记录推上去（自动补传失败时的兜底）
      toast('正在上传…');
      HusafeSync.uploadPending(state.records, state.goals).then(r => {
        if (r.ok && r.count > 0) { save(); render(); }
        toast(r.ok
          ? (r.count > 0 ? `上传了 ${r.count} 笔 ☁️` : '没有需要上传的内容')
          : '上传失败：' + r.reason);
      });
      break;
    }

    case 'clear-local-records': {
      // 清掉本机账目；云端的不动，所以再拉一次就能拿回真实数据
      state.records = [];
      save();
      render();
      toast('已清空本机账目，正在从云端拉回…');
      pullAndMerge().catch(err => console.warn('拉取失败：', err));
      break;
    }
    case 'sign-out': {
      HusafeSync.signOut().then(() => {
        HusafeSync.unsubscribe();
        closeModal(); render(); toast('已退出登录');
      });
      break;
    }

    case 'retry-sync': {
      if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline() || !HusafeSync.isSignedIn()) {
        openCoupleModal();
        break;
      }
      const q = HusafeSync.queueLength();
      if (!q) { toast('没有待同步的内容'); break; }
      if (!HusafeSync.getCoupleId()) { toast('还没绑定情侣空间，先用邀请码绑定'); break; }
      toast(`正在补推 ${q} 笔…`);
      syncFlushQueue();
      setTimeout(() => {
        const left = HusafeSync.queueLength();
        toast(left === 0 ? '全部同步完成 ☁️' : `还剩 ${left} 笔没推上去`);
        render();
      }, 1500);
      break;
    }

    case 'save-setup': {
      const meName = ($('#setup-me')?.value || '').trim() || '我';
      const taName = ($('#setup-ta')?.value || '').trim() || 'TA';
      state.me.nickname = meName;
      state.me.avatar = setupState.me;
      state.partner.nickname = taName;
      state.partner.avatar = setupState.partner;
      state.setupDone = true;
      // 🔑 标记"这是用户亲手设的"，登录拉取时不许被云端旧值覆盖
      state.me.profileEdited = true;
      save();
      closeModal();
      render();
      toast(`好嘞，${meName} ✨`);

      // 推到云端。推成功就清掉标记（之后可以正常从云端拉）。
      if (typeof HusafeSync !== 'undefined' && HusafeSync.isOnline() && HusafeSync.isSignedIn()) {
        HusafeSync.updateProfile({
          nickname: meName,
          avatar: setupState.me,
        }).then(r => {
          if (r.ok) { state.me.profileEdited = false; save(); }
          else console.warn('昵称同步失败（本地已保存，下次登录会自动重推）：', r.reason);
        }).catch(err => console.warn('昵称同步异常：', err));
      }
      break;
    }

    case 'save-cat-budget': {
      for (const { catId, amount } of collectCatBudgets()) setCatBudget(catId, amount);
      const n = allCatBudgetUsage().length;
      closeModal(); render();
      toast(n ? `预算更新好啦 · ${n} 个分类` : '已清空分类预算');
      break;
    }

    case 'save-goal': {
      const name = ($('#goal-name')?.value || '').trim();
      const amount = Math.round(parseFloat($('#goal-amount')?.value || '0') * 100);
      if (!name) { toast('给目标起个名字吧'); break; }
      if (!amount || amount <= 0) { toast('目标金额要大于 0'); break; }
      addGoal({
        coupleId: state.couple.id, name,
        icon: '🎯', target: amount,
        deadline: $('#goal-deadline')?.value || '',
      });
      closeModal(); render(); toast('目标建好啦 🎯');
      break;
    }

    case 'deposit': openDepositModal(actEl.dataset.goal); break;
    case 'save-deposit': {
      const goalId = actEl.dataset.goal;
      if (!goalId) { toast('找不到目标，刷新页面再试'); break; }
      if (!state.goals.some(g => g.id === goalId)) {
        toast('这个目标已经不在了（可能被删了）');
        closeModal(); render();
        break;
      }

      // 容错读取金额：原生 number input 在移动端输入法下可能给出奇怪的值
      const raw = ($('#dep-amount')?.value || '').trim();
      const parsed = parseFloat(raw);
      const amount = Math.round((isFinite(parsed) ? parsed : 0) * 100);

      if (!amount || amount <= 0) {
        toast('先填一个大于 0 的金额');
        $('#dep-amount')?.focus();
        break;
      }

      const payer = ($('#modal')?.dataset.payer) || state.me.id;
      const res = depositGoal(goalId, amount, payer);
      if (!res || !res.ok) {
        toast((res && res.errors && res.errors[0]) || '存入失败，请重试');
        break;
      }
      closeModal(); render(); toast(`存进去啦 · ¥${money(amount, false)} 🎉`);
      break;
    }

    case 'save-budget': {
      const v = Math.round(parseFloat($('#budget-amount')?.value || '0') * 100);
      state.couple.monthlyBudget = v > 0 ? v : 0;
      save(); closeModal(); render(); toast('预算更新好啦');
      break;
    }

    case 'goal-detail': {
      const g = state.goals.find(x => x.id === actEl.dataset.goal);
      if (!g) break;
      const list = state.records.filter(r => !r.deletedAt && r.goalId === g.id)
        .sort((a, b) => b.date.localeCompare(a.date));
      openModal(`
        <div class="modal-emoji">${g.icon}</div>
        <div class="modal-title">${esc(g.name)}</div>
        <div class="modal-desc">已攒 ¥${money(goalSaved(g.id), false)} / ${money(g.target, false)}</div>
        <div class="mt-4" style="text-align:left;max-height:220px;overflow:auto">
          ${list.length ? list.map(r => `
            <div class="row">
              <span class="row-ico">💰</span>
              <div class="row-body">
                <div class="row-k">¥${money(r.amount, false)}</div>
                <div class="row-sub">${dayLabel(r.date)} · ${payerText(r)}</div>
              </div>
            </div>`).join('') : '<div class="muted tc">还没有存入记录</div>'}
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" style="flex:1" data-action="close-modal">关闭</button>
          <button class="btn btn-ghost" style="flex:0 0 auto;color:#C97B6B"
                  data-action="ask-del-goal" data-goal="${g.id}">删除</button>
        </div>
      `);
      break;
    }

    case 'ask-del-goal': {
      // 先弹二次确认 —— 删目标是不可逆操作，误点代价大
      const g = state.goals.find(x => x.id === actEl.dataset.goal);
      if (!g) { closeModal(); break; }
      const saved = goalSaved(g.id);
      const depCount = state.records.filter(r => !r.deletedAt && r.goalId === g.id).length;
      openModal(`
        <div class="modal-emoji">🗑️</div>
        <div class="modal-title">删除「${esc(g.name)}」？</div>
        <div class="modal-desc">
          ${saved > 0
            ? `已经攒了 <b>¥${money(saved, false)}</b>（${depCount} 笔存入）。`
            : '这个目标还没有存过钱。'}
        </div>
        <div class="note mt-4" style="text-align:left">
          ${saved > 0
            ? '💡 目标删掉后，那些存入记录会<b>留在账目里</b>（它们本来就是共享账目），'
              + '只是不再挂在目标上。'
            : '💡 删掉后就找不回来了。'}
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" style="flex:1" data-action="close-modal">不删了</button>
          <button class="btn btn-primary" style="flex:1;background:#C97B6B"
                  data-action="del-goal" data-goal="${g.id}">确认删除</button>
        </div>
      `);
      break;
    }

    case 'del-goal': {
      const gid = actEl.dataset.goal;
      const res = deleteGoal(gid);
      if (!res.ok) { toast('删除失败，目标可能已经不在了'); closeModal(); render(); break; }
      closeModal();
      render();
      toast('目标已删除');
      break;
    }

    case 'toggle-vis': {
      const r = state.records.find(x => x.id === actEl.dataset.rec);
      if (!r) break;
      if (r.visibility === 'private') {
        r.visibility = 'shared';
        toast('改成共享啦，TA 现在能看到这笔 💗');
      } else {
        r.visibility = 'private';
        r.payerId = r.creatorId;
        toast('改成私密啦，只有你能看到 🔒');
      }
      save(); closeModal(); render();
      break;
    }

    case 'del-rec': {
      deleteRecord(actEl.dataset.rec);
      closeModal(); render(); toast('删掉啦');
      break;
    }

    case 'reset': {
      resetAll();
      app.tab = 'home'; app.month = currentMonth(); app.filter = 'all'; app.statScope = 'shared';
      applyTheme(); render(); toast('已恢复演示数据');
      break;
    }

    case 'wipe': {
      // 页面状态异常时的逃生舱：清掉本地存档后重载，
      // 让 app 从种子数据重建，排除「旧存档与新结构不兼容」这类问题
      try { localStorage.clear(); } catch (e) {}
      location.reload();
      break;
    }

    default:
      console.warn('未处理的 action：', action);
  }
}

// 备注 / 日期输入实时同步到状态
document.addEventListener('input', e => {
  if (e.target.id === 'note-input') addState.note = e.target.value;
  if (e.target.id === 'date-input') addState.date = e.target.value;
});

// 点遮罩关闭
const scrimEl = $('#scrim');
if (scrimEl) {
  scrimEl.addEventListener('click', () => {
    if ($('#modal').classList.contains('open')) closeModal();
    if ($('#sheet').classList.contains('open')) closeAdd();
  });
}

function shiftMonth(m, delta) {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/* ==========================================================================
   启动
   ========================================================================== */

applyTheme();

// 跟随系统主题变化（仅 auto 模式生效）
if (window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getTheme() === 'auto') { applyTheme(); if (app.tab === 'stats') drawDonut(); }
    });
  } catch (e) { /* 老浏览器不支持 addEventListener 形式，忽略 */ }
}

try {
  render();
} catch (err) {
  // 启动就失败时，把原因直接写到页面上 —— 绝不留白屏让用户猜
  console.error('启动失败：', err);
  const scr = $('#screen');
  if (scr) {
    scr.innerHTML = `
      <div class="empty">
        <div class="empty-emoji">😵</div>
        <div class="empty-title">页面启动出错了</div>
        <div class="empty-desc" style="word-break:break-all">
          ${esc(err && err.message ? err.message : String(err))}
        </div>
        <button class="btn btn-primary" onclick="location.reload()">重新加载</button>
        <button class="btn btn-secondary mt-2" onclick="localStorage.clear();location.reload()">
          清空本地数据后重载</button>
      </div>`;
  }
}

// 首次设置引导也必须单独保护：
// 它是启动路径的一部分，一旦抛异常就会连带让「点击没反应」重现
try {
  maybeOpenSetup();
} catch (err) {
  console.error('首次设置引导失败（不影响 App 使用）：', err);
}

/**
 * 启动云端同步：拉一次数据 + 订阅对方的实时变更。
 *
 * 由 index.html 在「Supabase 配置就绪之后」显式调用 ——
 * 不能在这里自动执行，因为配置是异步读的，这里同步跑会拿不到配置。
 * 未配置/未登录时调用它是安全的（直接返回）。
 */
function startSync() {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline()) return { ok: false, reason: '未配置' };
  if (!HusafeSync.isSignedIn()) return { ok: false, reason: '未登录' };

  pullAndMerge().catch(err => console.warn('首次同步失败：', err));

  try {
    HusafeSync.subscribe(change => {
      // 对方的改动到达：合并进本地并重绘
      if (change.type === 'DELETE') {
        const i = state.records.findIndex(r => r.id === change.oldId);
        if (i >= 0) state.records.splice(i, 1);
      } else if (change.record) {
        const i = state.records.findIndex(r => r.id === change.record.id);
        if (i >= 0) state.records[i] = change.record;
        else state.records.unshift(change.record);
      }
      save();
      render();
      toast('TA 那边有新记录 💗');
    });
  } catch (err) {
    console.warn('实时订阅失败（不影响本地使用）：', err);
  }

  startQueueRetry();
  startPolling();
  return { ok: true };
}

/**
 * 轮询兜底：定期从云端重新拉一次数据。
 *
 * 为什么需要它：WebSocket 实时推送（Realtime）的协议细节容易出问题，
 * 而且我看不到线上实际收到的消息，无法调试。
 * 轮询不依赖任何实时协议，只要网络通就一定能把数据对齐 ——
 * 删掉的账目、改过的可见性，最多 15 秒后对方就能看到。
 *
 * 只在「页面在前台 + 已登录 + 有网」时轮询，切到后台就停，不浪费流量。
 */
let pollTimer = null;
let polling = false;

function startPolling(intervalMs) {
  if (pollTimer) return;
  const period = intervalMs || 15000;

  const tick = async () => {
    if (typeof HusafeSync === 'undefined') return;
    if (!HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;
    if (document.hidden) return;        // 后台不轮询
    if (polling) return;                // 上一轮还没跑完
    polling = true;
    try {
      await refreshFromCloud();
    } catch (e) {
      console.warn('轮询刷新失败：', e);
    } finally {
      polling = false;
    }
  };

  pollTimer = setInterval(tick, period);

  // 切回前台时立刻拉一次，不用等下一个周期
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
  window.addEventListener('online', tick);
  window.addEventListener('focus', tick);
}

/**
 * 只刷新账目数据，不打扰用户。
 *
 * 和 pullAndMerge 的区别：这个不做「云端为空要不要上传」的询问，
 * 也不弹 toast —— 它每 15 秒跑一次，必须是无感的。
 */
/**
 * 只刷新账目数据，不打扰用户。
 *
 * ⚠️ 这是每 15 秒跑一次的轮询，必须做到「无变化时零打扰」：
 *
 *   1. 比对的签名只包含【用户看得见的内容】—— 不含 syncedAt / updatedAt
 *      这类每次拉取都会变的字段，否则会永远判定为"有变化"。
 *   2. 没变化就【不重绘、不提示】。
 *   3. 只有出现「本机以前没有的记录」才提示一句；仅仅数据被刷新不提。
 */
async function refreshFromCloud() {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;

  const r = await HusafeSync.pullAll();
  if (!r.ok) return;

  const beforeSig = recordsSignature(state.records);
  const beforeGoalsSig = goalsSignature(state.goals);

  // 云端为准合并（同 id 覆盖；本地独有的保留，可能是还没推上去的）
  const byId = {};
  for (const rec of state.records) byId[rec.id] = rec;
  for (const rec of (r.records || [])) byId[rec.id] = rec;
  const merged = Object.values(byId);

  const afterSig = recordsSignature(merged);
  const afterGoalsSig = goalsSignature(
    Array.isArray(r.goals)
      ? (() => {
          const gById = {};
          for (const g of state.goals) gById[g.id] = g;
          for (const g of r.goals) gById[g.id] = g;
          return Object.values(gById).filter(g => !g.deletedAt);
        })()
      : state.goals
  );

  const recordsChanged = beforeSig !== afterSig;
  const goalsChanged = beforeGoalsSig !== afterGoalsSig;

  // 🔑 没有任何实际变化 → 什么都不做（不重绘、不提示）
  if (!recordsChanged && !goalsChanged) return;

  state.records = merged;

  if (Array.isArray(r.goals)) {
    const gById = {};
    for (const g of state.goals) gById[g.id] = g;
    for (const g of r.goals) gById[g.id] = g;
    state.goals = Object.values(gById).filter(g => !g.deletedAt);
  }

  save();
  render();

  // 只提示「真的多了一条以前没见过的」——
  // 编辑、删除同步过来时静默刷新即可，用户自己会看到界面对了。
  const knownIds = new Set(
    beforeSig ? beforeSig.split('|').map(s => s.split(':')[0]) : []
  );
  const newcomers = merged.filter(r2 => !knownIds.has(r2.id) && !r2.deletedAt);
  if (newcomers.length) {
    toast(newcomers.length === 1 ? 'TA 记了一笔 💗' : `TA 记了 ${newcomers.length} 笔 💗`);
  }
}

/**
 * 账目的内容签名。
 *
 * ⚠️ 只包含用户看得见的内容。**不要加 updatedAt / syncedAt** ——
 * 那些每次拉取都会变，会导致"永远认为有变化"，于是每 15 秒弹一次提示。
 */
function recordsSignature(recs) {
  return (recs || [])
    .filter(r => !r.deletedAt)
    .map(r => `${r.id}:${r.amount}:${r.visibility}:${r.payerId}:${r.categoryId}:${r.date}:${r.type}:${r.goalId || ''}:${r.note || ''}`)
    .sort()
    .join('|');
}

/** 目标的内容签名（同样只看用户看得见的内容） */
function goalsSignature(goals) {
  return (goals || [])
    .filter(g => !g.deletedAt)
    .map(g => `${g.id}:${g.name}:${g.target}:${g.icon || ''}:${g.deadline || ''}`)
    .sort()
    .join('|');
}

/**
 * 待同步队列的自动重试。
 *
 * ⚠️ 没有这个定时器的话，入队的账目只能靠手动刷新页面才可能补推，
 *    用户会一直看到「待同步 N 笔」而不知道怎么办。
 */
let queueTimer = null;
function startQueueRetry() {
  if (queueTimer) return;

  const tick = () => {
    if (typeof HusafeSync === 'undefined') return;
    if (!HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;
    if (HusafeSync.queueLength() === 0) return;
    if (!HusafeSync.getCoupleId()) return;
    syncFlushQueue();
  };

  queueTimer = setInterval(tick, 30000);   // 每 30 秒试一次

  // 网络恢复时立刻试一次，不用等定时器
  window.addEventListener('online', tick);
  // 回到前台时也试一次（手机上切回来很常见）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}
