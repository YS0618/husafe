/* ==========================================================================
   朝夕 Husafe · 数据层
   - 双维度模型（可见性 / 归属）
   - 统计聚合（不做 AA，因此没有债务结算）
   - 分类预算
   规范见 docs/02-数据模型与算法.md
   ========================================================================== */

const LS_KEY = 'husafe.state.v1';
const LS_KEY_OLD = 'mochi.state.v1';   // 旧版本存档，启动时自动迁移

/* ---------------------------- 静态字典 ---------------------------- */

const CATEGORIES = [
  { id: 'food',    name: '餐饮', icon: '🍜', color: '#F5A3A3' },
  { id: 'daily',   name: '日用', icon: '🧺', color: '#F9C784' },
  { id: 'traffic', name: '交通', icon: '🚕', color: '#8FD3B6' },
  { id: 'fun',     name: '娱乐', icon: '🎬', color: '#F0B775' },
  { id: 'shop',    name: '购物', icon: '🛍️', color: '#EE8B7A' },
  { id: 'home',    name: '住房', icon: '🏠', color: '#C9B6E4' },
  { id: 'med',     name: '医疗', icon: '💊', color: '#A8C8E8' },
  { id: 'travel',  name: '旅行', icon: '✈️', color: '#7FC8D8' },
  { id: 'study',   name: '学习', icon: '📚', color: '#B8C99A' },
  { id: 'gift',    name: '礼物', icon: '🎁', color: '#F3A6C8' },
  { id: 'other',   name: '其他', icon: '✨', color: '#C4B5AC' },
];

const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
const cat = id => CAT_MAP[id] || CAT_MAP.other;

/**
 * 账目模型（v0.3 已简化）
 *
 * 只有两个维度，**不再有"算谁的"**：
 *
 *   可见性 visibility
 *     'shared'  → 我们共享：两个人都看得到，算进「我们一起花了」和共同预算
 *     'private' → 仅我可见：只有我看得到，不进任何共同统计
 *
 *   付款人 payerId
 *     谁掏的钱。**纯记录性质** —— 不算债务、不做分摊、不影响任何统计口径。
 *
 * 💡 为什么删掉"算谁的"（原 bear 字段）：
 *    它区分「共同开销」和「我自己的开销」，但共享账目本来就是共同开销 ——
 *    两者重合，多一个二选一只会让人困惑（"她记的账为什么显示算我自己的？"）。
 *    不做 AA 的情侣不需要这个维度。
 */

/**
 * 身份模型（重要）
 *
 * 本地用 'u1' / 'u2' 这两个【稳定的本地身份】来标记「谁」——
 * 因为渲染、统计、过滤全都依赖它，它必须不随登录状态变化。
 *
 * 云端用的是 Supabase 分配的【真实 UUID】（auth.users.id）。
 * 两者在同步时通过 state.me.cloudId / state.partner.cloudId 建立映射：
 *
 *     本地 'u1'  <->  state.me.cloudId       （我的 UUID）
 *     本地 'u2'  <->  state.partner.cloudId  （TA 的 UUID）
 *
 * 未登录时 cloudId 为空，纯本地模式照常工作。
 */

/** 当前用户的本地身份键 */
function meKey() { return state.me.id; }

/** 判断某个值是不是「我」（同时兼容本地键和云端 UUID） */
function isMe(v) {
  return v === state.me.id || (!!state.me.cloudId && v === state.me.cloudId);
}

/** 判断某个值是不是「TA」（同时兼容本地键和云端 UUID） */
function isPartner(v) {
  return v === state.partner.id || (!!state.partner.cloudId && v === state.partner.cloudId);
}

/** 本地身份键 -> 云端 UUID（推送时用） */
function keyToCloudId(v) {
  if (isMe(v)) return state.me.cloudId || null;
  if (isPartner(v)) return state.partner.cloudId || null;
  return null;
}

/** 云端 UUID -> 本地身份键（拉取时用） */
function cloudIdToKey(v) {
  if (!v) return null;
  if (state.me.cloudId && v === state.me.cloudId) return state.me.id;
  if (state.partner.cloudId && v === state.partner.cloudId) return state.partner.id;
  if (v === state.me.id || v === state.partner.id) return v;   // 已经是本地键
  return null;
}

/** 记录双方的真实身份，由同步层在拉到 profile 后调用 */
function setCloudIdentities(meId, partnerId) {
  if (meId) state.me.cloudId = meId;
  if (partnerId) state.partner.cloudId = partnerId;
  save();
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) { return isoDay(n); }

