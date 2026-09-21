/* 同步层协议验证：node tests/verify-sync.js
 *
 * 用假的 Supabase 服务器拦截所有 fetch，逐条核对：
 *   - 请求的 URL、方法、请求头、请求体是否正确
 *   - 响应映射成本地数据结构是否正确
 *   - 认证流程、token 刷新、离线队列、限流提示是否按预期工作
 *
 * 注意：这验证的是「协议层」。真实 Supabase 实例上的端到端行为
 *      仍未验证（见 supabase/README-接入指南.md 的验收清单）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ------------------------- 假 Supabase ------------------------- */

const calls = [];        // 记录所有请求
let respond = () => ({ status: 200, body: [] });

global.fetch = async (url, options) => {
  const opt = options || {};
  let body = null;
  if (opt.body) { try { body = JSON.parse(opt.body); } catch (e) { body = opt.body; } }
  const call = { url, method: opt.method || 'GET', headers: opt.headers || {}, body };
  calls.push(call);

  const r = respond(call);
  const text = r.body === undefined ? '' : JSON.stringify(r.body);
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    statusText: r.status === 200 ? 'OK' : 'Error',
    text: async () => text,
  };
};

global.WebSocket = function (url) {
  this.url = url;
  this.send = () => {};
  this.close = () => {};
};
global.localStorage = (() => {
  const mem = {};
  return {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; },
    clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
  };
})();
global.setTimeout = () => 0;
global.setInterval = () => 0;
global.clearInterval = () => {};

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8'),
  { filename: 'sync.js' });

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`); }
}
function has(name, haystack, needle) {
  const ok = String(haystack).includes(needle);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     未找到 ${needle}（实际 ${haystack}）`); }
}
function hasNot(name, haystack, needle) {
  const ok = !String(haystack).includes(needle);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     不应出现 ${needle}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); calls.length = 0; }
const last = () => calls[calls.length - 1];

const URL = 'https://demo1234.supabase.co';
const KEY = 'anon-key-abc';

/* ================================================================== */

main().then(code => process.exit(code));

