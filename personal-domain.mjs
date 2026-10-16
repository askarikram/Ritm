import { Projects } from './projects-domain.mjs';
const Personal = (() => {
 const parse=date=>new Date(date+'T12:00:00Z');
 const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&value>='1900-01-01'&&value<='2200-12-31'&&!Number.isNaN(parse(value).getTime())&&parse(value).toISOString().slice(0,10)===value;
 const addDays=(date,count)=>{const d=parse(date);d.setUTCDate(d.getUTCDate()+count);return d.toISOString().slice(0,10);};
 const validTime=value=>value===''||typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
 const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(value);
 const validTitle=value=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=120;
 const validZone=zone=>{if(typeof zone!=='string'||zone.length>80)return false;try{new Intl.DateTimeFormat('en',{timeZone:zone}).format();return true;}catch{return false;}};
 const clock=(zone='Asia/Almaty',now=new Date())=>{
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {date:p.year+'-'+p.month+'-'+p.day,time:p.hour+':'+p.minute};
 };
 const fresh=(zone='Asia/Almaty')=>({version:1,timeZone:validZone(zone)?zone:'Asia/Almaty',tasks:[],habits:[],checks:{}});
 const occurs=(habit,date)=>habit.repeat==='daily'?date>=habit.date:date===habit.date;
 function validate(state){
  if(!state||state.version!==1||!validZone(state.timeZone)||!Array.isArray(state.tasks)||!Array.isArray(state.habits)||!state.checks||typeof state.checks!=='object'||Array.isArray(state.checks))throw Error('Не удалось прочитать личные дела.');
  if(state.tasks.length>2000||state.habits.length>100||Object.keys(state.checks).length>30000)throw Error('В личном разделе слишком много записей.');
  const ids=new Set();
  for(const item of [...state.tasks,...state.habits]){
   if(!item||!validId(item.id)||ids.has(item.id)||!validTitle(item.title)||!validDate(item.date)||!validTime(item.time))throw Error('Проверьте название, дату и время.');
   ids.add(item.id);
  }
  for(const task of state.tasks)if(typeof task.done!=='boolean'||task.completedOn!==null&&!validDate(task.completedOn))throw Error('Некорректная отметка задачи.');
  for(const habit of state.habits)if(!['daily','once'].includes(habit.repeat))throw Error('Выберите повторение привычки.');
  for(const [key,done] of Object.entries(state.checks)){
   const pos=key.lastIndexOf('@'),habit=state.habits.find(h=>h.id===key.slice(0,pos)),date=key.slice(pos+1);
   if(done!==true||!habit||!validDate(date)||!occurs(habit,date))throw Error('Некорректная отметка привычки.');
  }
  Projects.validate(state.workspace,state);
  return state;
 }
 const sorted=rows=>rows.sort((a,b)=>(a.time||'24:00').localeCompare(b.time||'24:00')||a.title.localeCompare(b.title));
 function events(state,type,date){
  if(type==='task')return state.tasks.filter(t=>t.date===date).map(t=>({...t,type,key:'task:'+t.id+'@'+date}));
  return state.habits.filter(h=>occurs(h,date)).map(h=>({...h,type:'habit',date,done:!!state.checks[h.id+'@'+date],key:'habit:'+h.id+'@'+date}));
 }
 function focus(rows,time){
  const pending=sorted(rows.filter(row=>!row.done));
  return pending.find(row=>row.time&&row.time<=time)||pending.find(row=>!row.time)||pending[0]||null;
 }
 function dayRows(state,type,date,now=new Date()){
  const c=clock(state.timeZone,now),rows=events(state,type,date),finished=sorted(rows.filter(row=>row.done)),pending=sorted(rows.filter(row=>!row.done));
  const current=date===c.date?focus(pending,c.time):null;
  return [...finished,...(current?[current]:[]),...pending.filter(row=>row!==current)].map(row=>({...row,current:row===current&&(!row.time||row.time<=c.time)}));
 }
 function next(state,type,now=new Date()){
  const c=clock(state.timeZone,now),today=events(state,type,c.date),current=focus(today,c.time);
  if(current)return {...current,current:!current.time||current.time<=c.time};
  if(type==='task'){
   const overdue=state.tasks.filter(t=>!t.done&&t.date<c.date).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'24:00').localeCompare(b.time||'24:00'));
   if(overdue[0])return {...overdue[0],type:'task',key:'task:'+overdue[0].id+'@'+overdue[0].date,current:true,overdue:true};
   const future=state.tasks.filter(t=>!t.done&&t.date>c.date).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'24:00').localeCompare(b.time||'24:00'));
   return future[0]?{...future[0],type:'task',key:'task:'+future[0].id+'@'+future[0].date,current:false}:null;
  }
  const future=state.habits.map(h=>{
   let date=h.date>c.date?h.date:h.repeat==='daily'?addDays(c.date,1):null;
   return date?{...h,type:'habit',date,done:false,current:false,key:'habit:'+h.id+'@'+date}:null;
  }).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||(a.time||'24:00').localeCompare(b.time||'24:00'));
  return future[0]||null;
 }
 function dueEvents(state,now=new Date()){
  const c=clock(state.timeZone,now);
  return [...events(state,'task',c.date),...events(state,'habit',c.date)].filter(row=>!row.done&&row.time&&row.time<=c.time).map(row=>({...row,key:row.key+'@'+row.time}));
 }
 function apply(input,command,now=new Date(),newId=()=>globalThis.crypto.randomUUID()){
  validate(input);
  if(!command||typeof command!=='object'||typeof command.action!=='string')throw Error('Выберите действие.');
  const state=JSON.parse(JSON.stringify(input)),c=clock(state.timeZone,now),a=command.action;
  const readItem=value=>{
   if(!value||!validTitle(value.title)||!validDate(value.date)||!validTime(value.time))throw Error('Укажите название, корректную дату и время.');
   return {title:value.title.trim(),date:value.date,time:value.time};
  };
  const find=(list,id)=>{const row=list.find(row=>row.id===id);if(!row)throw Error('Запись уже изменена или удалена. Обновите личный раздел.');return row;};
  if(a.startsWith('workspace_'))return validate(Projects.mutate(state,command,{day:c.date,now,newId}));
  if(a==='add_task')state.tasks.push({id:newId(),...readItem(command.item),done:false,completedOn:null});
  else if(a==='edit_task')Object.assign(find(state.tasks,command.id),readItem(command.item));
  else if(a==='complete_task'){
   if(typeof command.done!=='boolean')throw Error('Проверьте отметку выполнения.');
   const row=find(state.tasks,command.id);row.done=command.done;row.completedOn=command.done?c.date:null;
  }else if(a==='move_task'){
   const row=find(state.tasks,command.id);
   if(row.done)throw Error('Выполненную задачу нельзя перенести. Сначала снимите отметку.');
   if(!validDate(command.date)||!validTime(command.time))throw Error('Выберите новую дату и время.');
   row.date=command.date;row.time=command.time;
  }else if(a==='delete_task'){find(state.tasks,command.id);state.tasks=state.tasks.filter(row=>row.id!==command.id);}
  else if(a==='add_habit'||a==='edit_habit'){
   const item=readItem(command.item);
   if(!['daily','once'].includes(command.item.repeat))throw Error('Выберите повторение привычки.');
   item.repeat=command.item.repeat;
   if(a==='add_habit')state.habits.push({id:newId(),...item});
   else{
    const row=find(state.habits,command.id);
    const completed=Object.keys(state.checks).filter(key=>key.startsWith(row.id+'@')).map(key=>key.slice(key.lastIndexOf('@')+1));
    if(completed.some(date=>!occurs(item,date)))throw Error('Этот режим скрывает прошлые выполнения. Сохраните прежнюю дату и повторение или добавьте новую привычку.');
    Object.assign(row,item);
   }
  }else if(a==='check_habit'){
   const row=find(state.habits,command.id);
   if(!validDate(command.date)||!occurs(row,command.date)||command.date>c.date||typeof command.done!=='boolean')throw Error('Отметить привычку можно за сегодня или прошедший день.');
   const key=row.id+'@'+command.date;
   if(command.done)state.checks[key]=true;else delete state.checks[key];
  }else if(a==='delete_habit'){
   find(state.habits,command.id);state.habits=state.habits.filter(row=>row.id!==command.id);
   for(const key of Object.keys(state.checks))if(key.startsWith(command.id+'@'))delete state.checks[key];
  }else throw Error('Действие не поддерживается.');
  return validate(Projects.syncTasks(state));
 }
 return {validDate,validTime,validZone,clock,fresh,validate,occurs,events,dayRows,next,dueEvents,apply,addDays};
})();
export { Personal };
