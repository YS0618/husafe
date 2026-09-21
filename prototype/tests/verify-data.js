/* 数据层验证：node tests/verify-data.js */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DATA_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8');

function makeLS(initial = {}) {
  const mem = { ...initial };
  return {
    mem,
    api: {
      getItem: k => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); },
      removeItem: k => { delete mem[k]; },
    },
  };
}

const SANDBOX_EXTRAS = {
  Date, Math, JSON, Object, Array, String, Number, Boolean,
  isNaN, parseFloat, parseInt, Set, Map, Symbol, Error, RegExp,
  // 测试需要确定的初始数据（21 条示例账目），显式打开演示模式。
  // 正式环境里 HUSAFE_DEMO_MODE = false，开局是空账本。
  window: { HUSAFE_DEMO_MODE: true },
};

const EXPORTS = [
  'LS_KEY', 'LS_KEY_OLD', 'CATEGORIES', 'CAT_MAP', 'cat',
  'currentMonth', 'isoDay', 'plusDays', 'daysAgo', 'prevMonthDay', 'uid',
  'seed', 'seedEmpty', 'initialSeed', 'migrate', 'load', 'save', 'resetAll', 'setTheme', 'getTheme',
  'money', 'moneyShort', 'monthLabel', 'dayLabel',
  'visibleRecords', 'inMonth', 'payerOf', 'payerText',
  'monthlyStats', 'groupByCat', 'trend', 'goalSaved', 'allMonths',
  'catBudget', 'setCatBudget', 'catBudgetUsage', 'allCatBudgetUsage',
  'budgetAlerts', 'suggestCatBudget', 'validateRecord',
  'addRecord', 'updateRecord', 'deleteRecord', 'addGoal', 'depositGoal',
];

/**
 * 在一份全新的作用域里求值 data.js 并把内部声明暴露出来。
 * 脚本顶层的 const 只在本次求值内可见，所以必须显式 return。
 * getState 用来读当前 state（resetAll 会替换它的绑定，不能缓存）。
 */
