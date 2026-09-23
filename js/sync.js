/* ==========================================================================
   朝夕 Husafe · Supabase 同步层
   
   设计原则（见 supabase/README-接入指南.md）：
     - 离线优先：永远先写本地，再后台推送
     - 全量拉取而不是增量同步：两个人一年约 2000 条，简单方案最可靠
     - 不做 CRDT：update 冲突用 updatedAt 新者胜 + 提示用户
     - 私密账目的隔离由数据库 RLS 保证，不依赖前端
   
   这一层是「可选的」：没配置 Supabase 时，所有方法都安全地空转，
   原型照常以纯本地模式工作。
   ========================================================================== */

const HusafeSync = (function () {
  /* ---------------------------- 配置 ---------------------------- */

  let cfg = { url: '', anonKey: '' };
  let online = false;          // 是否已配置且可用
  let session = null;          // { access_token, refresh_token, expires_at, user }

  const SESSION_KEY = 'husafe.session.v1';

  const configured = () =>
    !!(cfg.url && cfg.anonKey &&
       !cfg.url.includes('xxxx') &&
       cfg.url.startsWith('http'));

  function configure(next) {
    cfg = Object.assign({}, cfg, next || {});
    online = configured();
    return online;
  }

  function isOnline() { return online; }

  /* ---------------------------- 会话 ---------------------------- */

  function saveSession(s) {
    session = s;
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
    return session;
  }
  function clearSession() {
    session = null;
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function getSession() { return session || loadSession(); }

  function currentUserId() {
    const s = getSession();
    return (s && s.user && s.user.id) || null;
  }

  function isSignedIn() { return !!currentUserId(); }

  /* ---------------------------- HTTP ---------------------------- */

  function headers(extra) {
    const h = Object.assign({
      'apikey': cfg.anonKey,
      'Content-Type': 'application/json',
    }, extra || {});
    const s = getSession();
    h['Authorization'] = 'Bearer ' + (s && s.access_token ? s.access_token : cfg.anonKey);
    return h;
  }

  async function request(path, options) {
    const opt = options || {};
    const fullUrl = cfg.url.replace(/\/+$/, '') + path;
    const hdrs = headers(opt.headers);
    const bodyText = opt.body ? JSON.stringify(opt.body) : undefined;

    const res = await fetch(fullUrl, {
      method: opt.method || 'GET',
      headers: hdrs,
      body: bodyText,
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

    if (!res.ok) {
      // 失败时把「发了什么」和「收到什么」完整打出来，
      // 方便和探针的成功请求逐字段对比。只用 warn，不刷屏。
      if ((res.status === 403 || res.status === 400) && typeof console !== 'undefined') {
        console.warn('[husafe] 请求失败详情 ─────────');
        console.warn('[husafe] URL    :', fullUrl);
        console.warn('[husafe] method :', opt.method || 'GET');
        console.warn('[husafe] header :', {
          apikeyHead: hdrs.apikey ? hdrs.apikey.slice(0, 18) + '…' : '(无)',
          Prefer: hdrs.Prefer || '(无)',
          contentType: hdrs['Content-Type'] || '(无)',
          authLen: hdrs.Authorization ? hdrs.Authorization.length : 0,
          authTail: hdrs.Authorization ? hdrs.Authorization.slice(-12) : '(无)',
        });
        console.warn('[husafe] body   :', bodyText);
        console.warn('[husafe] 响应   :', text);
        console.warn('[husafe] ─────────────────────');
      }

      const msg = (data && (data.message || data.error_description || data.msg)) || res.statusText;
      // 带上 Supabase 返回的 code / details / hint —— 排错全靠它们。
      // 只报一个 400 是完全没法定位的。
      const extra = [];
      if (data && data.code) extra.push('code=' + data.code);
      if (data && data.details) extra.push('details=' + data.details);
      if (data && data.hint) extra.push('hint=' + data.hint);
      const err = new Error(`[${res.status}] ${msg}` + (extra.length ? ' (' + extra.join(', ') + ')' : ''));
      err.status = res.status;
      err.payload = data;
      err.supabaseCode = (data && data.code) || null;
      throw err;
    }
    return data;
  }

  /* ---------------------------- 认证 ---------------------------- */

  /**
   * 邮箱 + 密码登录
   *
   * 为什么这是首选：它【完全不需要邮件服务】。
   * 账号可以直接在 Supabase 后台（Authentication -> Users -> Add user）建，
   * 于是绕开了免费版"只给项目成员发信"和"禁止改邮件模板"两条限制。
   */
  async function signInWithPassword(email, password) {
    if (!online) return { ok: false, reason: '未配置 Supabase' };
    try {
      const data = await request('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
      });
      saveSession(normalizeSession(data));
      return { ok: true, session: getSession() };
    } catch (e) {
      return { ok: false, reason: readableAuthError(e) };
    }
  }

  /** 邮箱 + 密码注册（需要项目开了 Signups 且关闭了邮件确认，否则要邮件） */
  async function signUpWithPassword(email, password) {
    if (!online) return { ok: false, reason: '未配置 Supabase' };
    try {
      const data = await request('/auth/v1/signup', {
        method: 'POST',
        body: { email, password },
      });
      // 如果项目还开着邮件确认，这里拿不到 session
      if (data && data.access_token) {
        saveSession(normalizeSession(data));
        return { ok: true, session: getSession() };
      }
      if (data && data.id) {
        return { ok: false, reason: '账号建好了，但项目还开着"邮件确认"，请去后台手动确认这个邮箱，或直接让管理员在后台建号' };
      }
      return { ok: false, reason: '注册没返回会话，检查项目是否允许注册' };
    } catch (e) {
      return { ok: false, reason: readableAuthError(e) };
    }
  }

  /** 发送登录验证码（邮箱 OTP）—— 需要自定义 SMTP，否则只能发给项目成员 */
  async function signInWithOtp(email) {
    if (!online) return { ok: false, reason: '未配置 Supabase' };
    try {
      await request('/auth/v1/otp', {
        method: 'POST',
        body: { email, create_user: true },
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: readableAuthError(e) };
    }
  }

  /** 校验验证码，换取会话 */
  async function verifyOtp(email, token) {
    if (!online) return { ok: false, reason: '未配置 Supabase' };
    try {
      const data = await request('/auth/v1/verify', {
        method: 'POST',
        body: { email, token, type: 'email' },
      });
      saveSession(normalizeSession(data));
      return { ok: true, session: getSession() };
    } catch (e) {
      return { ok: false, reason: readableAuthError(e) };
    }
  }

  /** 刷新 access token（过期前调用） */
  async function refresh() {
    const s = getSession();
    if (!s || !s.refresh_token) return { ok: false, reason: '没有会话' };
    try {
      const data = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: s.refresh_token },
      });
      saveSession(normalizeSession(data));
      return { ok: true };
    } catch (e) {
      clearSession();
      return { ok: false, reason: readableAuthError(e) };
    }
  }

  async function signOut() {
    if (online && isSignedIn()) {
      try { await request('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
    }
    clearSession();
    return { ok: true };
  }

  function normalizeSession(data) {
    const expiresIn = data.expires_in || 3600;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // 提前 60 秒视为过期，避免边界上刚好失效
      expires_at: Date.now() + (expiresIn - 60) * 1000,
      user: data.user || null,
    };
  }

  /** 会话快过期就自动刷新 */
  async function ensureFreshSession() {
    const s = getSession();
    if (!s) return false;
    if (s.expires_at && Date.now() > s.expires_at) {
      const r = await refresh();
      return r.ok;
    }
    return true;
  }

  function readableAuthError(e) {
    const m = String((e && e.message) || '');
    if (m.includes('rate limit') || m.includes('429')) {
      return '邮件发送太频繁（免费版默认只允许每小时 2 封）。建议改用「邮箱 + 密码」登录。';
    }
    if (m.includes('Email address not authorized')) {
      return '免费版的默认邮件服务只能发给项目成员。改用「邮箱 + 密码」登录可以绕开这个限制。';
    }
    if (m.includes('not available for free tier')) {
      return '这个操作免费版不支持（需要自定义 SMTP 或升级）。改用「邮箱 + 密码」登录即可。';
    }
    if (m.includes('Invalid login credentials')) return '邮箱或密码不对';
    if (m.includes('Email not confirmed')) return '这个邮箱还没确认。去后台 Authentication → Users 点一下确认，或关掉"邮件确认"';
    if (m.includes('Invalid') && m.includes('token')) return '验证码不对，或已经过期';
    if (m.includes('already registered')) return '这个邮箱已经注册过了，直接登录吧';
    if (m.includes('Password should be')) return '密码太短了（至少 6 位）';
    return m || '登录失败';
  }

  /* ---------------------------- 数据映射 ---------------------------- */

  /**
   * 身份翻译。
   *
   * 本地用 'u1' / 'u2' 标记「谁」，云端用 Supabase 的真实 UUID。
   * 推送和拉取时都必须翻译，否则会出现
   *   invalid input syntax for type uuid: "u1"
   *
   * 翻译表存在 HusafeIds 上：{ u1: '<我的uuid>', u2: '<TA的uuid>' }
   */
  let HusafeIds = { u1: null, u2: null };

  /** 由 app 层在拿到 profile 后调用 */
  function setIdentityMap(map) {
    HusafeIds = Object.assign({ u1: null, u2: null }, map || {});
  }
  function getIdentityMap() { return { ...HusafeIds }; }

  /** 本地身份键 -> 云端 UUID */
  function localToCloud(v) {
    if (!v) return null;
    if (HusafeIds[v]) return HusafeIds[v];
    // 已经是 UUID 就直接用
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return v;
    return null;
  }

  /** 云端 UUID -> 本地身份键 */
  function cloudToLocal(v) {
    if (!v) return null;
    for (const k of Object.keys(HusafeIds)) {
      if (HusafeIds[k] === v) return k;
    }
    return v;   // 认不出来就原样返回，至少不丢数据
  }

  /** Supabase 行 → 本地 record */
  function rowToRecord(row) {
    return {
      id: row.id,
      coupleId: row.couple_id,
      creatorId: cloudToLocal(row.created_by),
      amount: row.amount,
      type: row.type,
      categoryId: row.category_id,
      date: row.date,
      note: row.note || '',
      visibility: row.visibility,
      payerId: cloudToLocal(row.payer_id),
      goalId: row.goal_id || null,
      version: row.version || 1,
      deletedAt: row.deleted_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      // 🔑 标记「这条来自云端、已同步」——
      //    没有这个标记的本地记录说明还没上传过，需要补传
      syncedAt: new Date().toISOString(),
    };
  }

  /**
   * 本地 record → Supabase 行
   *
   * 🔑 两条硬要求：
   *   1. payer_id / created_by 必须翻译成真实 UUID（否则报 uuid 格式错误）
   *   2. 【所有对象的键必须完全一致】——PostgREST 批量插入要求如此，
   *      条件性地加字段会报 PGRST102 "All object keys must match"。
   *      所以可空字段一律显式写成 null，不能省略。
   */
  function recordToRow(r, coupleId, fallbackUserId) {
    const creator = localToCloud(r.creatorId) || fallbackUserId;
    const payer = localToCloud(r.payerId) || fallbackUserId;
    return {
      id: r.id,
      couple_id: coupleId,
      created_by: creator,
      amount: r.amount,
      type: r.type || 'expense',
      category_id: r.categoryId || 'other',
      date: r.date,
      note: r.note || '',
      visibility: r.visibility,
      payer_id: payer,
      // 下面两个必须显式给 null，不能条件添加 —— 见上面的说明
      goal_id: r.goalId || null,
      deleted_at: r.deletedAt || null,
    };
  }

  function rowToGoal(row) {
    return {
      id: row.id,
      coupleId: row.couple_id,
      name: row.name,
      icon: row.icon,
      target: row.target,
      deadline: row.deadline || '',
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at || null,
      deletedAt: row.deleted_at || null,
      // 标记来自云端，说明已同步（和 records 一个思路）
      syncedAt: new Date().toISOString(),
    };
  }

  /** 本地目标 → Supabase 行 */
  function goalToRow(g, coupleId) {
    return {
      id: g.id,
      couple_id: coupleId,
      name: g.name,
      icon: g.icon || '🎯',
      target: g.target,
      deadline: g.deadline || null,
      status: g.deletedAt ? 'archived' : (g.status || 'active'),
      deleted_at: g.deletedAt || null,
      updated_at: g.updatedAt || new Date().toISOString(),
    };
  }

  /** 还没同步过的目标（登录后要补传的） */
  function pendingGoals(localGoals) {
    return (localGoals || []).filter(g => !g.syncedAt);
  }

  /* ---------------------------- 读写 ---------------------------- */

  /** 全量拉取。私密账目由 RLS 在服务端过滤，前端拿不到对方私账 */
  async function pullAll() {
    if (!online) return { ok: false, reason: '未配置 Supabase' };
    if (!isSignedIn()) return { ok: false, reason: '未登录' };
    await ensureFreshSession();

    try {
      const [me, records, goals] = await Promise.all([
        request('/rest/v1/users?select=*&limit=1'),
        request('/rest/v1/records?select=*&order=date.desc,created_at.desc'),
        request('/rest/v1/goals?select=*&order=created_at.desc'),
      ]);
      return {
        ok: true,
        me: Array.isArray(me) ? me[0] : me,
        records: (records || []).map(rowToRecord),
        goals: (goals || []).map(rowToGoal),
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 批量插入账目 —— 用 ignore-duplicates。
   *
   * 🔑 为什么不用 merge-duplicates（upsert）：
   *    upsert 遇到已存在的行会走 UPDATE 分支，而 UPDATE 策略要求
   *      using (created_by = auth.uid())
   *    如果库里那一行的 created_by 是别人（历史脏数据），整批就被 403 拒绝，
   *    连累同批里本来能插入的记录。
   *    改成 ignore-duplicates 后，已存在的行直接跳过、绝不修改别人的数据，
   *    插入永远不会因为这种情况失败。
   *
   *    需要更新/删除的旧记录，另走 patchRecords()。
   */
  async function insertRecords(records, coupleId) {
    if (!online || !records.length) return { ok: false, reason: '未配置或空数据' };
    await ensureFreshSession();
    const fallback = currentUserId();
    const rows = records.map(r => recordToRow(r, coupleId, fallback));

    logPush('插入', rows, coupleId, fallback);

    try {
      await request('/rest/v1/records?on_conflict=couple_id,id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
        body: rows,
      });
      return { ok: true, count: records.length };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 更新已存在的账目（软删除、改可见性等）。
   * 先按 id 过滤，所以只会碰到自己那一行。
   */
  async function patchRecords(records, coupleId) {
    if (!online || !records.length) return { ok: false, reason: '未配置或空数据' };
    await ensureFreshSession();
    const fallback = currentUserId();
    const results = [];

    for (const r of records) {
      const row = recordToRow(r, coupleId, fallback);
      // id 和 couple_id 是定位用的，不放在 SET 里
      const patch = { ...row };
      delete patch.id;
      delete patch.couple_id;

      try {
        await request(
          `/rest/v1/records?couple_id=eq.${encodeURIComponent(coupleId)}&id=eq.${encodeURIComponent(r.id)}`,
          { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: patch }
        );
        results.push({ id: r.id, ok: true });
      } catch (e) {
        results.push({ id: r.id, ok: false, reason: e.message });
      }
    }

    const failed = results.filter(x => !x.ok);
    if (failed.length) {
      return { ok: false, reason: failed[0].reason, results };
    }
    return { ok: true, count: records.length, results };
  }

  /** 排错用：把要推送的内容打出来（只在需要时看） */
  function logPush(kind, rows, coupleId, fallback) {
    if (typeof console === 'undefined' || !console.info) return;
    console.info(`[husafe] ${kind} ${rows.length} 条 → couple_id=`, coupleId, 'auth.uid=', fallback);
    console.info('[husafe] 明细：', rows.map(o => ({
      id: o.id, created_by: o.created_by, payer_id: o.payer_id,
      couple_id: o.couple_id, visibility: o.visibility, deleted_at: o.deleted_at,
    })));
  }

  /**
   * 推送账目（兼容旧调用）：一律当插入处理。
   * 真正的增删改分流在 flushQueue 里做。
   */
  async function pushRecords(records, coupleId) {
    return insertRecords(records, coupleId);
  }

  /** 批量 upsert 目标。同样要求所有对象的键一致。 */
  async function pushGoals(goals, coupleId) {
    if (!online || !goals.length) return { ok: false, reason: '未配置或空数据' };
    await ensureFreshSession();
    try {
      await request('/rest/v1/goals?on_conflict=id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: goals.map(g => goalToRow(g, coupleId)),
      });
      return { ok: true, count: goals.length };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async function pushGoal(goal, coupleId) {
    return pushGoals([goal], coupleId);
  }

  async function updateProfile(patch) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    await ensureFreshSession();
    try {
      await request('/rest/v1/users?id=eq.' + currentUserId(), {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: patch,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ---------------------------- 情侣绑定 ---------------------------- */

  async function createInviteCode() {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    await ensureFreshSession();
    try {
      const code = await request('/rest/v1/rpc/create_invite_code', {
        method: 'POST', body: {},
      });
      return { ok: true, code: typeof code === 'string' ? code : (code && code.code) };
    } catch (e) {
      let reason = e.message;
      if (String(reason).includes('已经绑定过了')) reason = '你们已经绑定啦';
      return { ok: false, reason };
    }
  }

  async function redeemInviteCode(code) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    await ensureFreshSession();
    try {
      const res = await request('/rest/v1/rpc/redeem_invite_code', {
        method: 'POST', body: { input_code: code },
      });
      if (res && res.ok) return { ok: true, coupleId: res.couple_id };
      return { ok: false, reason: (res && res.reason) || '绑定失败' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ---------------------------- 实时订阅 ---------------------------- */

  /**
   * ⚠️ 关于实时同步的两条路：
   *
   * 1. **轮询（主力，一定有保证）**：每 15 秒拉一次云端。
   *    不依赖任何实时协议，只要网络通就一定能拿到最新数据。
   *    代价是最多 15 秒延迟 —— 对记账场景完全够用。
   *
   * 2. **WebSocket 实时推送（尽力而为）**：Supabase Realtime 的
   *    postgres_changes 需要正确的频道加入协议，手写容易出错且难调试。
   *    所以只当加速用：能连上就立刻刷新，连不上就靠轮询。
   *
   * 这样即使 Realtime 完全不工作，数据也不会落后 —— 这是设计上的兜底。
   */
  let socket = null;
  let heartbeat = null;
  let onRecordChange = null;
  let reconnectDelay = 1000;
  let heartbeatRef = 0;
  let realtimeAvailable = false;
  // 连不上太多次就彻底放弃实时通道，只靠轮询（避免控制台刷满错误）
  let rtDisabled = false;

  /** 有没有可用的实时通道（供界面显示状态） */
  function isRealtimeOn() { return realtimeAvailable; }

  /** 实时推送是否真的连上了（收到过消息） */
  let realtimeAlive = false;
  function isRealtimeAlive() { return realtimeAlive; }

  /**
   * 实时通道的失败计数。
   *
   * ⚠️ 为什么需要它：Supabase Realtime 用的 wss 连接在国内网络下
   *    经常被重置（ERR_CONNECTION_RESET）。如果失败后立刻重连，
   *    控制台会刷满错误、也白耗流量。
   *
   *    连续失败到一定次数就【彻底停掉】，只靠 15 秒轮询 ——
   *    功能完全不受影响，只是延迟从"秒级"变成"最多 15 秒"。
   */
  let rtFailures = 0;
  const RT_MAX_FAILURES = 3;

  function subscribe(handler) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未配置或未登录' };
    onRecordChange = handler;
    rtFailures = 0;
    rtDisabled = false;
    openSocket();
    return { ok: true };
  }

  function openSocket() {
    if (rtDisabled) return;                    // 已经放弃实时，交给轮询
    if (typeof WebSocket === 'undefined') { rtDisabled = true; return; }
    if (socket) { try { socket.close(); } catch (e) {} }
    const s = getSession();
    const wsUrl = cfg.url.replace(/^http/, 'ws') +
      '/realtime/v1/websocket?apikey=' + encodeURIComponent(cfg.anonKey) +
      '&vsn=1.0.0';

    let opened = false;

    try {
      socket = new WebSocket(wsUrl);
    } catch (e) {
      rtDisabled = true;
      realtimeAvailable = false;
      return;                                  // 轮询会兜住
    }

    socket.onopen = () => {
      opened = true;
      realtimeAvailable = true;
      // 加入 phoenix 频道（Supabase Realtime 的协议格式）
      try {
        socket.send(JSON.stringify({
          topic: 'realtime:public:records',
          event: 'phx_join',
          payload: {
            config: {
              broadcast: { self: false },
              presence: { key: '' },
              postgres_changes: [
                { event: '*', schema: 'public', table: 'records' },
              ],
            },
            access_token: s ? s.access_token : null,
          },
          ref: String(++heartbeatRef),
        }));
      } catch (e) { /* 交给轮询 */ }

      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        try {
          socket.send(JSON.stringify({
            topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++heartbeatRef),
          }));
        } catch (e) {}
      }, 25000);
    };

    socket.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }

      // 认出 postgres_changes 的几种可能格式
      let payload = null;
      if (msg.event === 'postgres_changes' && msg.payload) {
        payload = msg.payload.data || msg.payload;
      } else if (msg.event === 'INSERT' || msg.event === 'UPDATE' || msg.event === 'DELETE') {
        payload = msg.payload && msg.payload.data ? msg.payload.data : msg.payload;
      }
      if (!payload || !payload.type) return;

      realtimeAlive = true;
      const type = String(payload.type).toUpperCase();
      if (onRecordChange && (type === 'INSERT' || type === 'UPDATE' || type === 'DELETE')) {
        onRecordChange({
          type,
          record: payload.record ? rowToRecord(payload.record) : null,
          oldId: payload.old_record ? payload.old_record.id : null,
        });
      }
    };

    socket.onclose = () => {
      realtimeAvailable = false;
      realtimeAlive = false;
      if (opened) rtFailures++;                // 连上过又断，也记一次
      scheduleReconnect();
    };
    socket.onerror = () => { /* onclose 会跟着触发 */ };
  }

  /**
   * 断了之后要不要重连。
   *
   * 连续失败 RT_MAX_FAILURES 次就彻底放弃实时通道 —— 只靠轮询。
   * 这样控制台不会被 ERR_CONNECTION_RESET 刷屏，功能也不受影响。
   */
  function scheduleReconnect() {
    clearInterval(heartbeat);
    realtimeAvailable = false;

    if (rtFailures >= RT_MAX_FAILURES) {
      rtDisabled = true;
      if (typeof console !== 'undefined' && console.info) {
        console.info('[husafe] 实时通道连不上，已切换为「每 15 秒自动刷新」模式（功能不受影响）');
      }
      return;
    }

    setTimeout(() => {
      if (onRecordChange && online && isSignedIn() && !rtDisabled) {
        rtFailures++;
        openSocket();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);   // 退避到最多 1 分钟
  }

  function unsubscribe() {
    onRecordChange = null;
    realtimeAvailable = false;
    realtimeAlive = false;
    clearInterval(heartbeat);
    if (socket) { try { socket.close(); } catch (e) {} socket = null; }
  }

  /* ---------------------------- 离线队列 ---------------------------- */

  const QUEUE_KEY = 'husafe.sync.queue.v1';

  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (e) { return []; }
  }
  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }

  /** 排队一条待推送的账目（离线时用） */
  function enqueue(record) {
    const q = readQueue().filter(r => r.id !== record.id);
    q.push(record);
    writeQueue(q);
    return q.length;
  }

  function queueLength() { return readQueue().length; }

  /**
   * 把队列里的账目推上去。
   *
   * 分成两类走不同路径：
   *   - **已有 id**（本地软删除/编辑过的）→ PATCH，只改自己那一行
   *   - **新记录** → POST + ignore-duplicates，绝不碰别人的行
   *
   * 这样即使数据库里存在同 id 但归属别人的脏数据，也不会连累整批失败。
   */
  async function flushQueue(coupleId) {
    const all = readQueue();
    if (!all.length) return { ok: true, count: 0 };

    const mine = [];
    const dropped = [];
    for (const r of all) {
      if (isMine(r)) mine.push(r);
      else dropped.push(r);
    }
    if (dropped.length) {
      writeQueue(mine);
      console.info(`已跳过 ${dropped.length} 条不属于本机用户的记录`);
    }
    if (!mine.length) return { ok: true, count: 0, dropped: dropped.length };

    // 第一遍：全部当新记录插入（忽略已存在的）
    const ins = await insertRecords(mine, coupleId);
    if (!ins.ok) {
      // 插入整体失败才保留队列；这是真的错
      return Object.assign({ dropped: dropped.length }, ins);
    }

    // 第二遍：把"已有 id 但内容不同"的（软删除、改可见性）用 PATCH 补上
    const needsPatch = mine.filter(r => r.deletedAt || r.updatedAt);
    let patched = 0;
    if (needsPatch.length) {
      const pr = await patchRecords(needsPatch, coupleId);
      patched = pr.ok ? needsPatch.length : 0;
      if (!pr.ok) {
        // PATCH 失败不影响插入成功 —— 记下来但不阻塞
        console.warn('[husafe] 部分更新失败（不影响新记录）:', pr.reason);
      }
    }

    writeQueue([]);
    return { ok: true, count: ins.count, patched, dropped: dropped.length };
  }

  /** 当前用户所属的情侣空间 id */
  const COUPLE_KEY = 'husafe.couple.v1';

  function getCoupleId() {
    try {
      const id = localStorage.getItem(COUPLE_KEY);
      if (id) return id;
    } catch (e) {}
    const s = getSession();
    return (s && (s.couple_id || s.coupleId)) || null;
  }

  function setCoupleId(id) {
    try {
      if (id) localStorage.setItem(COUPLE_KEY, String(id));
      else localStorage.removeItem(COUPLE_KEY);
    } catch (e) {}
  }

  /**
   * 拉取自己的 profile，其中带着 couple_id；
   * 同时找出「TA」的 UUID，用于身份翻译（推送时的 payer_id / created_by）。
   *
   * ⚠️ 身份映射必须以【当前登录者】为准：
   *      u1 = 我（auth.uid()）    u2 = TA
   *    如果按"谁是 member_a"来分配，换个账号登录 u1/u2 就会对调，
   *    于是「我记的私密账」在对方设备上会被认成「TA 记的」——
   *    表现就是"我设的私密账 TA 能看到"。
   */
  async function fetchMyProfile() {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    await ensureFreshSession();
    try {
      const myId = currentUserId();

      // 精确取自己那一行（用 id 过滤），不依赖数组顺序
      const mineRows = await request(
        '/rest/v1/users?select=id,nickname,avatar,couple_id&id=eq.' + myId + '&limit=1');
      const self = (Array.isArray(mineRows) ? mineRows[0] : mineRows) || null;

      // ⚠️ 这里【不能】做"查不到就取第一行"的兜底 ——
      //    那可能拿到对方的行，于是自己的昵称/头像被 TA 的值覆盖
      //    （表现为「头像和昵称不随着登录更新」）。
      //    查不到就老实返回失败，由调用方处理。
      if (!self) {
        return { ok: false, reason: '读不到你的用户资料，请检查 users 表的 RLS 策略' };
      }

      if (self.couple_id) setCoupleId(self.couple_id);

      let partner = null;
      if (self.couple_id) {
        try {
          const mates = await request(
            '/rest/v1/users?select=id,nickname,avatar&couple_id=eq.' + self.couple_id);
          // 明确排除自己 —— 用 id 比较，不用数组位置
          partner = (mates || []).find(u => u.id !== self.id) || null;
        } catch (e) { /* 拿不到 TA 就先不翻译，不阻塞 */ }
      }

      // 🔑 u1 永远是「我」，u2 永远是「TA」
      setIdentityMap({ u1: self.id, u2: partner ? partner.id : null });

      return { ok: true, me: self, partner, coupleId: self.couple_id };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 拉取情侣空间信息（绑定时间、共同预算等）。
   *
   * 这些字段在 couples 表里，之前没同步过 —— 导致「绑定 N 天」
   * 一直用的是本地种子里写死的假日期。
   */
  async function fetchCouple() {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    const coupleId = getCoupleId();
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间' };
    await ensureFreshSession();
    try {
      const rows = await request(
        '/rest/v1/couples?select=id,member_a,member_b,status,bound_at,monthly_budget&id=eq.' +
        encodeURIComponent(coupleId) + '&limit=1');
      const c = Array.isArray(rows) ? rows[0] : rows;
      if (!c) return { ok: false, reason: '找不到情侣空间' };
      return {
        ok: true,
        couple: {
          id: c.id,
          memberA: c.member_a,
          memberB: c.member_b,
          status: c.status,
          boundAt: c.bound_at || null,
          monthlyBudget: c.monthly_budget || 0,
        },
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /**
   * 推送成功后给本地记录打上「已同步」标记。
   * 需要调用方把 state.records 传进来（sync.js 不直接改 state）。
   */
  function markSynced(localRecords, ids) {
    const set = new Set(ids || []);
    let n = 0;
    for (const r of (localRecords || [])) {
      if (set.has(r.id)) { r.syncedAt = new Date().toISOString(); n++; }
    }
    return n;
  }

  /**
   * 找出「本地有、但从未同步过」的记录 —— 需要补传的。
   *
   * 依据是 rowToRecord 打的 syncedAt 标记：
   *   - 从云端拉下来的记录有 syncedAt
   *   - 本机新记的、或在没登录时记的，没有 syncedAt
   */
  function pendingUploads(localRecords) {
    return (localRecords || []).filter(r => !r.syncedAt);
  }

  /**
   * 把一批本地记录补传到云端（登录后调用）。
   * 会自动区分插入/更新，并只推自己创建的。
   *
   * @param {Array} localRecords 本地全部记录（会被打上 syncedAt 标记）
   * @param {Array} localGoals   本地目标（先于账目推，否则外键报错）
   */
  async function uploadPending(localRecords, localGoals) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录', count: 0 };

    let coupleId = getCoupleId();
    if (!coupleId) {
      const p = await fetchMyProfile();
      coupleId = p.ok ? p.coupleId : null;
    }
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间', count: 0 };

    const pending = pendingUploads(localRecords).filter(isMine);
    const pendGoals = pendingGoals(localGoals);

    if (!pending.length && !pendGoals.length) return { ok: true, count: 0 };

    // 🔑 目标必须先于账目推（records.goal_id 有外键指向 goals）
    let goalsPushed = 0;
    if (pendGoals.length) {
      const gr = await pushGoals(pendGoals, coupleId);
      if (gr.ok) goalsPushed = pendGoals.length;
    }

    const toInsert = pending.filter(r => !needsUpdate(r));
    const toPatch = pending.filter(r => needsUpdate(r));

    let inserted = 0, patched = 0;
    if (toInsert.length) {
      const r = await pushRecords(toInsert, coupleId);
      if (r.ok) inserted = toInsert.length;
    }
    if (toPatch.length) {
      const r = await patchRecords(toPatch, coupleId);
      if (r.ok) patched = toPatch.length;
    }

    const done = toInsert.slice(0, inserted).map(r => r.id)
      .concat(toPatch.slice(0, patched).map(r => r.id));
    markSynced(localRecords, done);
    // 目标也打上已同步标记
    const now = new Date().toISOString();
    for (const g of pendGoals.slice(0, goalsPushed)) g.syncedAt = now;

    return { ok: true, count: done.length, inserted, patched, goals: goalsPushed };
  }

  /* ---------------------------- 写路径（本地 → 云端） ---------------------------- */

  /**
   * 这条记录是不是「我」创建的？
   *
   * 判断要保守：**认不出归属时返回 false（不推）**，而不是当成自己的。
   * 因为推别人的记录会被 RLS 403 拒绝，白跑一趟还污染错误信息。
   * 而漏推的代价很小 —— 下次补推或对方设备自己会推上去。
   */
  function isMine(record) {
    const me = currentUserId();
    if (!me) return false;

    // 已经是 UUID 形式：直接和我的 UUID 比
    const creator = record.creatorId;
    if (!creator) return false;

    // 先在翻译表里查；查不到就看是不是本来就是 UUID
    const mapped = HusafeIds.u1;
    if (mapped && creator === mapped) return true;

    // 本地键形式：认得出「我」的键就算我的
    if (creator === 'u1') return true;
    // 认得出「TA」的键就不是我的
    if (creator === 'u2') return false;

    // 剩下的是真 UUID：只有等于我的才算
    return creator === me;
  }

  /**
   * 这条记录该走「插入」还是「更新」？
   *
   * - 新记的账：没有 updatedAt/deletedAt → **插入**
   * - 编辑过 / 删掉的账：有 updatedAt 或 deletedAt → **更新（PATCH）**
   *
   * 🔑 这个区分是必须的：插入用的是 ignore-duplicates，
   *    对已存在的行会直接跳过 —— 于是"删除"这个改动永远传不到云端。
   *    必须用 PATCH 按 id 精确更新自己那一行。
   */
  function needsUpdate(record) {
    return !!(record && (record.updatedAt || record.deletedAt));
  }

  /**
   * 保存一笔账目到云端（离线时自动入队，有网补推）
   *
   * 🔑 只推【自己创建】的记录。
   *    RLS 策略要求 created_by = auth.uid()，推对方创建的记录必然 403，
   *    而且会永远卡在队列里反复重试。对方的记录由对方设备上传。
   */
  async function saveRecord(record) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录', queued: false };

    if (!isMine(record)) {
      return { ok: true, skipped: true, reason: '这条不是本机用户记的，由 TA 的设备上传' };
    }

    let coupleId = getCoupleId();
    if (!coupleId) {
      const p = await fetchMyProfile();
      coupleId = p.ok ? p.coupleId : null;
      if (!coupleId) {
        enqueue(record);
        return { ok: false, reason: '还没绑定情侣空间', queued: true };
      }
    }

    // 编辑 / 删除 → PATCH；新记录 → 插入
    const r = needsUpdate(record)
      ? await patchRecords([record], coupleId)
      : await insertRecords([record], coupleId);

    if (!r.ok) {
      enqueue(record);
      return { ok: false, reason: r.reason, queued: true };
    }
    return { ok: true, patched: needsUpdate(record) };
  }

  /** 删除一笔账目（软删除，把 deleted_at 推上去） */
  async function removeRecord(record) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    const coupleId = getCoupleId();
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间' };
    return patchRecords([record], coupleId);
  }

  /** 保存目标 */
  async function saveGoalRecord(goal) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    let coupleId = getCoupleId();
    if (!coupleId) {
      const p = await fetchMyProfile();
      coupleId = p.ok ? p.coupleId : null;
    }
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间' };
    return pushGoal(goal, coupleId);
  }

  /** 把本地已有但未上传的账目一次性全推上去（首次登录时用） */
  async function pushAllLocal(records) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    let coupleId = getCoupleId();
    if (!coupleId) {
      const p = await fetchMyProfile();
      coupleId = p.ok ? p.coupleId : null;
    }
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间' };

    // 只推自己创建的 —— 推别人的会被 RLS 拒绝（403）
    const mine = (records || []).filter(isMine);
    if (!mine.length) return { ok: true, count: 0, skippedAll: true };

    // 分批推，避免单次请求体过大
    const CHUNK = 200;
    for (let i = 0; i < mine.length; i += CHUNK) {
      const r = await pushRecords(mine.slice(i, i + CHUNK), coupleId);
      if (!r.ok) return r;
    }
    return { ok: true, count: mine.length };
  }

  /**
   * 把本地所有目标推到云端。
   *
   * ⚠️ 必须在推送账目【之前】做：
   *    records.goal_id 有外键指向 goals(id)，
   *    如果账目先到、目标还没到，插入会直接被外键约束拒绝（400）。
   */
  async function pushAllGoals(goals) {
    if (!online || !isSignedIn()) return { ok: false, reason: '未登录' };
    if (!goals || !goals.length) return { ok: true, count: 0 };
    let coupleId = getCoupleId();
    if (!coupleId) {
      const p = await fetchMyProfile();
      coupleId = p.ok ? p.coupleId : null;
    }
    if (!coupleId) return { ok: false, reason: '还没绑定情侣空间' };
    return pushGoals(goals, coupleId);   // 单次批量请求，避免逐条往返
  }

  /** 目标 id 集合，用于判断某笔账目的 goal_id 是否真的存在于云端 */
  async function fetchGoalIds() {
    if (!online || !isSignedIn()) return [];
    try {
      const rows = await request('/rest/v1/goals?select=id');
      return (rows || []).map(r => r.id);
    } catch (e) {
      return [];
    }
  }

  /* ---------------------------- 导出 ---------------------------- */

  return {
    configure, isOnline, configured,
    signInWithPassword, signUpWithPassword,
    signInWithOtp, verifyOtp, signOut, refresh, getSession, isSignedIn,
    currentUserId, ensureFreshSession,
    getCoupleId, setCoupleId, fetchMyProfile, fetchCouple,
    setIdentityMap, getIdentityMap, localToCloud, cloudToLocal,
    pullAll, pushRecords, insertRecords, patchRecords, pushGoals, pushGoal, updateProfile,
    saveRecord, removeRecord, saveGoalRecord, pushAllLocal, pushAllGoals, fetchGoalIds, needsUpdate,
    markSynced, pendingUploads, uploadPending, pendingGoals, goalToRow,
    createInviteCode, redeemInviteCode,
    subscribe, unsubscribe, isRealtimeOn, isRealtimeAlive,
    enqueue, queueLength, flushQueue,
    rowToRecord, recordToRow, rowToGoal,
  };
})();

// 浏览器里直接挂到 window；Node 测试里通过 module.exports 导出。
// 注意：浏览器没有 module 对象，所以这个判断不能省 —— 否则一加载就抛错。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HusafeSync;
}
if (typeof window !== 'undefined') {
  window.HusafeSync = HusafeSync;
}
