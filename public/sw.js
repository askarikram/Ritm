const CACHE='ritm-shell-__RITM_RELEASE__';
const SHELL=['/','/offline.html','/manifest.webmanifest','/icons/icon.svg','/icons/icon-192.png','/icons/icon-512.png','/icons/apple-touch-icon.png','/assets/fonts/golos-text-latin.woff2?v=5.3.0','/assets/fonts/golos-text-cyrillic.woff2?v=5.3.0','/assets/fonts/golos-text-cyrillic-ext.woff2?v=5.3.0'];
const shellRequest=url=>SHELL.some(path=>url.pathname+url.search===path);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('ritm-shell-')&&key!==CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')void self.skipWaiting();});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  // Private API responses, cookies and financial plans never enter Cache Storage.
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(request.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const response=await fetch(request);
        if(response.ok&&['/','/index.html'].includes(url.pathname)){const cache=await caches.open(CACHE);await cache.put('/',response.clone());}
        return response;
      }catch{
        const cache=await caches.open(CACHE);
        return await cache.match(['/','/index.html'].includes(url.pathname)?'/':'/offline.html')||Response.error();
      }
    })());return;
  }
  if(shellRequest(url))event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(request);
    if(cached)return cached;
    const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;
  })());
});