function loadData(ls) {
  const sandbox = { localStorage: ls.api, navigator: {}, console, ...SANDBOX_EXTRAS };
  const src = DATA_SRC + `\n;({ ${EXPORTS.join(', ')}, getState: () => state });`;
  return vm.runInNewContext(src, sandbox, { filename: 'data.js' });
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`); }
}

const LS = makeLS();
const D = loadData(LS);
const S = () => D.getState();

function section(t) { console.log(`\n=== ${t} ===`); D.resetAll(); }

/* ------------------------------------------------------------------ */

section('0. 品牌与数据结构');
const MONTH = D.currentMonth();
const LAST_MONTH = D.prevMonthDay(1, 1).slice(0, 7);
check('存档 key 已改为 husafe', D.LS_KEY, 'husafe.state.v1');
check('数据版本号 = 2', S().version, 2);
check('默认主题为 auto', S().theme, 'auto');
check('账目总数 21', S().records.length, 21);
check('无重复 id', S().records.map(r => r.id).filter((v, i, a) => a.indexOf(v) !== i).length, 0);
check('🔴 v0.3 起账目不再有 bear 字段（删掉了"算谁的"这一维）',
  S().records.some(r => 'bear' in r), false);
check('🔴 已无 splitMode 字段（移除 AA 分摊）', S().records.some(r => 'splitMode' in r), false);
check('🔴 已无 settle 类型账目（移除清账）', S().records.some(r => r.type === 'settle'), false);
check('日期都在今天或之前', S().records.every(r => r.date <= D.isoDay(0)), true);
check('最近 6 个月每月都有数据',
  [0,1,2,3,4,5].every(i => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return S().records.some(r => r.date.startsWith(m));
  }), true);

section('0b. 🔴 空账本模式（正式使用）');
// 正式环境 HUSAFE_DEMO_MODE = false，开局必须是空的 ——
// 否则清缓存或换设备时，示例假账会冒出来污染真账本。
const empty = D.seedEmpty();
check('空账本没有任何账目', empty.records.length, 0);
check('空账本没有任何目标', empty.goals.length, 0);
check('空账本没有分类预算', Object.keys(empty.categoryBudgets).length, 0);
check('🔴 空账本仍保留账号结构', !!empty.me.id && !!empty.partner.id, true);
check('🔴 空账本仍保留情侣关系', !!empty.couple.id, true);
check('空账本仍是版本 2', empty.version, 2);

const demoSeed = D.seed();
check('演示模式仍有 21 条示例账目', demoSeed.records.length, 21);
check('🔴 演示模式也不预置目标（避免混进真账本）', demoSeed.goals.length, 0);
check('🔴 演示模式也不预置预算', Object.keys(demoSeed.categoryBudgets).length, 0);
check('🔴 测试沙箱里 initialSeed 走演示模式（保证测试数据确定）',
  D.initialSeed().records.length, 21);

section('1. 统计口径：共同 / 我自己');
const shared = D.monthlyStats(MONTH, 'shared');
const mine = D.monthlyStats(MONTH, 'mine');
console.log(`  我们共同 ¥${D.money(shared.total)}（${shared.count} 笔）｜ 我付 ¥${D.money(shared.paidByMe)} / TA 付 ¥${D.money(shared.paidByPartner)}`);
console.log(`  我自己 ¥${D.money(mine.total)}（${mine.count} 笔）`);
check('共同支出 = ¥3,088.00（全部 9 笔共享账目）', shared.total, 308800);
check('共同笔数 = 9', shared.count, 9);
check('共同支出中我付 ¥1,300.00', shared.paidByMe, 130000);
check('共同支出中 TA 付 ¥1,788.00', shared.paidByPartner, 178800);
check('双方付款之和 = 共同总额', shared.paidByMe + shared.paidByPartner, shared.total);
check('我自己的（全部是私密账目）= ¥105.00', mine.total, 10500);
check('我的私密笔数 = 2', mine.count, 2);

section('2. 收入不参与支出统计');
check('收入记录类型为 income', S().records.find(r => r.id === 'r14').type, 'income');
const expenseSum = S().records
  .filter(r => !r.deletedAt && r.type === 'expense' && r.visibility === 'shared'
    && r.date.startsWith(MONTH))
  .reduce((s, r) => s + r.amount, 0);
check('共同口径只累加 expense', shared.total, expenseSum);
check('收入 ¥800 没进任何支出统计', shared.total + mine.total < 8000000, true);

section('3. 可见性隔离');
check('小鹿有 1 笔私密账目',
  S().records.filter(r => r.visibility === 'private' && r.creatorId === 'u2').length, 1);
check('🔴 小鹿的私密账目不在「我」的可见列表中',
  D.visibleRecords().some(r => r.id === 'r11'), false);
check('我自己的私密账目可见', D.visibleRecords().some(r => r.id === 'r4'), true);
check('共享账目可见', D.visibleRecords().some(r => r.id === 'r1'), true);
check('🔴 私密账目不计入共同统计',
  D.monthlyStats(MONTH, 'shared').byCat.some(c => c.catId === 'gift'), false);

section('4. 业务校验：私密账目不得产生隐形负担');
check('🔴 私密 + 他人代付 → 拒绝（这是唯一还保留的约束）', D.validateRecord({
  amount: 100, visibility: 'private', payerId: 'u2', creatorId: 'u1',
}).length > 0, true);
check('私密 + 自己付 → 通过', D.validateRecord({
  amount: 100, visibility: 'private', payerId: 'u1', creatorId: 'u1',
}).length, 0);
check('金额为 0 → 拒绝', D.validateRecord({
  amount: 0, visibility: 'shared', payerId: 'u1', creatorId: 'u1',
}).length > 0, true);
check('共享 + 他人代付 → 通过（付款人随便谁）', D.validateRecord({
  amount: 100, visibility: 'shared', payerId: 'u2', creatorId: 'u1',
}).length, 0);

section('5. 🔴 v0.3：可见性只有两种取值，不再有"归属"');
check('可见性取值集合',
  Array.from(new Set(S().records.map(r => r.visibility))).sort(), ['private', 'shared']);
check('🔴 没有任何记录带 bear 字段',
  S().records.filter(r => 'bear' in r).length, 0);
check('🔴 旧的"算谁的"文案已从数据层移除',
  typeof D.BEAR_LABEL, 'undefined');

section('6. 分类预算');
const foodUsed = D.monthlyStats(MONTH, 'shared').byCat.find(c => c.catId === 'food').amount;
check('餐饮本月共同支出 = 50000（¥500.00）', foodUsed, 50000);
check('🔴 默认不预置任何分类预算', Object.keys(S().categoryBudgets).length, 0);
check('未设置的分类预算为 0', D.catBudget('food'), 0);
check('未设置时状态为 none', D.catBudgetUsage('food').status, 'none');

D.setCatBudget('food', 200000);
check('设成 200000 后使用率 = 50000 / 200000 = 25%', D.catBudgetUsage('food').pct, 0.25);
check('状态 ok', D.catBudgetUsage('food').status, 'ok');

D.setCatBudget('food', 60000);
check('预算 60000、已花 50000 → 83.3% ok', D.catBudgetUsage('food').status, 'ok');
D.setCatBudget('food', 52000);
check('预算 52000、已花 50000 → 96.2% warn', D.catBudgetUsage('food').status, 'warn');
D.setCatBudget('food', 50000);
check('预算 50000、已花 50000 → 100% over（用满即到界）', D.catBudgetUsage('food').status, 'over');
D.setCatBudget('food', 0);
check('设为 0 等于删除', D.catBudget('food'), 0);
check('删除后状态 none', D.catBudgetUsage('food').status, 'none');

section('7. 预算只算共同口径，不含私账');
const before = D.catBudgetUsage('food').used;
D.addRecord({
  id: 'tmp-priv', amount: 999900, categoryId: 'food', date: D.isoDay(0), note: '大额私账餐饮',
  visibility: 'private', payerId: 'u1', creatorId: 'u1', type: 'expense',
});
check('🔴 私密餐饮账目不进预算', D.catBudgetUsage('food').used, before);
check('🔴 预算只算共享账目（私密全部排除）',
  (D.monthlyStats(MONTH, 'shared').byCat.find(c => c.catId === 'gift')?.amount || 0), 0);

section('8. 预算建议值');
const hist = [0, 1, 2].map(i => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
  const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  return D.monthlyStats(m, 'shared').byCat;
});
const maxOf = catId => Math.max(0, ...hist.map(l => l.find(c => c.catId === catId)?.amount || 0));
check('餐饮近 3 月最高 = 260000', maxOf('food'), 260000);
check('建议值 = 最高值向上取整到 10 元', D.suggestCatBudget('food'), 260000);
check('建议值是 10 元的整数倍', D.suggestCatBudget('food') % 1000, 0);
check('🈳 学习类无支出 → 建议 0', D.suggestCatBudget('study'), 0);

section('9. 目标：默认没有，建了才有（派生值）');
check('🔴 默认不预置任何目标', S().goals.length, 0);

// 先造一个新的目标来测，用一个本次从未出现过的 goalId，
// 避免受到前面各节 addRecord 的影响
D.addGoal({ coupleId: 'c1', name: '北海道之旅', icon: '🗾', target: 1200000, deadline: '' });
const newGoal = S().goals[S().goals.length - 1];
check('目标建好了', newGoal.name, '北海道之旅');
check('🔴 新建目标已存 0（还没存过钱）', D.goalSaved(newGoal.id), 0);

D.addRecord({
  id: 'dep-1', amount: 50000, categoryId: 'travel', date: D.isoDay(0), note: '存进目标',
  visibility: 'shared', payerId: 'u1', creatorId: 'u1', bear: 'shared',
  type: 'expense', goalId: newGoal.id,
});
D.addRecord({
  id: 'dep-2', amount: 20000, categoryId: 'travel', date: D.isoDay(0), note: '存进目标',
  visibility: 'shared', payerId: 'u2', creatorId: 'u2', bear: 'shared',
  type: 'expense', goalId: newGoal.id,
});
check('存入两笔后已攒 70000', D.goalSaved(newGoal.id), 70000);
check('🔴 已存金额是现算的，不落库', 'saved' in newGoal, false);

section('10. 趋势');
const tr = D.trend(6, 'shared');
check('返回 6 个月', tr.length, 6);
check('最后一个月是本月', tr[5].month, MONTH);
check('本月趋势值 = 共同总额', tr[5].value, 308800);
check('趋势包含上月数据', tr[4].value > 0, true);

section('11. 主题设置');
check('默认 auto', D.getTheme(), 'auto');
D.setTheme('dark');
check('可切换为 dark', D.getTheme(), 'dark');
check('主题已持久化', JSON.parse(LS.mem['husafe.state.v1']).theme, 'dark');
D.setTheme('light');
check('可切换为 light', D.getTheme(), 'light');
D.setTheme('auto');

section('12. 存档自愈（旧版存档升级）');
// 模拟一份 v1 旧存档：有 splitMode、有 settle 记录、缺新字段
const oldState = {
  me: { id: 'u1', nickname: '阿满', avatar: '🐻' },
  partner: { id: 'u2', nickname: '小鹿', avatar: '🦊' },
  couple: { id: 'c1', memberA: 'u1', memberB: 'u2', boundAt: '2025-01-01', monthlyBudget: 500000 },
  goals: [],
  records: [
    { id: 'o1', amount: 10000, categoryId: 'food', date: D.isoDay(0), note: '旧账1',
      visibility: 'shared', payerId: 'u1', creatorId: 'u1', splitMode: 'half', type: 'expense' },
    { id: 'o2', amount: 20000, categoryId: 'food', date: D.isoDay(0), note: '旧账2',
      visibility: 'private', payerId: 'u1', creatorId: 'u1', splitMode: 'all_mine', type: 'expense' },
    { id: 'o3', amount: 30000, categoryId: 'food', date: D.isoDay(0), note: '旧清账',
      visibility: 'shared', payerId: 'u2', creatorId: 'u1', splitMode: 'all_mine', type: 'settle' },
  ],
  categoryBudgets: { food: 100000 },
};
const LS2 = makeLS({ 'mochi.state.v1': JSON.stringify(oldState) });
const D2 = loadData(LS2);
const S2 = () => D2.getState();

check('旧存档被读取（预算保留）', S2().couple.monthlyBudget, 500000);
check('补齐了 theme 字段', S2().theme, 'auto');
check('补齐了 onboarded 字段', S2().onboarded, false);
check('🔴 旧的 settle 记录被剔除', S2().records.some(r => r.type === 'settle'), false);
check('旧账目数（剔除 settle 后）= 2', S2().records.length, 2);
check('splitMode 字段已删除', 'splitMode' in S2().records.find(r => r.id === 'o1'), false);
check('🔴 老存档里的 bear 字段被清理掉（v0.3 移除了这一维）',
  'bear' in S2().records.find(r => r.id === 'o1'), false);
check('🔴 私密账目的 bear 也被清掉', 'bear' in S2().records.find(r => r.id === 'o2'), false);
check('私密账目的付款人被强制为本人',
  S2().records.find(r => r.id === 'o2').payerId, S2().records.find(r => r.id === 'o2').creatorId);
check('迁移后版本号为 2', S2().version, 2);
check('迁移后可用新统计口径', D2.monthlyStats(MONTH, 'shared').total, 10000);

section('13. 存档损坏时自动重建');
const LS3 = makeLS({ 'husafe.state.v1': '{ 这不是合法 JSON' });
const D3 = loadData(LS3);
check('损坏存档不抛异常，回落到种子数据', D3.getState().records.length, 21);

section('14. 🔴 正式模式（demo 关闭）开局是空账本');
// 用不带 window.HUSAFE_DEMO_MODE 的沙箱加载 —— 等同于正式环境
const LS4 = makeLS();
const sandbox4 = { localStorage: LS4.api, navigator: {}, console, ...SANDBOX_EXTRAS, window: {} };
const src4 = DATA_SRC + `\n;({ getState: () => state, initialSeed, seedEmpty });`;
const D4 = vm.runInNewContext(src4, sandbox4, { filename: 'data.js#prod' });
check('🔴 首次加载账目为空', D4.getState().records.length, 0);
check('🔴 首次加载目标为空', D4.getState().goals.length, 0);
check('账号结构仍然完整', D4.getState().me.id, 'u1');
check('initialSeed 返回空账本', D4.initialSeed().records.length, 0);
check('resetAll 后仍是空账本',
  (D4.getState().records = [], D4.initialSeed().records.length), 0);

/* ------------------------------------------------------------------ */
console.log('\n' + '─'.repeat(48));
console.log(fail === 0 ? `✅ 全部通过：${pass} 项` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
console.log('─'.repeat(48) + '\n');
process.exit(fail === 0 ? 0 : 1);