function prevMonthDay(monthsAgo, day) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------------------- 初始数据 ---------------------------- */

/**
 * 当前该用哪个初始结构。
 *
 * 演示模式（window.HUSAFE_DEMO_MODE === true）才预置示例账目；
 * 正式使用走「空账本」—— 否则一旦清缓存或换设备，
 * 那 21 条示例假账会冒出来污染真账本。
 */
function initialSeed() {
  const demo = (typeof window !== 'undefined' && window.HUSAFE_DEMO_MODE === true);
  return demo ? seed() : seedEmpty();
}

/** 「空账本」：结构完整、但没有任何账目/目标/预算 */
function seedEmpty() {
  const s = seed();
  s.records = [];
  s.goals = [];
  s.categoryBudgets = {};
  return s;
}

function seed() {
  return {
    version: 2,
    theme: 'auto',              // auto | light | dark
    onboarded: false,
    setupDone: false,           // 是否已完成「设置称呼」引导

    me: { id: 'u1', nickname: '阿满', avatar: '🐻', cloudId: null,
          // 用户是否在本机亲手改过自己的称呼/头像。
          // 为 true 时，登录拉取【不能】用云端值覆盖它 —— 反而要把本地值推上云端。
          // 否则「改完昵称 → 重新登录」会被云端的旧值打回去。
          profileEdited: false },
    partner: { id: 'u2', nickname: '小鹿', avatar: '🦊', cloudId: null },
    couple: {
      id: 'c1',
      memberA: 'u1',
      memberB: 'u2',
      // boundAt 只是个占位值。真正显示天数用的是从云端同步回来的日期，
      // 由 state.couple.boundAtSynced 标记 —— 同步之前不显示这个假日期。
      boundAt: (() => { const d = new Date(); d.setDate(d.getDate() - 128); return d.toISOString().slice(0, 10); })(),
      boundAtSynced: false,
      monthlyBudget: 0,          // 默认不设预算，由用户自己定
      status: 'active',
    },
    // 不预置任何目标 —— 目标应该由你们自己建，而不是开局塞两个别人的目标进来
    goals: [],
    records: [
      // ---- 本月：各笔的 payer 与归属混搭，覆盖真实场景 ----
      { id: 'r1', amount: 20000, categoryId: 'food', date: daysAgo(1), note: '一起吃了火锅',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r2', amount: 8800, categoryId: 'fun', date: daysAgo(1), note: '看电影',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r3', amount: 30000, categoryId: 'med', date: daysAgo(3), note: '小鹿的体检费',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r4', amount: 4500, categoryId: 'food', date: daysAgo(3), note: '楼下咖啡',
        visibility: 'private', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r5', amount: 120000, categoryId: 'shop', date: daysAgo(4), note: '换季衣服',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r6', amount: 15000, categoryId: 'food', date: daysAgo(5), note: '买菜做饭',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r7', amount: 6000, categoryId: 'traffic', date: daysAgo(5), note: '打车回家',
        visibility: 'private', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r8', amount: 15000, categoryId: 'food', date: daysAgo(6), note: '周末早餐',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r9', amount: 50000, categoryId: 'travel', date: daysAgo(8), note: '存进北海道之旅',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1',
        type: 'expense', goalId: 'g1' },
      { id: 'r10', amount: 20000, categoryId: 'travel', date: daysAgo(8), note: '存进北海道之旅',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2',
        type: 'expense', goalId: 'g1' },
      { id: 'r11', amount: 12000, categoryId: 'gift', date: daysAgo(10), note: '给阿满的惊喜',
        visibility: 'private', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r12', amount: 30000, categoryId: 'travel', date: daysAgo(12), note: '存进相机',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2',
        type: 'expense', goalId: 'g2' },
      { id: 'r14', amount: 80000, categoryId: 'other', date: daysAgo(2), note: '这个月工资',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'income' },
      // ---- 上几个月（用于趋势图） ----
      { id: 'r20', amount: 260000, categoryId: 'food', date: prevMonthDay(1, 12), note: '',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r21', amount: 180000, categoryId: 'shop', date: prevMonthDay(1, 20), note: '',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r22', amount: 90000, categoryId: 'home', date: prevMonthDay(1, 5), note: '水电',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r23', amount: 120000, categoryId: 'fun', date: prevMonthDay(2, 14), note: '',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r24', amount: 70000, categoryId: 'traffic', date: prevMonthDay(2, 8), note: '',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r25', amount: 150000, categoryId: 'food', date: prevMonthDay(3, 16), note: '',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
      { id: 'r26', amount: 95000, categoryId: 'shop', date: prevMonthDay(4, 11), note: '',
        visibility: 'shared', payerId: 'u2', creatorId: 'u2', type: 'expense' },
      { id: 'r27', amount: 88000, categoryId: 'food', date: prevMonthDay(5, 19), note: '',
        visibility: 'shared', payerId: 'u1', creatorId: 'u1', type: 'expense' },
    ],
    // 不预置任何分类预算 —— 预算该由你们根据自己的消费习惯来设，
    // 而不是开局塞几个别人定的数字
    categoryBudgets: {},
  };
}

/* ---------------------------- 状态加载与自愈 ---------------------------- */

let state = load();

/**
 * 把存档与最新默认结构合并。
 *
 * ⚠️ 这一步非常重要：只要种子结构变了（新增字段、改字段名），
 *    旧存档就会缺字段，页面渲染时读到 undefined 可能直接抛错，
 *    表现就是「点击完全没反应」。因此每次启动都做一次结构补齐。
 */
function migrate(saved) {
  const base = seed();
  if (!saved || typeof saved !== 'object') return base;

  const s = {
    ...base,
    ...saved,
    me: { ...base.me, ...(saved.me || {}) },
    partner: { ...base.partner, ...(saved.partner || {}) },
    couple: { ...base.couple, ...(saved.couple || {}) },
    goals: Array.isArray(saved.goals) ? saved.goals : base.goals,
    records: Array.isArray(saved.records) ? saved.records : base.records,
    categoryBudgets: { ...(saved.categoryBudgets || {}) },
  };

  // 补齐云身份字段（老存档没有）
  if (!('cloudId' in s.me)) s.me.cloudId = null;
  if (!('cloudId' in s.partner)) s.partner.cloudId = null;

  // 老存档没这个标记。已经改过称呼的（setupDone）视为"用户改过"，
  // 避免他们升级后被云端的旧昵称打回去。
  //
  // ⚠️ 必须看【存档原始值】，不能看 s.me.profileEdited ——
  //    上面合并默认值时已经把它填成 false 了，判断会失效。
  if (!saved.me || typeof saved.me.profileEdited !== 'boolean') {
    s.me.profileEdited = !!s.setupDone;
  }
  // 绑定时间是否已从云端同步（老存档一律视为未同步，避免显示假天数）
  if (typeof s.couple.boundAtSynced !== 'boolean') s.couple.boundAtSynced = false;

  // 补上旧版本没有的字段
  if (!s.theme) s.theme = 'auto';
  if (typeof s.onboarded !== 'boolean') s.onboarded = false;
  if (typeof s.setupDone !== 'boolean') s.setupDone = false;
  for (const r of s.records) {
    delete r.splitMode;
    delete r.shares;
    // v0.3 删掉了「归属」这一维，老存档里的 bear 一并清掉
    delete r.bear;
    // 旧的「清账」记录在新模型里没有意义，直接丢弃
    if (r.type === 'settle') r.deletedAt = r.deletedAt || 'migrated-away';
    if (r.visibility === 'private') {
      r.payerId = r.creatorId;
    }
  }
  // 同步 record 归属与私密约束的一致性
  s.records = s.records.filter(r => r.type !== 'settle');

  s.version = 2;
  return s;
}

function load() {
  const read = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  try {
    const raw = read(LS_KEY) || read(LS_KEY_OLD);
    if (raw) return migrate(JSON.parse(raw));
  } catch (e) {
    console.warn('存档解析失败，已重建：', e);
  }
  const s = initialSeed();
  persist(s);
  return s;
}

function persist(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) { /* 无痕模式等 */ }
}