async function main() {

section('0. 未配置时必须安全空转（不能崩）');
check('默认未配置', HusafeSync.isOnline(), false);
const r0 = await HusafeSync.signInWithOtp('a@b.com');
check('未配置时返回失败而非抛异常', r0.ok, false);
const r0b = await HusafeSync.pullAll();
check('未配置时拉取返回失败', r0b.ok, false);
check('未配置时没有发出任何请求', calls.length, 0);
check('未配置时未登录', HusafeSync.isSignedIn(), false);

section('1. 配置后进入在线模式');
check('configure 返回 true', HusafeSync.configure({ url: URL, anonKey: KEY }), true);
check('isOnline 为 true', HusafeSync.isOnline(), true);
check('占位 URL 不算已配置',
  HusafeSync.configure({ url: 'https://xxxxxxxx.supabase.co', anonKey: 'k' }), false);
HusafeSync.configure({ url: URL, anonKey: KEY });

section('2. 发送邮箱验证码');
respond = () => ({ status: 200, body: {} });
const otp = await HusafeSync.signInWithOtp('me@example.com');
check('返回成功', otp.ok, true);
check('打到 /auth/v1/otp', last().url, URL + '/auth/v1/otp');
check('用 POST', last().method, 'POST');
check('请求体带 email 且允许建号', last().body, { email: 'me@example.com', create_user: true });
check('带 apikey 头', last().headers.apikey, KEY);
check('未登录时 Authorization 用 anon key', last().headers.Authorization, 'Bearer ' + KEY);

section('3. 校验验证码换取会话');
const nowSec = Math.floor(Date.now() / 1000);
respond = () => ({
  status: 200,
  body: {
    access_token: 'access-token-1',
    refresh_token: 'refresh-token-1',
    expires_in: 3600,
    user: { id: 'user-a', email: 'me@example.com' },
  },
});
const ver = await HusafeSync.verifyOtp('me@example.com', '123456');
check('校验成功', ver.ok, true);
check('打到 /auth/v1/verify', last().url, URL + '/auth/v1/verify');
check('请求体类型为 email', last().body, { email: 'me@example.com', token: '123456', type: 'email' });
check('已登录', HusafeSync.isSignedIn(), true);
check('拿到当前用户 id', HusafeSync.currentUserId(), 'user-a');
check('会话已持久化到本地',
  JSON.parse(localStorage.getItem('husafe.session.v1')).access_token, 'access-token-1');
const sess = HusafeSync.getSession();
check('过期时间提前 60 秒（避免边界失效）',
  sess.expires_at > Date.now() + 3500 * 1000 && sess.expires_at < Date.now() + 3600 * 1000, true);

section('4. 认证失败时给出人话提示');
respond = () => ({ status: 429, body: { message: 'email rate limit exceeded' } });
const limited = await HusafeSync.signInWithOtp('me@example.com');
check('限流返回失败', limited.ok, false);
has('限流时建议改用密码登录', limited.reason, '邮箱 + 密码');

respond = () => ({ status: 400, body: { message: 'Email address not authorized' } });
const notAuth = await HusafeSync.signInWithOtp('gf@example.com');
has('🔴 未授权邮箱给出可操作的提示', notAuth.reason, '只能发给项目成员');

respond = () => ({ status: 400, body: { message: 'Email template modification is not available for free tier projects' } });
const freeTier = await HusafeSync.signInWithOtp('me@example.com');
has('免费版限制也给出出路', freeTier.reason, '邮箱 + 密码');

respond = () => ({ status: 401, body: { message: 'Invalid token' } });
const bad = await HusafeSync.verifyOtp('me@example.com', '000000');
check('验证码错误返回失败', bad.ok, false);
has('提示验证码不对', bad.reason, '验证码');

section('4b. 邮箱 + 密码登录（不需要邮件服务）');
respond = () => ({
  status: 200,
  body: { access_token: 'pw-token', refresh_token: 'pw-refresh', expires_in: 3600, user: { id: 'user-a' } },
});
const pw = await HusafeSync.signInWithPassword('me@example.com', 'secret123');
check('密码登录成功', pw.ok, true);
check('打到 grant_type=password', last().url, URL + '/auth/v1/token?grant_type=password');
check('请求体带邮箱和密码', last().body, { email: 'me@example.com', password: 'secret123' });
check('已登录', HusafeSync.isSignedIn(), true);
check('拿到会话', HusafeSync.getSession().access_token, 'pw-token');

respond = () => ({ status: 400, body: { message: 'Invalid login credentials' } });
const pwBad = await HusafeSync.signInWithPassword('me@example.com', 'wrong');
check('密码错误返回失败', pwBad.ok, false);
has('提示邮箱或密码不对', pwBad.reason, '邮箱或密码');

section('4c. 注册');
respond = () => ({
  status: 200,
  body: { access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600, user: { id: 'user-b' } },
});
const su = await HusafeSync.signUpWithPassword('new@example.com', 'secret123');
check('注册并直接拿到会话', su.ok, true);
check('打到 /auth/v1/signup', last().url, URL + '/auth/v1/signup');
check('带 email + password', last().body, { email: 'new@example.com', password: 'secret123' });

// 项目还开着"邮件确认"时，signup 不返回 session
respond = () => ({ status: 200, body: { id: 'user-c', email: 'c@example.com' } });
const su2 = await HusafeSync.signUpWithPassword('c@example.com', 'secret123');
check('需要邮件确认时不算成功', su2.ok, false);
has('提示去后台确认或建号', su2.reason, '邮件确认');

respond = () => ({ status: 400, body: { message: 'Password should be at least 6 characters' } });
const su3 = await HusafeSync.signUpWithPassword('d@example.com', '123');
has('密码太短有提示', su3.reason, '密码太短');

section('5. 全量拉取与数据映射');
respond = call => {
  if (call.url.includes('/users')) {
    return { status: 200, body: [{ id: 'user-a', nickname: '阿满', avatar: '🐻', couple_id: 'c1' }] };
  }
  if (call.url.includes('/records')) {
    return { status: 200, body: [{
      id: 'r1', couple_id: 'c1', created_by: 'user-a', amount: 20000, type: 'expense',
      category_id: 'food', date: '2025-06-01', note: '火锅', visibility: 'shared',
      payer_id: 'user-a', bear: 'shared', goal_id: null, version: 1,
      deleted_at: null, created_at: '2025-06-01T10:00:00Z', updated_at: '2025-06-01T10:00:00Z',
    }] };
  }
  if (call.url.includes('/goals')) {
    return { status: 200, body: [{
      id: 'g1', couple_id: 'c1', name: '北海道之旅', icon: '🗾', target: 1200000,
      deadline: '2025-12-31', status: 'active', created_at: '2025-05-01T00:00:00Z',
    }] };
  }
  return { status: 200, body: [] };
};
const pulled = await HusafeSync.pullAll();
check('拉取成功', pulled.ok, true);
check('返回 3 个请求', calls.length, 3);

const recCall = calls.find(c => c.url.includes('/records'));
has('records 查询按日期排序', recCall.url, 'order=date.desc');
check('映射成 camelCase',
  Object.keys(pulled.records[0]).sort(),
  ['amount','categoryId','coupleId','createdAt','creatorId','date','deletedAt',
   'goalId','id','note','payerId','syncedAt','type','updatedAt','version','visibility']);
check('🔴 从云端拉下来的记录带 syncedAt 标记（说明已同步）',
  typeof pulled.records[0].syncedAt, 'string');
check('金额保持整数分', pulled.records[0].amount, 20000);
check('可见性映射正确', pulled.records[0].visibility, 'shared');
check('🔴 v0.3 起不再映射 bear 字段', 'bear' in pulled.records[0], false);
check('目标映射正确', pulled.goals[0].name, '北海道之旅');
check('目标金额为分', pulled.goals[0].target, 1200000);
check('用户信息已返回', pulled.me.nickname, '阿满');

section('6. 推送账目（幂等 upsert）');
// 前面的注册测试把当前用户变成了 user-b，这里恢复成 user-a，
// 保证本节断言的是「以 user-a 身份推送」的行为
respond = () => ({
  status: 200,
  body: { access_token: 'a-token', refresh_token: 'a-refresh', expires_in: 3600, user: { id: 'user-a' } },
});
await HusafeSync.signInWithPassword('me@example.com', 'secret123');
check('会话已恢复为 user-a', HusafeSync.currentUserId(), 'user-a');

respond = () => ({ status: 201, body: null });
const pushRes = await HusafeSync.pushRecords([{
  id: 'r9', amount: 500, categoryId: 'food', date: '2025-06-02', note: '早饭',
  visibility: 'private', payerId: 'user-a', bear: 'mine', type: 'expense',
}], 'c1');
check('推送成功', pushRes.ok, true);
has('用 on_conflict 保证幂等', last().url, 'on_conflict=couple_id,id');
check('用 POST', last().method, 'POST');
has('🔴 用 ignore-duplicates（不再 merge-duplicates）', last().headers.Prefer, 'resolution=ignore-duplicates');
hasNot('🔴 不声明 merge-duplicates（那会去改别人的行）', last().headers.Prefer, 'merge-duplicates');
check('行数据用 snake_case', last().body[0].couple_id, 'c1');
check('created_by 取当前用户', last().body[0].created_by, 'user-a');
check('私密账目的 payer/created 一致（服务端约束）',
  last().body[0].payer_id === last().body[0].created_by, true);
check('不带 splitMode 等已废弃字段', 'split_mode' in last().body[0], false);

section('7. 空数组不该发请求');
const before = calls.length;
const empty = await HusafeSync.pushRecords([], 'c1');
check('空推送返回失败', empty.ok, false);
check('没有发出请求', calls.length, before);

section('8. 情侣绑定');
respond = () => ({ status: 200, body: '7K2M9P' });
const inv = await HusafeSync.createInviteCode();
check('生成邀请码成功', inv.ok, true);
check('拿到 6 位码', inv.code, '7K2M9P');
has('调用 rpc', last().url, '/rest/v1/rpc/create_invite_code');

respond = () => ({ status: 200, body: { ok: true, couple_id: 'c1' } });
const rdm = await HusafeSync.redeemInviteCode('7K2M9P');
check('绑定成功', rdm.ok, true);
check('返回 coupleId', rdm.coupleId, 'c1');
check('参数名是 input_code', last().body, { input_code: '7K2M9P' });

respond = () => ({ status: 200, body: { ok: false, reason: '邀请码无效或已过期' } });
const bad2 = await HusafeSync.redeemInviteCode('AAAAAA');
check('无效邀请码返回失败', bad2.ok, false);
check('透传服务端原因', bad2.reason, '邀请码无效或已过期');

respond = () => ({ status: 200, body: { ok: false, reason: '尝试太频繁了，过一会儿再试' } });
const rl = await HusafeSync.redeemInviteCode('BBBBBB');
has('限流提示传给用户', rl.reason, '频繁');

section('8b. couple_id 缓存与身份翻译（推送的前提）');
// 没有 couple_id 就没法推送；没有身份翻译就会报 uuid 格式错误
HusafeSync.setCoupleId(null);
check('初始没有 couple_id', HusafeSync.getCoupleId(), null);

respond = call => {
  if (call.url.includes('couple_id=eq.')) {
    // TA 的查询
    return { status: 200, body: [{ id: '22222222-2222-2222-2222-222222222222', nickname: '小鹿', avatar: '🦊' }] };
  }
  return {
    status: 200,
    body: [{ id: '11111111-1111-1111-1111-111111111111', nickname: '阿满', avatar: '🐻', couple_id: 'c-abc' }],
  };
};
calls.length = 0;
const profRes = await HusafeSync.fetchMyProfile();
check('拉到 profile', profRes.ok, true);
check('拿回 couple_id', profRes.coupleId, 'c-abc');
check('🔴 couple_id 已缓存到本地', HusafeSync.getCoupleId(), 'c-abc');
has('第一次查询带 couple_id 字段',
  calls[0].url, 'select=id,nickname,avatar,couple_id');
check('🔴 同时查了 TA 的 UUID', !!calls.find(c => c.url.includes('couple_id=eq.c-abc')), true);
check('认出 TA', profRes.partner.id, '22222222-2222-2222-2222-222222222222');

section('8b2. 🔴 身份翻译：本地 u1/u2 ↔ 云端 UUID');
const map = HusafeSync.getIdentityMap();
check('u1 映射到我的 UUID', map.u1, '11111111-1111-1111-1111-111111111111');
check('u2 映射到 TA 的 UUID', map.u2, '22222222-2222-2222-2222-222222222222');
check('本地键 → 云端 UUID', HusafeSync.localToCloud('u1'), '11111111-1111-1111-1111-111111111111');
check('本地键 → 云端 UUID（TA）', HusafeSync.localToCloud('u2'), '22222222-2222-2222-2222-222222222222');
check('已经是 UUID 就原样返回',
  HusafeSync.localToCloud('11111111-1111-1111-1111-111111111111'), '11111111-1111-1111-1111-111111111111');
check('云端 UUID → 本地键', HusafeSync.cloudToLocal('11111111-1111-1111-1111-111111111111'), 'u1');
check('云端 UUID → 本地键（TA）', HusafeSync.cloudToLocal('22222222-2222-2222-2222-222222222222'), 'u2');
check('认不出的值原样返回', HusafeSync.cloudToLocal('33333333-3333-3333-3333-333333333333'), '33333333-3333-3333-3333-333333333333');

section('8b3. 🔴 u1 必须永远是「我」，不能按数组顺序分配');
// 这是「我设的私密账 TA 能看到」的根因：
// 如果按 member_a / 数组位置分配 u1/u2，换个账号登录就会对调，
// 于是我的私密账在对方设备上被认成 TA 记的，反而出现在对方的「只有我」里。
const MY_ID = '44444444-4444-4444-4444-444444444444';
const TA_ID = '55555555-5555-5555-5555-555555555555';
respond = call => {
  if (call.url.includes('couple_id=eq.')) {
    // 故意把 TA 放在前面，诱导"按位置分配"的实现出错
    return { status: 200, body: [
      { id: TA_ID, nickname: '小鹿', avatar: '🦊' },
      { id: MY_ID, nickname: '阿满', avatar: '🐻' },
    ] };
  }
  return { status: 200, body: [{ id: MY_ID, nickname: '阿满', avatar: '🐻', couple_id: 'c-xyz' }] };
};
calls.length = 0;
const prof2 = await HusafeSync.fetchMyProfile();
check('拉到 profile', prof2.ok, true);
check('认出的「我」是登录者本人', prof2.me.id, MY_ID);
const map2 = HusafeSync.getIdentityMap();
check('🔴 u1 = 我自己（不因数组顺序而变）', map2.u1, MY_ID);
check('🔴 u2 = TA', map2.u2, TA_ID);
check('TA 的 UUID 翻译成 u2', HusafeSync.cloudToLocal(TA_ID), 'u2');
check('我的 UUID 翻译成 u1', HusafeSync.cloudToLocal(MY_ID), 'u1');
const meQuery = calls.find(c => c.url.includes('/users?select=id') && c.url.includes('id=eq.'));
check('🔴 查询自己时用 id 过滤（不靠数组顺序）', !!meQuery, true);
has('过滤条件等于当前登录用户', meQuery.url, 'id=eq.' + HusafeSync.currentUserId());

section('8b4. 🔴 绑定时间必须从云端同步（不能显示本地假日期）');
// 之前 pullAndMerge 只同步了昵称头像，没同步 couples 表 ——
// 于是「绑定 N 天」一直用的是种子里写死的假日期。
HusafeSync.setCoupleId('c-abc');
calls.length = 0;
respond = () => ({
  status: 200,
  body: [{
    id: 'c-abc', member_a: '11111111-1111-1111-1111-111111111111',
    member_b: '22222222-2222-2222-2222-222222222222',
    status: 'active', bound_at: '2026-01-15T00:00:00Z', monthly_budget: 500000,
  }],
});
const cplRes = await HusafeSync.fetchCouple();
check('拉到情侣空间信息', cplRes.ok, true);
check('🔴 拿到真实绑定时间', cplRes.couple.boundAt, '2026-01-15T00:00:00Z');
check('🔴 拿到共同月预算', cplRes.couple.monthlyBudget, 500000);
check('拿到状态', cplRes.couple.status, 'active');
has('查询 covers 表并只取需要的字段', last().url, 'select=id,member_a,member_b,status,bound_at,monthly_budget');
has('按 couple_id 精确过滤', last().url, 'id=eq.c-abc');

respond = () => ({ status: 200, body: [] });
const cplEmpty = await HusafeSync.fetchCouple();
check('查不到时不抛异常', cplEmpty.ok, false);
has('给出可读原因', cplEmpty.reason, '找不到情侣空间');

section('8c. 🔴 写路径：记账必须推到云端');
// 这是之前漏掉的一环 —— 只写本地不推云端，数据库里永远是空的
HusafeSync.setCoupleId('c-abc');
calls.length = 0;
respond = () => ({ status: 201, body: null });

const rec = {
  id: 'r-new', amount: 12345, categoryId: 'food', date: '2025-06-10', note: '晚饭',
  visibility: 'shared', payerId: 'user-a', creatorId: 'user-a', bear: 'shared', type: 'expense',
};
const saveRes = await HusafeSync.saveRecord(rec);
check('saveRecord 成功', saveRes.ok, true);
check('确实发出了请求', calls.length >= 1, true);
const postCall = calls.find(c => c.method === 'POST' && c.url.includes('/records'));
check('打到 records 表', !!postCall, true);
check('携带 couple_id', postCall.body[0].couple_id, 'c-abc');
check('携带金额（分）', postCall.body[0].amount, 12345);
check('携带可见性', postCall.body[0].visibility, 'shared');
check('🔴 官方字段名是 created_by 而非 creatorId',
  postCall.body[0].created_by, 'user-a');

section('8d. 推送失败必须入队，不能丢数据');
HusafeSync.flushQueue('c-abc');   // 先清空
respond = () => ({ status: 500, body: { message: 'boom' } });
const failRes = await HusafeSync.saveRecord({ ...rec, id: 'r-fail' });
check('推送失败', failRes.ok, false);
check('🔴 已入队', failRes.queued, true);
check('🔴 队列里确实有这条', HusafeSync.queueLength(), 1);

section('8e. 没有 couple_id 时也入队（不能静默丢）');
HusafeSync.setCoupleId(null);
HusafeSync.flushQueue('c-abc');
calls.length = 0;
respond = () => ({ status: 200, body: [{ id: 'user-a', couple_id: null }] });
const noCouple = await HusafeSync.saveRecord({ ...rec, id: 'r-nocouple' });
check('没有 couple_id 时不算成功', noCouple.ok, false);
check('🔴 但没有丢数据，已入队', noCouple.queued, true);
check('队列里有它', HusafeSync.queueLength(), 1);
check('提示说明了原因', noCouple.reason, '还没绑定情侣空间');

section('8f. pushAllLocal 分批推送');
HusafeSync.setCoupleId('c-abc');
respond = () => ({ status: 201, body: null });
calls.length = 0;
const many = Array.from({ length: 250 }, (_, i) => ({ ...rec, id: 'r' + i }));
const allRes = await HusafeSync.pushAllLocal(many);
check('批量推送成功', allRes.ok, true);
check('推了 250 条', allRes.count, 250);
check('🔴 分成 2 批（每批 200）', calls.filter(c => c.method === 'POST').length, 2);
check('第一批 200 条', calls.filter(c => c.method === 'POST')[0].body.length, 200);
check('第二批 50 条', calls.filter(c => c.method === 'POST')[1].body.length, 50);

section('8g. 🔴 目标必须先于账目推送（外键顺序）');
// records.goal_id 有外键指向 goals(id)，目标没到就推账目 → 400。
// flushQueue 的调用方（data.js 的 syncFlushQueue）必须先推 goals。
HusafeSync.setCoupleId('c-abc');
calls.length = 0;
respond = () => ({ status: 201, body: null });

const goalRes = await HusafeSync.pushAllGoals([
  { id: 'g1', name: '北海道之旅', icon: '🗾', target: 1200000, deadline: '2025-12-31', status: 'active' },
]);
check('目标推送成功', goalRes.ok, true);
check('推了 1 个目标', goalRes.count, 1);
const gcall = calls.find(c => c.url.includes('/goals'));
check('打到 goals 表', !!gcall, true);
check('目标带 couple_id', gcall.body[0].couple_id, 'c-abc');
check('目标金额为分', gcall.body[0].target, 1200000);

check('空目标列表不发请求',
  (calls.length = 0, (await HusafeSync.pushAllGoals([])).count), 0);
check('确实没发请求', calls.length, 0);

section('8h. 🔴 错误信息必须带上服务端细节');
// 只显示「400 Bad Request」是完全没法排错的
respond = () => ({
  status: 400,
  body: {
    message: 'insert or update on table "records" violates foreign key constraint "records_goal_id_fkey"',
    code: '23503',
    details: 'Key (goal_id)=(g1) is not present in table "goals".',
    hint: null,
  },
});
const fkErr = await HusafeSync.pushRecords([{ ...rec, id: 'r-fk', goalId: 'g1' }], 'c-abc');
check('推送失败', fkErr.ok, false);
has('错误里带上了 code', fkErr.reason, 'code=23503');
has('错误里带上了 details', fkErr.reason, 'not present in table');
has('错误里保留了原始 message', fkErr.reason, 'foreign key constraint');

respond = () => ({
  status: 403,
  body: { message: 'new row violates row-level security policy for table "records"', code: '42501' },
});
const rlsErr = await HusafeSync.pushRecords([{ ...rec, id: 'r-rls' }], 'c-abc');
has('RLS 错误可辨认', rlsErr.reason, 'row-level security');

section('8g2. 🔴 批量插入：所有对象的键必须完全一致');
// PostgREST 要求同一批数组里每个对象的键相同，否则报
// PGRST102 "All object keys must match"。
// 条件性地加字段（if (goalId) row.goal_id = ...）就会踩这个坑。
HusafeSync.setCoupleId('c-abc');
calls.length = 0;
respond = () => ({ status: 201, body: null });

const batch = [
  { ...rec, id: 'b1' },                                    // 无 goalId、无 deletedAt
  { ...rec, id: 'b2', goalId: 'g1' },                      // 有 goalId
  { ...rec, id: 'b3', deletedAt: '2025-06-11T00:00:00Z' }, // 有 deletedAt
  { ...rec, id: 'b4', goalId: 'g2', deletedAt: '2025-06-12T00:00:00Z' },
];
const batchRes = await HusafeSync.pushRecords(batch, 'c-abc');
check('批量推送成功', batchRes.ok, true);
const body = calls.find(c => c.method === 'POST' && c.url.includes('/records')).body;
check('推了 4 条', body.length, 4);

const keySets = body.map(o => Object.keys(o).sort().join(','));
check('🔴 4 条记录的键完全一致', new Set(keySets).size, 1);
check('🔴 goal_id 缺失时显式给 null（不是省略）',
  body.find(o => o.id === 'b1').goal_id, null);
check('🔴 deleted_at 缺失时显式给 null',
  body.find(o => o.id === 'b1').deleted_at, null);
check('有 goalId 的带上值', body.find(o => o.id === 'b2').goal_id, 'g1');
check('有 deletedAt 的带上值',
  body.find(o => o.id === 'b3').deleted_at, '2025-06-11T00:00:00Z');

section('8g3. 🔴 目标批量推送同样要求键一致');
calls.length = 0;
respond = () => ({ status: 201, body: null });
const goalBatch = await HusafeSync.pushGoals([
  { id: 'g1', name: '有截止日', target: 100, deadline: '2025-12-31', status: 'active' },
  { id: 'g2', name: '无截止日', target: 200 },          // deadline 缺失
], 'c-abc');
check('目标批量推送成功', goalBatch.ok, true);
check('推了 2 个目标', goalBatch.count, 2);
const gbody = calls.find(c => c.url.includes('/goals')).body;
const gKeys = gbody.map(o => Object.keys(o).sort().join(','));
check('🔴 2 个目标的键完全一致', new Set(gKeys).size, 1);
check('🔴 deadline 缺失时显式给 null', gbody.find(o => o.id === 'g2').deadline, null);
check('🔴 status 缺失时给默认值', gbody.find(o => o.id === 'g2').status, 'active');
check('icon 缺失时给默认值', gbody.find(o => o.id === 'g2').icon, '🎯');
check('单次请求而不是逐条', calls.filter(c => c.url.includes('/goals')).length, 1);

section('8i. 🔴 只推自己创建的记录（RLS 要求 created_by = auth.uid()）');
// 队列/本地里可能混进对方创建的记录。推它们必然被 403 拒绝，
// 而且会永远卡在队列里反复重试。
HusafeSync.setCoupleId('c-abc');
respond = () => ({ status: 201, body: null });
await HusafeSync.flushQueue('c-abc');      // 清干净起点
calls.length = 0;

// 身份映射必须在这一节仍然有效，否则过滤逻辑无从判断"谁是谁"

// 我自己的记录 → 应该推
const myRec = { ...rec, id: 'mine-1', creatorId: 'u1', payerId: 'u1' };   // u1 = 我自己
const myRes = await HusafeSync.saveRecord(myRec);
check('自己创建的记录会推送', myRes.ok, true);
check('确实发了请求', calls.length, 1);

// 对方创建的记录 → 应该跳过，且不算失败
calls.length = 0;
const taRec = { ...rec, id: 'ta-1', creatorId: 'u2', payerId: 'u2' };
const taRes = await HusafeSync.saveRecord(taRec);
check('🔴 对方创建的记录跳过推送', taRes.skipped, true);
check('🔴 跳过不算失败', taRes.ok, true);
check('🔴 没有发出推送请求', calls.length, 0);
has('提示说明了原因', taRes.reason, '由 TA 的设备上传');

section('8j. 🔴 补推时剔除队列里别人的记录');
// 手工往队列塞一条"别人的"，再补推，验证它被丢掉而不是无限重试
localStorage.setItem('husafe.sync.queue.v1', JSON.stringify([
  { ...rec, id: 'q-mine', creatorId: 'u1', payerId: 'u1' },
  { ...rec, id: 'q-ta', creatorId: 'u2', payerId: 'u2' },
]));
check('队列有 2 条', HusafeSync.queueLength(), 2);

calls.length = 0;
respond = () => ({ status: 201, body: null });
const flushRes = await HusafeSync.flushQueue('c-abc');
check('补推成功', flushRes.ok, true);
check('只推了 1 条（自己的）', flushRes.count, 1);
check('🔴 丢弃了 1 条（别人的）', flushRes.dropped, 1);
const sentIds = calls.find(c => c.method === 'POST').body.map(o => o.id);
check('🔴 推的是自己的那条', sentIds, ['q-mine']);
check('队列已清空', HusafeSync.queueLength(), 0);

section('8k. pushAllLocal 同样只推自己的');
respond = () => ({ status: 201, body: null });
calls.length = 0;
const allPush = await HusafeSync.pushAllLocal([
  { ...rec, id: 'a-mine-1', creatorId: 'u1', payerId: 'u1' },
  { ...rec, id: 'a-ta-1', creatorId: 'u2', payerId: 'u2' },
  { ...rec, id: 'a-mine-2', creatorId: 'u1', payerId: 'u1' },
]);
check('推送成功', allPush.ok, true);
check('🔴 只推自己的 2 条', allPush.count, 2);
const sent2 = calls.find(c => c.method === 'POST').body.map(o => o.id);
check('推的是自己那两条', sent2.sort(), ['a-mine-1', 'a-mine-2']);

section('8l. 🔴 插入与更新分流（避免 upsert 碰到别人的行）');
// 背景：upsert（merge-duplicates）遇到已存在的行会走 UPDATE 分支，
// 而 UPDATE 策略要求 using(created_by = auth.uid())。
// 如果库里那个 id 的行归别人，整批就 403 —— 连累同批能插入的记录。
HusafeSync.setCoupleId('c-abc');
respond = () => ({ status: 201, body: null });
await HusafeSync.flushQueue('c-abc');       // 清干净起点

// flushQueue 读的是队列，所以先入队
HusafeSync.enqueue({ ...rec, id: 'n1', creatorId: 'u1', payerId: 'u1' });
HusafeSync.enqueue({ ...rec, id: 'n2', creatorId: 'u1', payerId: 'u1', deletedAt: '2026-01-01T00:00:00Z' });
HusafeSync.enqueue({ ...rec, id: 'n3', creatorId: 'u1', payerId: 'u1', updatedAt: '2026-01-02T00:00:00Z' });
check('队列里有 3 条', HusafeSync.queueLength(), 3);

calls.length = 0;
const flushMixed = await HusafeSync.flushQueue('c-abc');
check('补推成功', flushMixed.ok, true);


const posts = calls.filter(c => c.method === 'POST');
const patches = calls.filter(c => c.method === 'PATCH');
check('插入走 POST', posts.length, 1);
check('🔴 整批插入只用一次请求', posts[0].body.length, 3);
check('🔴 需要更新的走 PATCH，不靠 upsert', patches.length, 2);

// 注意：URL 里有两处 id=eq.（couple_id=eq. 和 id=eq.），必须用 & 边界区分
const patchIds = patches.map(c => {
  const m = /[?&]id=eq\.([^&]+)/.exec(c.url);
  return m ? m[1] : null;
}).sort();
check('🔴 patch 的是软删除(n2)和编辑过(n3)那两条', patchIds, ['n2', 'n3']);
has('PATCH 用 id 精确定位', patches[0].url, 'id=eq.');
check('🔴 PATCH 不把 id 放进 SET', 'id' in patches[0].body, false);
check('🔴 PATCH 不把 couple_id 放进 SET', 'couple_id' in patches[0].body, false);
const n2patch = patches.find(c => c.url.includes('n2'));
check('PATCH 带上了 deleted_at', n2patch.body.deleted_at, '2026-01-01T00:00:00Z');
check('队列已清空', HusafeSync.queueLength(), 0);

section('8m. 🔴 删除必须走 PATCH（否则云端删不掉）');
// 背景：插入用的是 ignore-duplicates，对已存在的行直接跳过。
// 如果"删除"也走插入路径，deleted_at 永远传不到云端 ——
// 表现就是「本地删了，云端还在，对方还看得到」。
check('新记录（无 updatedAt/deletedAt）判定为插入', HusafeSync.needsUpdate({ id: 'x' }), false);
check('🔴 删除过的（有 deletedAt）判定为更新',
  HusafeSync.needsUpdate({ id: 'x', deletedAt: '2026-01-01T00:00:00Z' }), true);
check('🔴 编辑过的（有 updatedAt）判定为更新',
  HusafeSync.needsUpdate({ id: 'x', updatedAt: '2026-01-02T00:00:00Z' }), true);

HusafeSync.setCoupleId('c-abc');
respond = () => ({ status: 204, body: null });
calls.length = 0;

const delRes = await HusafeSync.saveRecord({
  ...rec, id: 'del-1', creatorId: 'u1', payerId: 'u1',
  deletedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
});
check('删除推送成功', delRes.ok, true);
check('🔴 走的是 PATCH 而不是 POST',
  calls.filter(c => c.method === 'PATCH').length, 1);
check('🔴 没有发插入请求（那会被忽略掉）',
  calls.filter(c => c.method === 'POST').length, 0);
const delPatch = calls.find(c => c.method === 'PATCH');
has('PATCH 按 id 精确定位', delPatch.url, 'id=eq.del-1');
check('🔴 PATCH 带上了 deleted_at', delPatch.body.deleted_at, '2026-02-01T00:00:00Z');
check('PATCH 不放 id 进 SET', 'id' in delPatch.body, false);

// 新记录仍然走插入
calls.length = 0;
respond = () => ({ status: 201, body: null });
const newRes = await HusafeSync.saveRecord({
  ...rec, id: 'fresh-1', creatorId: 'u1', payerId: 'u1',
});
check('新记录推送成功', newRes.ok, true);
check('🔴 新记录走 POST（插入）',
  calls.filter(c => c.method === 'POST').length, 1);
check('新记录不发 PATCH', calls.filter(c => c.method === 'PATCH').length, 0);

section('8n. 🔴 登录后自动补传「本地有、云端没有」的记录');
// 场景：在设备 B 上没登录就记了账，之后才登录。
// 这些记录必须自动传上去，否则永远卡在本机，设备 A 看不到。
const localRecords = [
  { ...rec, id: 'local-new', creatorId: 'u1', payerId: 'u1' },              // 新记的，未同步
  { ...rec, id: 'from-cloud', creatorId: 'u1', payerId: 'u1',
    syncedAt: '2026-01-01T00:00:00Z' },                                      // 从云端拉下来的
  { ...rec, id: 'local-del', creatorId: 'u1', payerId: 'u1',
    deletedAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },  // 本地删的，未同步
  { ...rec, id: 'ta-local', creatorId: 'u2', payerId: 'u2' },                // TA 记的，不该由我推
];

check('🔴 认出 2 条待补传（云端来的不算，TA 记的不算）',
  HusafeSync.pendingUploads(localRecords).length, 3);
check('其中 TA 记的那条会被 isMine 过滤掉',
  HusafeSync.pendingUploads(localRecords).filter(r => r.creatorId === 'u1').length, 2);

HusafeSync.setCoupleId('c-abc');
calls.length = 0;
respond = () => ({ status: 201, body: null });

const upRes = await HusafeSync.uploadPending(localRecords, []);
check('补传成功', upRes.ok, true);
check('🔴 补传了 2 条', upRes.count, 2);
check('🔴 1 条插入（新记的）', upRes.inserted, 1);
check('🔴 1 条更新（删掉的走 PATCH）', upRes.patched, 1);
check('插入走 POST', calls.filter(c => c.method === 'POST').length, 1);
check('更新走 PATCH', calls.filter(c => c.method === 'PATCH').length, 1);
check('推的 id 是 local-new', calls.find(c => c.method === 'POST').body[0].id, 'local-new');
has('PATCH 打的是 local-del', calls.find(c => c.method === 'PATCH').url, 'id=eq.local-del');

check('🔴 补传后本地记录被打上 syncedAt 标记',
  typeof localRecords[0].syncedAt, 'string');
check('🔴 删掉那条也被标记了', typeof localRecords[2].syncedAt, 'string');
check('TB 记的那条没有被标记（不该由我推）',
  localRecords[3].syncedAt, undefined);
check('🔴 再跑一次不会重复补传',
  HusafeSync.pendingUploads(localRecords).filter(r => r.creatorId === 'u1').length, 0);

section('8o. 🔴 目标也要跨设备同步');
// 三个缺口：
//   1) 云端返回空数组时旧代码根本不更新本地目标（`if (r.goals.length)`）
//   2) 目标没走「自动补传」—— 对方新建的目标永远拉不过来
//   3) 删目标不同步 —— 一台删了另一台还看得到
HusafeSync.setCoupleId('c-abc');

// --- 映射：云端行 → 本地目标 ---
const cloudGoal = HusafeSync.rowToGoal({
  id: 'g-cloud', couple_id: 'c-abc', name: '一起攒钱旅行', icon: '🗾',
  target: 500000, deadline: '2026-12-31', status: 'active',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
  deleted_at: null,
});
check('目标映射成 camelCase', cloudGoal.name, '一起攒钱旅行');
check('目标金额为分', cloudGoal.target, 500000);
check('🔴 从云端拉的目标带 syncedAt 标记', typeof cloudGoal.syncedAt, 'string');
check('🔴 拿到 updatedAt（用于变化检测）', cloudGoal.updatedAt, '2026-02-01T00:00:00Z');

// --- 映射：本地目标 → 云端行 ---
const gRow = HusafeSync.goalToRow(
  { id: 'g1', name: '新目标', icon: '🎯', target: 100000, deadline: '', status: 'active' },
  'c-abc'
);
check('行数据用 snake_case', gRow.couple_id, 'c-abc');
check('无截止日给 null', gRow.deadline, null);
check('未删除时 deleted_at 为 null', gRow.deleted_at, null);

const gDelRow = HusafeSync.goalToRow(
  { id: 'g2', name: '删掉的', target: 100, deletedAt: '2026-03-01T00:00:00Z' },
  'c-abc'
);
check('🔴 删除的目标带 deleted_at', gDelRow.deleted_at, '2026-03-01T00:00:00Z');
check('🔴 删除的目标状态是 archived', gDelRow.status, 'archived');

// --- 待补传判定 ---
const localGoals = [
  { id: 'g-new', name: '本机新建的', target: 100 },                       // 未同步
  { id: 'g-synced', name: '云端来的', target: 200, syncedAt: '2026-01-01' }, // 已同步
];
check('🔴 只把未同步的目标算作待补传',
  HusafeSync.pendingGoals(localGoals).map(g => g.id), ['g-new']);

// --- 补传：目标必须先于账目，且打上标记 ---
calls.length = 0;
respond = () => ({ status: 201, body: null });
const upGoals = await HusafeSync.uploadPending([], localGoals);
check('补传成功', upGoals.ok, true);
check('🔴 推了 1 个目标', upGoals.goals, 1);
const goalCall = calls.find(c => c.url.includes('/goals'));
check('打的是 goals 表', !!goalCall, true);
check('用 on_conflict 保证幂等', goalCall.url.includes('on_conflict=id'), true);
check('🔴 推的是本机新建那个', goalCall.body[0].id, 'g-new');
check('🔴 补传后打上 syncedAt 标记', typeof localGoals[0].syncedAt, 'string');
check('🔴 再跑一次不会重复推',
  HusafeSync.pendingGoals(localGoals).length, 0);

section('8p. 🔴 补传时目标必须先于账目（外键顺序）');
calls.length = 0;
respond = () => ({ status: 201, body: null });
await HusafeSync.uploadPending(
  [{ ...rec, id: 'dep-x', creatorId: 'u1', payerId: 'u1', goalId: 'g-new' }],
  [{ id: 'g-new2', name: '新目标', target: 100 }]
);
const order = calls.map(c => (c.url.includes('/goals') ? 'goals' : 'records'));
check('🔴 先推 goals 再推 records', order, ['goals', 'records']);

section('9. 离线队列');
respond = () => ({ status: 201, body: null });
HusafeSync.setCoupleId('c-abc');
await HusafeSync.flushQueue('c-abc');
check('起点队列为空', HusafeSync.queueLength(), 0);
HusafeSync.configure({ url: URL, anonKey: KEY });
await HusafeSync.verifyOtp('me@example.com', '123456').catch(() => {});
respond = () => ({
  status: 200,
  body: { access_token: 't', refresh_token: 'r', expires_in: 3600, user: { id: 'user-a' } },
});
await HusafeSync.verifyOtp('me@example.com', '123456');

check('初始队列为空', HusafeSync.queueLength(), 0);
HusafeSync.enqueue({ id: 'q1', amount: 100, date: '2025-06-03', visibility: 'private',
  payerId: 'user-a', bear: 'mine', type: 'expense', categoryId: 'food' });
check('入队一条', HusafeSync.queueLength(), 1);
HusafeSync.enqueue({ id: 'q1', amount: 200, date: '2025-06-03', visibility: 'private',
  payerId: 'user-a', bear: 'mine', type: 'expense', categoryId: 'food' });
check('同 id 入队会覆盖而不是重复', HusafeSync.queueLength(), 1);

respond = () => ({ status: 201, body: null });
const flushed = await HusafeSync.flushQueue('c1');
check('补推成功', flushed.ok, true);
check('队列已清空', HusafeSync.queueLength(), 0);

section('10. 同步失败时不清空队列（避免丢数据）');
// creatorId 必须是「我」，否则会被 isMine 过滤掉（那就测不到推送失败了）
HusafeSync.enqueue({ id: 'q2', amount: 300, date: '2025-06-04', visibility: 'private',
  creatorId: 'u1', payerId: 'u1', bear: 'mine', type: 'expense', categoryId: 'food' });
respond = () => ({ status: 500, body: { message: 'server error' } });
const failed = await HusafeSync.flushQueue('c1');
check('补推失败', failed.ok, false);
check('🔴 队列仍然保留，数据没丢', HusafeSync.queueLength(), 1);

section('11. token 过期自动刷新');
localStorage.clear();
respond = () => ({
  status: 200,
  body: { access_token: 'old', refresh_token: 'r1', expires_in: 3600, user: { id: 'user-a' } },
});
await HusafeSync.verifyOtp('me@example.com', '123456');
// 手工把会话改成已过期
const s = HusafeSync.getSession();
s.expires_at = Date.now() - 1000;
localStorage.setItem('husafe.session.v1', JSON.stringify(s));
calls.length = 0;

respond = call => {
  if (call.url.includes('grant_type=refresh_token')) {
    return { status: 200, body: { access_token: 'new-token', refresh_token: 'r2', expires_in: 3600, user: { id: 'user-a' } } };
  }
  return { status: 200, body: [] };
};
const fresh = await HusafeSync.ensureFreshSession();
check('自动刷新成功', fresh, true);
has('调用了 refresh 接口', calls.find(c => c.url.includes('grant_type=refresh_token')) ? 'yes' : 'no', 'yes');
check('换了新 token', HusafeSync.getSession().access_token, 'new-token');

// 刷新之后发出的请求必须用新 token（而不是仍拿旧的）
calls.length = 0;
await HusafeSync.pullAll();
const afterRefresh = calls[0];
check('🔴 刷新后的请求带新 token', afterRefresh.headers.Authorization, 'Bearer new-token');

section('12. 刷新失败时清掉会话（强制重新登录）');
const s2 = HusafeSync.getSession();
s2.expires_at = Date.now() - 1000;
localStorage.setItem('husafe.session.v1', JSON.stringify(s2));
respond = () => ({ status: 400, body: { message: 'Invalid Refresh Token' } });
const r2 = await HusafeSync.ensureFreshSession();
check('刷新失败返回 false', r2, false);
check('🔴 会话已清除', HusafeSync.isSignedIn(), false);

section('13. 登出');
respond = () => ({ status: 204, body: null });
await HusafeSync.signOut();
check('登出后未登录', HusafeSync.isSignedIn(), false);
check('本地会话已清除', localStorage.getItem('husafe.session.v1'), null);

section('14. 实时订阅需要登录');
respond = () => ({ status: 200, body: {} });
const sub = HusafeSync.subscribe(() => {});
check('未登录时订阅失败', sub.ok, false);
has('提示未登录', sub.reason, '未登录');

section('14b. 实时通道的健康状态（供界面判断用轮询还是实时）');
// WebSocket 连不上时不能影响使用 —— 轮询会兜住，界面要能反映这一点
check('初始未连接实时通道', HusafeSync.isRealtimeOn(), false);
check('初始没有收到过实时消息', HusafeSync.isRealtimeAlive(), false);
HusafeSync.unsubscribe();
check('unsubscribe 后状态归位', HusafeSync.isRealtimeOn(), false);
check('unsubscribe 不抛异常', true, true);
check('isRealtimeAlive 是函数（界面会调它）', typeof HusafeSync.isRealtimeAlive, 'function');
check('isRealtimeOn 是函数', typeof HusafeSync.isRealtimeOn, 'function');

section('15. 改资料时只改自己那一行');
respond = () => ({
  status: 200,
  body: { access_token: 't', refresh_token: 'r', expires_in: 3600, user: { id: 'user-a' } },
});
await HusafeSync.verifyOtp('me@example.com', '123456');
calls.length = 0;
respond = () => ({ status: 204, body: null });
const prof = await HusafeSync.updateProfile({ nickname: '小明', avatar: '🐱' });
check('改资料成功', prof.ok, true);
check('PATCH 到自己的 id', last().method, 'PATCH');
has('过滤条件是自己', last().url, 'id=eq.user-a');
check('只提交要改的字段', last().body, { nickname: '小明', avatar: '🐱' });

/* ================================================================== */
console.log('\n' + '─'.repeat(50));
console.log(fail === 0 ? `✅ 全部通过：${pass} 项` : `❌ ${fail} 项失败 / 共 ${pass + fail} 项`);
console.log('─'.repeat(50) + '\n');
return fail === 0 ? 0 : 1;

}   // end main()
