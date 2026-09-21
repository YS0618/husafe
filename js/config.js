/* ==========================================================================
   朝夕 Husafe · 配置
   
   这个文件和 data.js / sync.js 一起在 index.html 里按顺序加载：
     data.js -> sync.js -> config.js -> app.js

   安全性：anon key 是【公开密钥】，设计上就是给前端用的。
           安全性由数据库的 RLS 策略保证，不是靠藏这个 key。
           ⚠️ 绝对不要把 service_role key 写在这里 —— 那个能绕过所有安全策略。
   ========================================================================== */

/* --------------------------------------------------------------------------
   demoMode：是否预置「示例账目」
   
   true  —— 首次打开会带上 21 条示例数据（"一起吃了火锅""楼下咖啡"等）。
            只在演示/开发时用，方便看界面效果。
   
   false —— 首次打开是【空账本】，什么都不预置。
            ⚠️ 正式使用必须设成 false。
            否则一旦清了浏览器缓存或换了设备，这些假账会冒出来污染真账本。
   -------------------------------------------------------------------------- */
window.HUSAFE_DEMO_MODE = false;

window.HUSAFE_CONFIG = {
  url: 'https://dcfgupbfphqytoimtpxh.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjZmd1cGJmcGhxeXRvaW10cHhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4OTAzNTUsImV4cCI6MjEwNTQ2NjM1NX0.pHgNdJAGyUqNE-GF1OG2c-r_maj6SUmQwzEDHUtGJfo',
};