function save() { persist(state); }

/**
 * 重置本地数据。
 *
 * 注意：正式模式下重置成【空账本】，而不是带示例数据的版本 ——
 * 「重置」的语义是"恢复初始状态"，不是"塞一堆假账进来"。
 */
function resetAll() {
  state = initialSeed();
  save();
  return state;
}

/** 主题：auto / light / dark */
function setTheme(t) {
  state.theme = t;
  save();
}
function getTheme() { return state.theme || 'auto'; }

/* ---------------------------- 格式化 ---------------------------- */

/** 分 → 「1,234.50」 */
function money(cents, withDecimals = true) {
  const v = Math.abs(cents) / 100;
  const s = withDecimals
    ? v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : Math.round(v).toLocaleString('zh-CN');
  return (cents < 0 ? '-' : '') + s;
}

/** 分 → 「¥1,234」 列表用，不显示小数，减少数字压迫感 */
function moneyShort(cents) { return '¥' + money(cents, false); }

function monthLabel(m) {
  const [y, mm] = m.split('-');
  const now = new Date();
  if (m === currentMonth()) return '本月';
  if (Number(y) === now.getFullYear()) return `${Number(mm)} 月`;
  return `${y} 年 ${Number(mm)} 月`;
}

function dayLabel(dateStr) {
  const today = isoDay(0);
  if (dateStr === today) return '今天';
  if (dateStr === isoDay(1)) return '昨天';
  const [, mm, dd] = dateStr.split('-');
  return `${Number(mm)} 月 ${Number(dd)} 日`;
}

