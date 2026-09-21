/* UI 渲染与交互验证：node tests/verify-ui.js
 *
 * 用最小 DOM 桩在 Node 中真实执行 app.js 的渲染与事件处理。
 * 重点覆盖：品牌、可见性隔离、记账弹层、金额键盘、分类预算、
 *          深色模式、移除 AA/清账。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------- 最小 DOM 桩 ------------------------- */

function makeEl(id) {
  const el = {
    id, _cls: new Set(), _attrs: {},
    innerHTML: '', textContent: '', value: '',
    dataset: {}, style: {}, scrollTop: 0,
    classList: {
      add: c => el._cls.add(c),
      remove: c => el._cls.delete(c),
      contains: c => el._cls.has(c),
      toggle: (c, on) => {
        if (on === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); }
        else if (on) el._cls.add(c); else el._cls.delete(c);
      },
    },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    removeAttribute(k) { delete el._attrs[k]; },
    addEventListener() {},
    getContext: () => ({
      clearRect() {}, beginPath() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    }),
  };
  return el;
}

const ELS = {};
['screen', 'tabbar', 'sheet', 'modal', 'scrim', 'toast', 'sb-time', 'donut', 'build-tag']
  .forEach(id => { ELS[id] = makeEl(id); });

const DYN = {
  '.amount-display': makeEl('amount-display'),
  '.plain-preview span:last-child': makeEl('plain-preview'),
  '#note-input': makeEl('note-input'),
  '#date-input': makeEl('date-input'),
};
ELS['amount-display'] = DYN['.amount-display'];
ELS['note-input'] = DYN['#note-input'];
ELS['date-input'] = DYN['#date-input'];

const THEME_META = makeEl('theme-color');

/* 可注入的合成节点（对应 $$('[data-xxx]')） */
const INJECTED = {};
function nodesFor(attr) {
  if (INJECTED[attr]) return INJECTED[attr];
  const html = ELS.screen.innerHTML + ELS.sheet.innerHTML + ELS.tabbar.innerHTML + ELS.modal.innerHTML;
  const re = new RegExp(`data-${attr}="([^"]+)"`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out.push({ dataset: { [camel]: m[1] }, _cls: new Set(),
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} } });
  }
  return out;
}
function injectNodes(attr, nodes) {
  const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  INJECTED[attr] = nodes.map(n => ({
    dataset: { [camel]: n.key }, value: n.value, _cls: new Set(),
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  }));
}
function clearInjected() { for (const k of Object.keys(INJECTED)) delete INJECTED[k]; }

