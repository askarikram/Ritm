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


// Only an opaque account identifier and display preference are stored here.
function displayPrefs(write){
 return new Promise(resolve=>{
  const request=indexedDB.open('ritm-notification-display',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('prefs');
  request.onerror=()=>resolve({owner:null,hidden:true});
  request.onsuccess=()=>{
   const db=request.result,transaction=db.transaction('prefs',write?'readwrite':'readonly'),store=transaction.objectStore('prefs');
   const operation=write?store.put(write,'active'):store.get('active');
   operation.onsuccess=()=>{const result=write||operation.result||{owner:null,hidden:true};transaction.oncomplete=()=>{db.close();resolve(result);};};
   operation.onerror=()=>{db.close();resolve({owner:null,hidden:true});};
  };
 });
}
self.addEventListener('message',event=>{
 if(event.data?.type!=='RITM_DISPLAY_PREFS')return;
 const data=event.data,owner=typeof data.owner==='string'&&/^[a-f0-9]{32}$/.test(data.owner)?data.owner:null;
 event.waitUntil((async()=>{
  await displayPrefs({owner,hidden:data.hidden!==false});
  for(const notification of await self.registration.getNotifications())if(notification.data?.owner!==owner||data.hidden!==false)notification.close();
 })());
});
async function showReminder(data){
 const prefs=await displayPrefs();
 if(!prefs.owner||data?.owner!==prefs.owner)return;
 const title='Ритм · Напоминание',fallback='Запланирован платёж. Откройте Ритм, чтобы посмотреть.';
 const body=prefs.hidden?data.genericBody:data.body;
 await self.registration.showNotification(title,{body:typeof body==='string'?body.slice(0,260):fallback,icon:'/icons/icon-192.png',badge:'/icons/icon-192.png',tag:'ritm-'+String(data.tag||'payment').slice(0,40),data:{owner:prefs.owner,route:data.route==='personal'?'personal':'payment',notificationId:typeof data.notificationId==='string'&&/^[a-f0-9-]{36}$/i.test(data.notificationId)?data.notificationId:null},renotify:false});
}
self.addEventListener('push',event=>{
 let data;try{data=event.data?.json();}catch{return;}
 event.waitUntil(showReminder(data));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const prefs=await displayPrefs();if(!prefs.owner||event.notification.data?.owner!==prefs.owner)return;
  const route=event.notification.data?.route==='personal'?'personal':'payment';
  const receipt=event.notification.data?.notificationId;
  const url=new URL(receipt?'/#notifications?view='+encodeURIComponent(receipt):'/#'+route,self.location.origin).href;
  for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){
   if(new URL(client.url).origin===self.location.origin){await client.navigate(url);await client.focus();return;}
  }
  await self.clients.openWindow(url);
 })());
});