/* ---------------------------- 可见性隔离 ---------------------------- */

/** 私密账目只有记账人自己能看到 */
function visibleRecords() {
  const me = state.me.id;
  const today = isoDay(0);
  return state.records.filter(r =>
    !r.deletedAt &&
    r.date <= today &&
    (r.visibility === 'shared' || r.creatorId === me)
  );
}

const inMonth = (r, month) => r.date.startsWith(month);

/* ---------------------------- 统计聚合 ---------------------------- */

/** 一笔账由谁掏的钱 */
function payerOf(rec) {
  return rec.payerId === state.me.id ? state.me : state.partner;
}

function payerText(rec) {
  const me = state.me.id;
  return rec.payerId === me ? state.me.nickname + ' 付' : state.partner.nickname + ' 付';
}

/**
 * 月度统计（v0.3 简化后）
 *
 * 只有两个口径，各自对应一种可见性 —— 不再有"归属"这一维：
 *
 *   shared → 我们共享：共享账目全额（双方合计）
 *   mine   → 仅我自己：我的私密账目
 *
 * 不做 AA，所以这里没有任何「谁欠谁」的计算；
 * 「谁付的」也只是事实陈述，不参与任何债务。
 *
 * @param {'shared'|'mine'} scope
 */
function monthlyStats(month, scope = 'shared') {
  const me = state.me.id;
  const recs = visibleRecords().filter(r => inMonth(r, month) && r.type === 'expense');

  const list = scope === 'shared'
    ? recs.filter(r => r.visibility === 'shared')
    : recs.filter(r => r.visibility === 'private' && r.creatorId === me);

  const total = list.reduce((s, r) => s + r.amount, 0);
  const paidByMe = list.filter(r => r.payerId === me).reduce((s, r) => s + r.amount, 0);

  return {
    total,
    count: list.length,
    paidByMe,
    paidByPartner: total - paidByMe,
    byCat: groupByCat(list),
  };
}

/** 按分类聚合 */
function groupByCat(recs) {
  const map = {};
  for (const r of recs) {
    const key = r.categoryId;
    if (!map[key]) map[key] = { catId: key, amount: 0, count: 0 };
    map[key].amount += r.amount;
    map[key].count += 1;
  }
  return Object.values(map)
    .filter(c => c.amount > 0)
    .sort((a, b) => b.amount - a.amount);
}

/** 近 n 个月趋势 */
function trend(months = 6, scope = 'shared') {
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push({ month: m, label: `${d.getMonth() + 1}月`, value: monthlyStats(m, scope).total });
  }
  return out;
}

/** 目标已存金额（派生值，绝不落库） */
function goalSaved(goalId) {
  return state.records
    .filter(r => !r.deletedAt && r.goalId === goalId && r.type === 'expense')
    .reduce((s, r) => s + r.amount, 0);
}

/** 出现过账目的所有月份，倒序 */
function allMonths() {
  const set = new Set();
  for (const r of state.records) {
    if (!r.deletedAt && r.type === 'expense') set.add(r.date.slice(0, 7));
  }
  set.add(currentMonth());
  return Array.from(set).sort().reverse();
}

/* ---------------------------- 分类预算 ---------------------------- */

function catBudget(catId) {
  return (state.categoryBudgets || {})[catId] || 0;
}

