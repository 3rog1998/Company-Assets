// عامل خدمة بسيط: يجعل التطبيق قابلاً للتثبيت دون تخزين بيانات مؤقتاً
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
