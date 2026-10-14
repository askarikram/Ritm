export const defaultReminderPrefs=zone=>({inApp:true,lead:1,time:'09:00',timeZone:zone||'Asia/Qyzylorda',showAmounts:false});
export function validateReminderPrefs(data){
  if(!data||typeof data!=='object'||typeof data.inApp!=='boolean'||typeof data.showAmounts!=='boolean'||![0,1,3].includes(data.lead)||typeof data.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)||typeof data.timeZone!=='string'||data.timeZone.length>80)throw Error('Проверьте настройки напоминаний.');
  try{new Intl.DateTimeFormat('en',{timeZone:data.timeZone}).format();}catch{throw Error('Неизвестный часовой пояс.');}
  return {inApp:data.inApp,lead:data.lead,time:data.time,timeZone:data.timeZone,showAmounts:data.showAmounts};
}
export function localReminderClock(zone,now=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const p=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return {date:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute};
}
export function reminderEvents(Core,plan,prefs,now=new Date(),includeOverdue=true){
  const clock=localReminderClock(prefs.timeZone,now),end=Core.addDays(clock.date,prefs.lead);
  const events=Core.scheduled(plan,clock.date,end,false,clock.date).filter(event=>event.type==='payment');
  if(includeOverdue)for(const event of Core.currentEvents(plan,'payment',clock.date))if(event.overdue&&!events.some(other=>other.key===event.key))events.push(event);
  return events.sort((a,b)=>a.originalDate.localeCompare(b.originalDate)||a.title.localeCompare(b.title));
}
export function duePushEvents(Core,plan,prefs,now=new Date()){
  const clock=localReminderClock(prefs.timeZone,now);
  if(clock.time<prefs.time)return [];
  const date=Core.addDays(clock.date,prefs.lead);
  return Core.scheduled(plan,date,date,false,clock.date).filter(event=>event.type==='payment');
}
export function validatePushSubscription(input,{allowLoopback=false}={}){
  if(!input||typeof input!=='object'||typeof input.endpoint!=='string'||input.endpoint.length>2048||!input.keys||typeof input.keys!=='object')throw Error('Некорректная подписка устройства.');
  let url;try{url=new URL(input.endpoint);}catch{throw Error('Некорректный адрес уведомлений.');}
  const host=url.hostname,provider=host==='fcm.googleapis.com'||host==='web.push.apple.com'||host.endsWith('.push.services.mozilla.com')||host.endsWith('.notify.windows.com');
  const fixture=allowLoopback&&['localhost','127.0.0.1'].includes(host);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!provider&&!fixture||url.port&&url.port!=='443'&&!fixture)throw Error('Адрес не относится к службе уведомлений браузера.');
  const key=(name,length)=>{
    const value=input.keys[name];if(typeof value!=='string'||!/^[A-Za-z0-9_-]+={0,2}$/.test(value)||value.length>120)throw Error('Некорректный ключ устройства.');
    const bytes=Buffer.from(value,'base64url');if(bytes.length!==length||name==='p256dh'&&bytes[0]!==4)throw Error('Некорректный ключ устройства.');return value;
  };
  return {endpoint:url.toString(),keys:{p256dh:key('p256dh',65),auth:key('auth',16)}};
}