/**
 * 设置分类预算。amount 为 0 表示删除该预算。
 * 预算只作用于「我们共同」口径 —— 见 PRD 决策三：
 * 预算是协作工具，一旦变成单人考核就会诱发把账记到私账里逃避预算，
 * 直接毁掉数据完整性。
 */
function setCatBudget(catId, amount) {
  if (!state.categoryBudgets) state.categoryBudgets = {};
  if (!amount || amount <= 0) delete state.categoryBudgets[catId];
  else state.categoryBudgets[catId] = Math.round(amount);
  save();
  return { ok: true };
}

function catBudgetUsage(catId, month = currentMonth()) {
  const budget = catBudget(catId);
  const used = monthlyStats(month, 'shared').byCat.find(c => c.catId === catId)?.amount || 0;
  if (!budget) return { catId, budget: 0, used, pct: 0, left: 0, status: 'none' };
  const pct = used / budget;
  const status = pct >= 1 ? 'over' : pct > 0.9 ? 'warn' : 'ok';
  return { catId, budget, used, pct, left: budget - used, status };
}

function allCatBudgetUsage(month = currentMonth()) {
  return Object.keys(state.categoryBudgets || {})
    .map(id => catBudgetUsage(id, month))
    .sort((a, b) => b.pct - a.pct);
}

function budgetAlerts(month = currentMonth()) {
  return allCatBudgetUsage(month).filter(u => u.status === 'over' || u.status === 'warn');
}

/**
 * 建议预算：取该分类近 3 个月「共同支出」的最高值，向上取整到 10 元。
 * 有历史数据时给建议、无历史数据时给 0（不瞎猜）。
 */
function suggestCatBudget(catId, months = 3) {
  const now = new Date();
  let max = 0;
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const v = monthlyStats(m, 'shared').byCat.find(c => c.catId === catId)?.amount || 0;
    if (v > max) max = v;
  }
  if (!max) return 0;
  return Math.ceil(max / 1000) * 1000;
}

/* ---------------------------- 数据校验 ---------------------------- */

/**
 * 业务约束
 * 1. 金额必须 > 0
 * 2. 私密账目只能由记账人自己付款、且只能算自己的
 *    —— 否则会变成「对方看不到却要承担」的隐形负担
 */
function validateRecord(rec) {
  const errors = [];
  if (!rec.amount || rec.amount <= 0) errors.push('金额要大于 0 哦');
  // 私密账目只能自己付款 —— 否则会出现"对方看不到、却要为它出钱"的隐形负担
  if (rec.visibility === 'private' && rec.payerId !== rec.creatorId) {
    errors.push('私密账目只能由记账人自己付款');
  }
  return errors;
}

/* ---------------------------- 云端同步钩子 ---------------------------- */

/**
 * 本地写入后把变更推到云端。
 *
 * ⚠️ 这一步绝不能省：只写本地不推云端的话，数据库里永远是空的，
 *    "两个人共用一本账"就只是一句空话（表是空的，对方什么都看不到）。
 *
 * 未配置 / 未登录时 HusafeSync 会安全空转，不影响纯本地使用。
 */
function syncPushRecord(rec) {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;
  HusafeSync.saveRecord(rec).then(r => {
    if (r.ok) {
      // 推送成功顺带把之前积压的也补推掉
      syncFlushQueue();
    } else if (r.queued) {
      console.info('已入待同步队列：', r.reason);
    }
  }).catch(err => console.warn('推送失败，已入队：', err));
}

function syncPushGoal(goal) {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;
  HusafeSync.saveGoalRecord(goal).catch(err => console.warn('目标推送失败：', err));
}

/**
 * 把待同步队列补推上去。
 *
 * ⚠️ 这一步必须有人调用 —— 只定义不调用的话，
 *    一旦有账目入了队（比如绑定前记的），就会永远卡在队列里，
 *    表现就是「待同步 2 笔」一直不消失、数据库里始终没数据。
 */
/** 最近一次同步失败的原因，显示在「我的」页上，省得去翻控制台 */
let lastSyncError = null;
function getLastSyncError() { return lastSyncError; }
function clearLastSyncError() { lastSyncError = null; }