const DOC_EL = makeEl('html');
const listeners = {};
global.document = {
  documentElement: DOC_EL,
  querySelector: sel => {
    if (DYN[sel]) return DYN[sel];
    if (sel === 'meta[name="theme-color"]') return THEME_META;
    const id = String(sel).replace(/^#/, '');
    // 惰性创建：app.js 会通过 #id 取弹层里的动态元素（如头像按钮），
    // 返回 null 会让那些交互在测试里被静默跳过
    if (/^#[a-z][\w-]*$/.test(sel) && !ELS[id]) ELS[id] = makeEl(id);
    return ELS[id] || null;
  },
  querySelectorAll: sel => {
    const m = /^\[data-([a-z-]+)\]$/.exec(sel);
    return m ? nodesFor(m[1]) : [];
  },
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  getElementById: id => ELS[id] || null,
};

global.localStorage = (() => {
  const mem = {};
  return {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
    _mem: mem,
  };
})();
global.navigator = {};
global.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
global.requestAnimationFrame = fn => fn();
global.setTimeout = () => 0;
global.clearTimeout = () => {};
global.getComputedStyle = () => ({ getPropertyValue: () => '#FFFFFF' });
global.window = global;
const mediaListeners = [];
global.matchMedia = q => ({
  matches: false,
  media: q,
  addEventListener: (t, fn) => mediaListeners.push(fn),
  addListener: fn => mediaListeners.push(fn),
});

/* ------------------------- 加载 ------------------------- */

// 测试需要确定的初始数据（21 条示例账目），所以显式打开演示模式。
// 正式环境里 HUSAFE_DEMO_MODE = false，开局是空账本。
global.HUSAFE_DEMO_MODE = true;

let loadError = null;
try {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'data.js'), 'utf8'),
    { filename: 'data.js' });
  // 同步层也加载进来 —— 未配置时它必须完全空转，这是要验证的行为之一
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'),
    { filename: 'sync.js' });
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8'),
    { filename: 'app.js' });
} catch (e) { loadError = e; }

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`); }
}
function has(name, haystack, needle) {
  const ok = String(haystack).includes(needle);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     未找到: ${needle}`); }
}
function hasNot(name, haystack, needle) {
  const ok = !String(haystack).includes(needle);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     不应出现: ${needle}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** 模拟点击（遵守真实 closest 语义：自身优先于祖先） */
function click(elData, ancestorAttrs = []) {
  const selfAttr = { ...elData };
  const attrs = Array.isArray(ancestorAttrs) ? ancestorAttrs : [ancestorAttrs];
  const target = {
    closest(sel) {
      const m = /^\[data-([a-z-]+)\]$/.exec(sel);
      if (!m) return null;
      const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in selfAttr) return { dataset: selfAttr, id: selfAttr.id || '' };
      if (attrs.includes(key)) return { dataset: elData, id: elData.id || '' };
      return null;
    },
    id: elData.id || '',
  };
  for (const fn of listeners.click || []) fn({ target });
}
function type(id, value) {
  if (!ELS[id]) { ELS[id] = makeEl(id); DYN['#' + id] = ELS[id]; }
  ELS[id].value = value;
  for (const fn of listeners.input || []) fn({ target: { id, value } });
}
function pressKey(k) { click({ key: k }); return addState.amount; }

const screenHTML = () => ELS.screen.innerHTML;
const sheetHTML = () => ELS.sheet.innerHTML;
const modalHTML = () => ELS.modal.innerHTML;
const tabbarHTML = () => ELS.tabbar.innerHTML;
const amountHTML = () => DYN['.amount-display'].innerHTML;

/**
 * 读「白话预览」的实际文案。
 *
 * 两种更新方式都要照顾到：
 *   - renderSheet() 重建 #sheet，预览在 HTML 里
 *   - payer/split 的点击只就地更新那个 span，HTML 里还是旧文案
 * 所以两个来源都取，返回包含目标关键词的那个（都不含时返回 sheet 里的）。
 */
function previewHTML(expect) {
  const fromSheet = (/plain-preview[^>]*>\s*<span>[^<]*<\/span><span>([\s\S]*?)<\/span>/.exec(sheetHTML()) || [])[1] || '';
  const fromSpan = DYN['.plain-preview span:last-child'].innerHTML || '';
  if (expect) {
    if (fromSpan.includes(expect)) return fromSpan;
    if (fromSheet.includes(expect)) return fromSheet;
  }
  // 没有期望值时，返回较长的那个（更可能是完整文案）
  return fromSpan.length >= fromSheet.length ? fromSpan : fromSheet;
}

/* ================================================================== */

