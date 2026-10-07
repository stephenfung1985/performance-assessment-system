// PWA Service Worker：只缓存页面外壳（index.html / manifest / 图标），
// 从不缓存 /api/* —— 业务数据必须实时读写局域网上的 Node 服务，缓存会导致看到旧数据或登录态错乱。
// 作用仅是：1) 满足「添加到主屏幕」安装条件；2) 服务器一时连不上时，不至于看到 Safari 的裸错误页。
const CACHE = 'kh-shell-v1';
const SHELL = ['/', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;                       // POST/PUT 等写操作一律直连网络
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // 跨源请求不经过本 SW
  if (url.pathname.startsWith('/api/')) return;            // 业务数据接口永远走网络，绝不缓存

  // 页面外壳：网络优先，连不上服务器时回退到缓存，保证至少能打开界面
  ev.respondWith(
    fetch(req).then(res => {
      if (res.ok && SHELL.includes(url.pathname === '/index.html' ? '/' : url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(cached => cached || caches.match('/')))
  );
});