let flushing = false;
function syncFlushQueue() {
  if (typeof HusafeSync === 'undefined' || !HusafeSync.isOnline() || !HusafeSync.isSignedIn()) return;
  if (flushing) return;
  if (HusafeSync.queueLength() === 0) return;

  const coupleId = HusafeSync.getCoupleId();
  if (!coupleId) return;      // 还没绑定，等绑定后由 pullAndMerge 触发

  flushing = true;

  // ⚠️ 顺序很重要：先把 goal 推上去。
  //    records.goal_id 有外键指向 goals(id)，目标没到就推账目会被拒绝（400）。
  Promise.resolve()
    .then(() => HusafeSync.pushAllGoals(state.goals || []))
    .then(g => {
      if (!g.ok) {
        lastSyncError = '目标推送失败 → ' + g.reason;
        console.warn(lastSyncError);
        return { ok: false, reason: g.reason, stage: 'goals' };
      }
      lastSyncError = null;
      return HusafeSync.flushQueue(coupleId);
    })
    .then(r => {
      if (!r) return;
      if (r.ok && r.count > 0) {
        lastSyncError = null;
        console.info(`已补推 ${r.count} 笔到云端`);
      } else if (r.ok && r.dropped > 0) {
        lastSyncError = null;
        console.info(`跳过了 ${r.dropped} 条不属于本机用户的记录`);
      } else if (!r.ok) {
        lastSyncError = (r.stage === 'goals' ? '' : '账目推送失败 → ') + r.reason;
        console.warn(lastSyncError);
      }
      if (typeof render === 'function') render();
    })
    .catch(err => {
      lastSyncError = String((err && err.message) || err);
      console.warn('补推异常：', err);
      if (typeof render === 'function') render();
    })
    .finally(() => { flushing = false; });
}

/* ---------------------------- 账目增删改 ---------------------------- */

function addRecord(rec) {
  const errs = validateRecord(rec);
  if (errs.length) return { ok: false, errors: errs };
  rec.id = rec.id || uid();
  rec.createdAt = new Date().toISOString();
  state.records.unshift(rec);
  save();
  syncPushRecord(rec);          // 🔑 推到云端
  return { ok: true, rec };
}

function updateRecord(id, patch) {
  const i = state.records.findIndex(r => r.id === id);
  if (i < 0) return { ok: false };
  const merged = { ...state.records[i], ...patch };
  const errs = validateRecord(merged);
  if (errs.length) return { ok: false, errors: errs };
  merged.updatedAt = new Date().toISOString();
  merged.version = (merged.version || 1) + 1;
  state.records[i] = merged;
  save();
  syncPushRecord(merged);
  return { ok: true, rec: merged };
}

/** 软删除，避免多设备同步时「删了又回来」 */
function deleteRecord(id) {
  const r = state.records.find(x => x.id === id);
  if (r) {
    r.deletedAt = new Date().toISOString();
    r.version = (r.version || 1) + 1;
    save();
    syncPushRecord(r);          // 软删除也要同步，否则对方那边删不掉
  }
}

/* ---------------------------- 目标 ---------------------------- */

function addGoal(goal) {
  goal.id = uid();
  goal.status = 'active';
  goal.createdAt = isoDay(0);
  goal.updatedAt = new Date().toISOString();
  state.goals.push(goal);
  save();
  syncPushGoal(goal);           // 🔑 推到云端
  return goal;
}

/** 编辑目标（改名、改金额等） */
function updateGoal(id, patch) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return { ok: false };
  Object.assign(g, patch, { updatedAt: new Date().toISOString() });
  save();
  syncPushGoal(g);
  return { ok: true, goal: g };
}

/**
 * 删除目标。
 *
 * 用软删除 + 同步：否则一台设备删了，另一台还看得到。
 * 关联的账目保留（那是对账记录），只是不再挂在这个目标上。
 */
function deleteGoal(id) {
  const g = state.goals.find(x => x.id === id);
  if (!g) return { ok: false };
  g.deletedAt = new Date().toISOString();
  g.updatedAt = g.deletedAt;
  // 把关联账目的 goalId 摘掉（本地），避免指向一个已删除的目标
  for (const r of state.records) {
    if (r.goalId === id) {
      delete r.goalId;
      r.updatedAt = new Date().toISOString();
      syncPushRecord(r);
    }
  }
  save();
  syncPushGoal(g);
  return { ok: true };
}

function depositGoal(goalId, amount, payerId) {
  const g = state.goals.find(x => x.id === goalId);
  if (!g) return { ok: false, errors: ['目标不存在'] };
  return addRecord({
    amount,
    categoryId: 'travel',
    date: isoDay(0),
    note: `存进${g.name}`,
    visibility: 'shared',
    payerId,
    creatorId: state.me.id,
    type: 'expense',
    goalId,
  });
}