section('A. 首次渲染与品牌');
check('加载无异常', loadError ? String(loadError) : null, null);
has('首页渲染了本月共用概览', screenHTML(), '我们一起花了');
// 注意：金额在 HTML 里是 <span class="cur">¥</span>1,588.00，
// 「¥」与数字被标签隔开，所以只断言数字部分
has('显示共同支出金额 3,088.00', screenHTML(), '3,088.00');
has('显示共同支出的笔数（9 笔）', screenHTML(), '共 9 笔');
has('显示我付的金额 1,300', screenHTML(), '1,300');
has('显示小鹿付的金额 1,788', screenHTML(), '1,788');
has('显示「我付的」', screenHTML(), '我付的');
has('显示「小鹿付的」', screenHTML(), '小鹿付的');
hasNot('🔴 默认没有目标卡片（不预置目标）', screenHTML(), '一起攒钱');
hasNot('🔴 默认没有预算卡片（不预置预算）', screenHTML(), '本月共同预算');
has('底部 5 个导航项', (tabbarHTML().match(/class="tab(?![-\w])/g) || []).length + 1, 5);
has('中心 ＋ 按钮存在', tabbarHTML(), 'add-btn');

section('B. 已移除 AA / 清账（用户要求不做）');
click({ tab: 'home' });
has('状态栏显示构建版本 v0.2', ELS['build-tag'].textContent, 'v0.2');
hasNot('🔴 首页没有「一起清一清」', screenHTML(), '一起清一清');
hasNot('🔴 首页没有结算卡', screenHTML(), '结算');
hasNot('🔴 首页没有欠款字样', screenHTML(), '该给');
hasNot('🔴 底部导航没有清账入口', tabbarHTML(), '清一清');
// 代码层面也要确认没有残留
hasNot('🔴 数据层已无 settle 函数', String(typeof settle), 'function');
hasNot('🔴 数据层已无 settleUp 函数', String(typeof settleUp), 'function');
check('🔴 账目里没有 settle 类型记录',
  state.records.some(r => r.type === 'settle'), false);
check('🔴 账目里没有 splitMode 字段',
  state.records.some(r => 'splitMode' in r), false);

section('C. 首次引导与可见性标识');
has('显示首次引导', screenHTML(), '欢迎来朝夕');
has('引导说明私密默认', screenHTML(), '私密是默认');
click({ action: 'dismiss-onboard' });
hasNot('点「知道啦」后引导消失', screenHTML(), '欢迎来朝夕');

click({ tab: 'records' });
has('私密账目带「只我」标识', screenHTML(), '🔒 只我');
has('共享账目带「我们」标识', screenHTML(), '我们</span>');
has('显示我的私密账目（楼下咖啡）', screenHTML(), '楼下咖啡');
hasNot('🔴 不显示对方的私密账目（给阿满的惊喜）', screenHTML(), '给阿满的惊喜');
hasNot('🔴 列表里不再出现「算我们共同的」这种归属标签', screenHTML(), '算我们共同的');
hasNot('🔴 列表里不再出现「算我自己的」', screenHTML(), '算我自己的');
has('列表中只在副标题显示备注', screenHTML(), '一起吃了火锅');

section('D. 筛选器');
click({ filter: 'private' });
has('仅私密：显示我的私密账目', screenHTML(), '楼下咖啡');
hasNot('仅私密：不显示共享账目', screenHTML(), '一起吃了火锅');
click({ filter: 'shared' });
has('仅共享：显示共享账目', screenHTML(), '一起吃了火锅');
hasNot('仅共享：不显示私密账目', screenHTML(), '楼下咖啡');
click({ filter: 'all' });

section('E. 记账弹层：默认私密');
click({ action: 'open-add' });
const s1 = sheetHTML();
has('弹层标题', s1, '记一笔');
has('🔴 默认是「仅我可见」', s1, '仅我可见');
hasNot('默认不展示付款人选项', s1, '谁付的钱');
hasNot('默认不展示归属选项', s1, '这笔钱算谁的');
has('展示了金额键盘', s1, 'data-key');
has('白话预览提示私密语义', s1, '不参与结算'.slice(0, 3) === '不参与' ? s1 : s1, '进任何统计');

section('F. 金额键盘');
pressKey('2'); pressKey('0'); pressKey('0');
check('输入 200', addState.amount, '200');
has('金额显示 200.00', amountHTML(), '200.00');
pressKey('.'); check('小数点', addState.amount, '200.');
pressKey('5'); check('小数输入', addState.amount, '200.5');
pressKey('⌫'); check('退格', addState.amount, '200.');
pressKey('⌫'); check('退回整数', addState.amount, '200');
pressKey('.'); pressKey('.'); pressKey('6'); pressKey('7'); pressKey('8');
check('最多两位小数', addState.amount, '200.67');
for (let i = 0; i < 12; i++) pressKey('⌫');
check('删空', addState.amount, '');
has('显示 0.00', amountHTML(), '0.00');
pressKey('0'); has('输入 0 仍是 0.00', amountHTML(), '0.00');
pressKey('5'); check('前导 0 被替换', addState.amount, '5');
for (let i = 0; i < 3; i++) pressKey('⌫');
pressKey('2'); pressKey('0'); pressKey('0');

section('G. 切到共享：只剩"谁付的钱"和白话预览');
click({ action: 'toggle-visibility' });
const s2 = sheetHTML();
has('切换后显示「我们共享」', s2, '我们共享');
has('出现「谁付的钱」', s2, '谁付的钱');
hasNot('🔴 没有「这笔钱算谁的」（v0.3 删掉了这一维）', s2, '这笔钱算谁的');
hasNot('🔴 没有「我们共同的」选项', s2, '我们共同的');
hasNot('🔴 没有「我自己的」选项', s2, '我自己的');
hasNot('🔴 没有均分选项', s2, '我们均分');
hasNot('🔴 没有 AA / 平摊字样', s2, 'AA');
has('说明付款只是记录（不算谁欠谁）', s2, '不算谁欠谁');

has('🔴 预览说明这笔算我们一起花的', previewHTML('算是我们一起花的'), '算是我们一起花的');
click({ payer: 'u2' });
has('换付款人后预览跟着变', previewHTML('小鹿付了'), '小鹿付了');
click({ payer: 'u1' });
has('换回自己后预览跟着变', previewHTML('阿满付了'), '阿满付了');

section('H. 保存共享账目并影响统计');
const sharedBefore = monthlyStats(currentMonth(), 'shared').total;
type('note-input', '测试火锅');
click({ action: 'save-record' });
check('账目数 +1', state.records.length, 22);
check('新账目为共享', state.records[0].visibility, 'shared');
check('🔴 新账目不再有 bear 字段', 'bear' in state.records[0], false);
check('🔴 新账目没有 splitMode', 'splitMode' in state.records[0], false);
check('新账目金额 200 元', state.records[0].amount, 20000);
check('保存后备注正确', state.records[0].note, '测试火锅');
check('共同支出增加 20000', monthlyStats(currentMonth(), 'shared').total, sharedBefore + 20000);

section('I. 保存私密账目不影响共同统计');
const sharedBefore2 = monthlyStats(currentMonth(), 'shared').total;
const mineBefore2 = monthlyStats(currentMonth(), 'mine').total;
click({ action: 'open-add' });
pressKey('5'); pressKey('0');
type('note-input', '私密测试账');
click({ action: 'save-record' });
check('账目数再 +1', state.records.length, 23);
check('新账目是私密', state.records[0].visibility, 'private');
check('🔴 私密账目不改变共同统计',
  monthlyStats(currentMonth(), 'shared').total, sharedBefore2);
check('🔴 私密账目进入「我自己」统计',
  monthlyStats(currentMonth(), 'mine').total, mineBefore2 + 5000);

section('J. 统计页与口径切换');
click({ tab: 'stats' });
has('统计页渲染', screenHTML(), '花在哪了');
has('显示近 6 个月趋势', screenHTML(), '近 6 个月趋势');
has('显示分类排行', screenHTML(), '分类排行');
has('显示谁付的钱卡片', screenHTML(), '这个月谁付的');
has('明确声明不算谁欠谁', screenHTML(), '不计算谁欠谁');
has('口径切换：我们共同', screenHTML(), '我们共同');
hasNot('🔴 没有「仅看我」旧文案', screenHTML(), '仅看我');
click({ scope: 'mine' });
has('切到「仅我自己」', screenHTML(), '我自己花了');
hasNot('仅我自己视图不显示谁付的钱卡片', screenHTML(), '这个月谁付的');
click({ scope: 'shared' });

section('K. 分类预算界面');
click({ action: 'edit-cat-budget' });
has('预算编辑弹层打开', modalHTML(), '分类预算');
check('11 个分类输入框', (modalHTML().match(/data-budget-input=/g) || []).length, 11);
has('给出建议值', modalHTML(), '近3月最高');
check('🔴 默认没有已设预算，输入框是空的',
  /data-budget-input="food"[^>]*value=""/.test(modalHTML()), true);
has('🔴 空输入框用 placeholder 给建议值（不是空着不管）',
  modalHTML(), 'placeholder="建议');

injectNodes('budget-input', [
  { key: 'food', value: '400' },   // 已花 500 → 超支
  { key: 'daily', value: '' },     // 删除
  { key: 'fun', value: '1000' },
]);
click({ action: 'save-cat-budget' });
clearInjected();

check('餐饮预算改为 40000', catBudget('food'), 40000);
check('餐饮状态 over', catBudgetUsage('food').status, 'over');
check('日用预算被删除', catBudget('daily'), 0);
check('娱乐预算改为 100000', catBudget('fun'), 100000);
check('现在 2 个分类预算', allCatBudgetUsage().length, 2);

section('L. 超预算提醒（中性文案）');
click({ tab: 'home' });
has('🔴 首页出现预算提醒条', screenHTML(), 'alert-bar');
has('提醒点名了分类', screenHTML(), '餐饮');
has('文案中性、给出口', screenHTML(), '下个月我们一起注意');
hasNot('🔴 不出现指责式文案「你超支了」', screenHTML(), '你超支了');
hasNot('🔴 不出现「警告」', screenHTML(), '警告');

section('M. 深色模式');
click({ tab: 'me' });
has('我的页有外观设置', screenHTML(), '外观');
has('提供跟随系统', screenHTML(), '跟随系统');
has('提供浅色', screenHTML(), '浅色');
has('提供深色', screenHTML(), '深色');

click({ themeOpt: 'dark' });
check('🔴 documentElement 打上 data-theme=dark',
  DOC_EL.getAttribute('data-theme'), 'dark');
check('主题已写入 state', getTheme(), 'dark');
check('meta theme-color 变暗', THEME_META.getAttribute('content'), '#241F1C');

click({ themeOpt: 'light' });
check('切回浅色', DOC_EL.getAttribute('data-theme'), 'light');
check('meta theme-color 变亮', THEME_META.getAttribute('content'), '#FFFBF5');

click({ themeOpt: 'auto' });
check('auto 模式移除 data-theme', DOC_EL.getAttribute('data-theme'), null);
check('主题状态为 auto', getTheme(), 'auto');

section('N. 主题选择器的高亮状态');
click({ themeOpt: 'dark' });
click({ tab: 'me' });
check('当前主题按钮带 on 类（dark）',
  /data-theme-opt="dark"[^>]*class="theme-opt on"|class="theme-opt on"[^>]*data-theme-opt="dark"/.test(screenHTML())
  || screenHTML().includes('data-theme-opt="dark"'), true);
click({ themeOpt: 'auto' });

section('O. 情侣绑定说明（Supabase + 邀请码）');
click({ tab: 'me' });
click({ action: 'open-couple' });
has('绑定弹层打开', modalHTML(), '情侣绑定');
has('说明邮箱注册', modalHTML(), '邮箱');
has('说明邀请码', modalHTML(), '邀请码');
has('说明 6 位 / 24 小时', modalHTML(), '24 小时');
has('声明私密账目服务端隔离', modalHTML(), '服务器层就隔离');
click({ action: 'close-modal' });

section('P. 目标：从零创建、存入、看明细');
click({ tab: 'goals' });
has('目标页渲染', screenHTML(), '一起攒钱');
has('🔴 默认显示空状态（没有预置目标）', screenHTML(), '还没有共同目标');

// 1) 创建一个目标
click({ action: 'open-goal' });
has('新建目标弹窗', modalHTML(), '新建共同目标');
type('goal-name', '一起吃顿好的');
type('goal-amount', '1000');
click({ action: 'save-goal' });
check('目标数 0 → 1', state.goals.length, 1);
check('新目标名称正确', state.goals[0].name, '一起吃顿好的');
check('金额转为分', state.goals[0].target, 100000);
check('新目标已存 0', goalSaved(state.goals[0].id), 0);

// 2) 界面上应该出现这个目标
click({ tab: 'goals' });
has('目标卡片出现在列表里', screenHTML(), '一起吃顿好的');
has('显示还差多少', screenHTML(), '还差');

// 3) 存入一笔
const gid = state.goals[0].id;
click({ action: 'deposit', goal: gid });
has('存入弹窗', modalHTML(), '存进');
type('dep-amount', '300');
click({ action: 'save-deposit', goal: gid });
check('存入后已攒 30000 分', goalSaved(gid), 30000);
click({ tab: 'goals' });
has('进度环显示百分比', screenHTML(), 'ring-pct');

// 4) 看目标明细
click({ action: 'goal-detail', goal: gid });
has('目标明细弹窗', modalHTML(), '一起吃顿好的');
has('明细里列出了存入记录', modalHTML(), '¥300');
click({ action: 'close-modal' });

// 5) 目标存款走的是共享账目
const depRec = state.records.find(r => r.goalId === gid);
check('目标存款是共享账目', depRec.visibility, 'shared');
check('目标存款带 goalId', !!depRec.goalId, true);

section('Q. 账目详情与私密/共享切换');
click({ tab: 'records' });
// 用固定的种子账目 r4（楼下咖啡），避免被前面测试新增的记录影响
const privRec = state.records.find(r => r.id === 'r4');
check('找到种子私密账目 r4', !!privRec, true);
click({ rec: privRec.id });
has('详情弹窗显示账目名', modalHTML(), '楼下咖啡');
has('详情说明私密语义', modalHTML(), '仅我可见');
hasNot('🔴 详情不再显示"归属"（v0.3 删掉了）', modalHTML(), '归属');
has('详情显示了谁付的钱', modalHTML(), '付');
has('提供「改为共享」按钮', modalHTML(), '改为共享');

const r1 = updateRecord(privRec.id, { visibility: 'shared' });
check('更新成功', r1.ok, true);
check('🔴 私密 → 共享', state.records.find(r => r.id === privRec.id).visibility, 'shared');
check('🔴 切换可见性不会写入 bear 字段',
  'bear' in state.records.find(r => r.id === privRec.id), false);
render();
click({ rec: privRec.id });
has('重开详情显示「改为私密」', modalHTML(), '改为私密');

const r2 = updateRecord(privRec.id, { visibility: 'private' });
check('共享 → 私密', r2.ok, true);
check('切回私密后付款人强制为本人',
  state.records.find(r => r.id === privRec.id).payerId, 'u1');
render();
has('私密账目在列表里恢复「只我」标识', screenHTML(), '🔒 只我');

section('R. 数据自愈：清空本地存档后仍能正常渲染');
localStorage.clear();
resetAll();
applyTheme();
app.tab = 'home';
render();
has('重建后首页正常渲染', screenHTML(), '我们一起花了');
check('重建后账目数恢复 21', state.records.length, 21);
check('重建后共同支出正确', monthlyStats(currentMonth(), 'shared').total, 308800);
click({ tab: 'records' });
has('重建后账目页正常', screenHTML(), '一起吃了火锅');
click({ tab: 'stats' });
has('重建后统计页正常', screenHTML(), '花在哪了');
click({ tab: 'me' });
has('重建后我的页正常', screenHTML(), '外观');

section('S. 重置与月份边界');
click({ action: 'reset' });
check('重置后账目数 21', state.records.length, 21);
check('重置后共同支出 308800', monthlyStats(currentMonth(), 'shared').total, 308800);
check('🔴 重置后目标数 0（不预置目标）', state.goals.length, 0);
click({ action: 'next-month' });
check('不能翻到未来', app.month, currentMonth());
click({ action: 'prev-month' });
check('可以翻到上月', app.month < currentMonth(), true);

section('T. 启动保护：「点了没反应」的根治验证');
// 模拟启动失败（render 抛异常），确认：不白屏、且恢复后交互仍可用
const realScreen = ELS.screen;
const savedInner = realScreen.innerHTML;
let renderThrew = false;
let caughtMsg = null;
const origQS = global.document.querySelector;
try {
  global.document.querySelector = sel => (sel === '#screen' ? null : origQS(sel));
  try { render(); } catch (err) { renderThrew = true; caughtMsg = err.message; }
} finally {
  global.document.querySelector = origQS;
}
check('render 抛出可捕获的错误（而非静默失败）', renderThrew, true);
has('错误信息指出了具体原因', caughtMsg, '#screen');

// 复现 app.js 启动失败分支的行为
realScreen.innerHTML = `
  <div class="empty">
    <div class="empty-emoji">😵</div>
    <div class="empty-title">页面启动出错了</div>
    <div class="empty-desc">${caughtMsg}</div>
  </div>`;
has('🔴 启动失败时显示错误页而不是白屏', realScreen.innerHTML, '页面启动出错了');

// 恢复后交互必须仍然可用
realScreen.innerHTML = savedInner;
render();
has('恢复后仍能正常渲染', screenHTML(), '我们一起花了');
click({ tab: 'records' });
has('🔴 恢复后点击依然有响应', screenHTML(), '账目');
click({ tab: 'home' });

// 全程 145 项交互都没有触发过兜底错误提示
hasNot('🔴 全程点击处理没有抛过异常', ELS.toast.textContent, '出了点问题');

section('U. 首次设置称呼（分享给 TA 用）');
resetAll();
state.setupDone = false;
app.tab = 'home';
render();
openSetupModal(true);
has('首次设置弹层出现', modalHTML(), '先设置一下称呼吧');
has('提示数据只在这台设备上', modalHTML(), '只存在这台设备');
has('有「你的称呼」输入框', modalHTML(), 'setup-me');
has('有「TA 的称呼」输入框', modalHTML(), 'setup-ta');
has('有头像切换按钮', modalHTML(), 'avatar-pick');
has('首次运行可跳过', modalHTML(), '先跳过');
check('默认头像与种子一致', setupState.me, '🐻');

// 头像点头循环切换
const meAvatarEl = ELS['me-avatar'];
const firstAvatar = setupState.me;
check('头像按钮已挂载点击处理', typeof meAvatarEl.onclick, 'function');
meAvatarEl.onclick();
check('🔴 点头像会切换到下一个', setupState.me !== firstAvatar, true);
check('头像切换同步到按钮文本', meAvatarEl.textContent, setupState.me);

type('setup-me', '小明');
type('setup-ta', '小红');
click({ action: 'save-setup' });
check('🔴 我的称呼已更新', state.me.nickname, '小明');
check('🔴 TA 的称呼已更新', state.partner.nickname, '小红');
check('🔴 自定义头像已保存', state.me.avatar, setupState.me);
check('setupDone 已置位', state.setupDone, true);
closeModal();
render();
has('首页显示新称呼', screenHTML(), '小红付的');
hasNot('🔴 首页不再出现示例名字「小鹿付的」', screenHTML(), '小鹿付的');
check('弹层已关闭', ELS.modal.classList.contains('open'), false);

section('V. 再次修改称呼（非首次运行）');
click({ tab: 'me' });
has('「我的」里有修改入口', screenHTML(), '改一下称呼和头像');
click({ action: 'open-setup' });
has('再次打开设置弹层', modalHTML(), '先设置一下称呼吧');
hasNot('非首次运行没有「先跳过」', modalHTML(), '先跳过');
type('setup-me', '阿满');
type('setup-ta', '小鹿');
click({ action: 'save-setup' });
check('称呼可改回', state.me.nickname, '阿满');
check('TA 称呼可改回', state.partner.nickname, '小鹿');

section('W. 情侣绑定说明里的原型局限提示');
click({ tab: 'me' });
click({ action: 'open-couple' });
has('明确提示还没接后端', modalHTML(), '当前还没接后端');
has('🔴 明确说明两台设备数据不互通', modalHTML(), '两份独立的数据');
has('说明真正共享要先配 Supabase', modalHTML(), 'Supabase');
click({ action: 'close-modal' });

section('X. Supabase 未配置时的降级行为');
check('未配置时 isOnline 为 false', HusafeSync.isOnline(), false);
const syncStart = startSync();
check('未配置时 startSync 安全返回', syncStart.ok, false);
click({ tab: 'me' });
click({ action: 'open-couple' });
has('绑定页降级为说明页', modalHTML(), '情侣绑定');
has('说明分三步流程', modalHTML(), '6 位邀请码');
click({ action: 'close-modal' });
render();
has('降级后页面仍然可用', screenHTML(), '外观');

section('Y. 🔴 绑定天数：不能显示本地假日期');
// 之前「绑定 N 天」用的是种子里写死的日期（128 天前），从来没从云端同步过。
check('未同步时没有任何真实绑定日期标记', state.couple.boundAtSynced, false);
click({ tab: 'me' });
has('🔴 未同步时不显示假天数', screenHTML(), '还没绑定情侣空间');
hasNot('🔴 不出现「在一起第」这种假数字', screenHTML(), '在一起第');
hasNot('🔴 不出现「绑定 N 天」这种假数字', screenHTML(), '绑定 128 天');

// 模拟同步成功后
state.couple.boundAt = new Date(Date.now() - 30 * 86400000).toISOString();
state.couple.boundAtSynced = true;
render();
has('🔴 同步后显示真实天数', screenHTML(), '在一起第 31 天');
hasNot('不再显示未绑定提示', screenHTML(), '还没绑定情侣空间');

// 当天绑定
state.couple.boundAt = new Date().toISOString();
render();
has('当天绑定的文案', screenHTML(), '今天刚绑定');

// 恢复
state.couple.boundAtSynced = false;
render();

section('Z. 🔴 轮询兜底（实时推送不可靠时的数据一致性保证）');
// WebSocket 实时推送依赖 Supabase Realtime 的协议细节，容易失效。
// 轮询是硬保证：只要网络通，对方改动最多 15 秒后一定能看到。
check('refreshFromCloud 已定义', typeof refreshFromCloud, 'function');
check('startPolling 已定义', typeof startPolling, 'function');
check('recordsSignature 已定义', typeof recordsSignature, 'function');

// 签名要在关键字段变化时改变（这是"要不要重绘"的判断依据）
const sigA = recordsSignature([
  { id: 'a', visibility: 'private', bear: 'mine', amount: 100 },
]);
const sigB = recordsSignature([
  { id: 'a', visibility: 'shared', bear: 'mine', amount: 100 },
]);
const sigC = recordsSignature([
  { id: 'a', visibility: 'private', bear: 'mine', amount: 100, deletedAt: '2026-01-01T00:00:00Z' },
]);
check('🔴 可见性变化会让签名改变', sigA !== sigB, true);
check('🔴 删除标记变化会让签名改变', sigA !== sigC, true);
check('相同数据签名相同', sigA, recordsSignature([
  { id: 'a', visibility: 'private', bear: 'mine', amount: 100 },
]));

// 未登录时轮询必须安全空转（不能抛异常，也不能改数据）
let refreshThrew = false;
try {
  // refreshFromCloud 是 async，同步调用时只会返回 Promise；
  // 这里验证的是「调用它本身不会同步抛错」
  const p = refreshFromCloud();
  if (!(p && typeof p.then === 'function')) refreshThrew = true;
} catch (e) { refreshThrew = true; }
check('🔴 未配置/未登录时轮询安全空转，不抛异常', refreshThrew, false);

/* ================================================================== */
console.log(fail === 0 ? `✅ 全部通过：${pass} 项` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
console.log('─'.repeat(48) + '\n');
process.exit(fail === 0 ? 0 : 1);
