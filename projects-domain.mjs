const Projects = (() => {
 const parse=s=>new Date(s+'T12:00:00Z');
 const validDate=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&s>='1900-01-01'&&s<='2200-12-31'&&!Number.isNaN(parse(s).getTime())&&parse(s).toISOString().slice(0,10)===s;
 const addDays=(s,n)=>{const d=parse(s);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 const weekStart=s=>addDays(s,-((parse(s).getUTCDay()+6)%7));
 const ident=s=>typeof s==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(s);
 const text=(s,n,required=false)=>typeof s==='string'&&s.length<=n&&(!required||s.trim().length>0);
 const time=s=>s===''||typeof s==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(s);
 const count=(n,max)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
 const fresh=()=>({version:1,projects:[],books:[],ideas:[],reviews:[]});
 const data=state=>state.workspace||fresh();
 const progress=book=>{
  const latest=book.logs.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
  const page=latest?.page||0;
  return {page,total:book.total,percent:Math.round(page/book.total*100),latest:latest||null};
 };
 const projectProgress=project=>{const done=project.steps.filter(s=>s.done).length,total=project.steps.length;return {done,total,percent:total?Math.round(done/total*100):0};};
 function syncTasks(state){
  if(!state.workspace)return state;
  for(const p of state.workspace.projects)for(const step of p.steps)if(step.taskId){
   const task=state.tasks.find(t=>t.id===step.taskId);
   if(task)Object.assign(step,{title:task.title,date:task.date,time:task.time,done:task.done,completedOn:task.completedOn});
   else Object.assign(step,{taskId:null,date:'',time:''});
  }
  return state;
 }
 function validate(w,state){
  if(w===undefined){if(state?.tasks.some(t=>t.projectId!==undefined||t.stepId!==undefined))throw Error('Не удалось прочитать связь задачи с проектом.');return;}
  if(!w||w.version!==1||!Array.isArray(w.projects)||!Array.isArray(w.books)||!Array.isArray(w.ideas)||!Array.isArray(w.reviews))throw Error('Не удалось прочитать мои проекты.');
  if(w.projects.length>100||w.books.length>200||w.ideas.length>1000||w.reviews.length>600||JSON.stringify(w).length>2000000)throw Error('В моих проектах слишком много данных.');
  const ids=new Set(),id=s=>{if(!ident(s)||ids.has(s))throw Error('Некорректная запись в моих проектах.');ids.add(s);};
  const stamp=n=>Number.isSafeInteger(n)&&n>=0;
  for(const p of w.projects){
   id(p.id);
   if(!text(p.title,120,true)||!text(p.description,2000)||p.deadline!==''&&!validDate(p.deadline)||!stamp(p.createdAt)||!Array.isArray(p.steps)||p.steps.length>200)throw Error('Проверьте название, срок и шаги проекта.');
   for(const s of p.steps){
    id(s.id);
    if(!text(s.title,120,true)||s.date!==''&&!validDate(s.date)||!time(s.time)||!s.date&&s.time||typeof s.done!=='boolean'||s.completedOn!==null&&!validDate(s.completedOn)||s.taskId!==null&&!ident(s.taskId)||Boolean(s.date)!==Boolean(s.taskId))throw Error('Некорректный шаг проекта.');
    if(state&&s.taskId){const t=state.tasks.find(t=>t.id===s.taskId);if(!t||t.projectId!==p.id||t.stepId!==s.id||['title','date','time','done','completedOn'].some(k=>t[k]!==s[k]))throw Error('Не удалось прочитать связь шага с задачей.');}
   }
  }
  if(state)for(const t of state.tasks)if(t.projectId!==undefined||t.stepId!==undefined){
   const p=w.projects.find(p=>p.id===t.projectId),s=p?.steps.find(s=>s.id===t.stepId);
   if(!s||s.taskId!==t.id)throw Error('Не удалось прочитать связь задачи с проектом.');
  }
  for(const b of w.books){
   id(b.id);
   if(!text(b.title,120,true)||!text(b.author,120)||!count(b.total,100000)||b.total===0||!['want','reading','finished'].includes(b.status)||!stamp(b.createdAt)||!Array.isArray(b.logs)||b.logs.length>3000||!Array.isArray(b.notes)||b.notes.length>100)throw Error('Проверьте название и число страниц книги.');
   const dates=new Set();
   for(const l of b.logs){id(l.id);if(!validDate(l.date)||dates.has(l.date)||!count(l.page,b.total))throw Error('Некорректная история чтения.');dates.add(l.date);}
   const current=progress(b).page;
   if(b.status==='finished'&&current!==b.total||current===b.total&&b.status!=='finished'||b.logs.length&&b.status==='want')throw Error('Статус книги не соответствует прогрессу.');
   for(const n of b.notes){id(n.id);if(!validDate(n.date)||!text(n.text,10000,true))throw Error('Проверьте заметку о книге.');}
  }
  for(const i of w.ideas){id(i.id);if(!text(i.title,120,true)||!text(i.text,10000)||!['personal','work','money','growth'].includes(i.tag)||!stamp(i.createdAt)||!stamp(i.updatedAt))throw Error('Проверьте название и текст идеи.');}
  const weeks=new Set();
  for(const r of w.reviews){if(!validDate(r.week)||weekStart(r.week)!==r.week||weeks.has(r.week)||!text(r.wins,4000)||!text(r.barriers,4000)||!text(r.focus,4000)||!stamp(r.updatedAt))throw Error('Некорректный итог недели.');weeks.add(r.week);}
  return w;
 }
 function mutate(state,command,{day,now,newId}){
  const w=state.workspace||(state.workspace=fresh()),a=command.action.slice('workspace_'.length),item=command.item||{},stamp=now.getTime();
  const find=(list,id)=>{const row=list.find(r=>r.id===id);if(!row)throw Error('Запись уже изменена или удалена. Обновите раздел.');return row;};
  const title=(value,label='Название')=>{if(!text(value,120,true))throw Error(label+' — от 1 до 120 символов.');return value.trim();};
  const string=(value,max)=>{if(!text(value,max))throw Error('Сократите текст до '+max+' символов.');return value.trim();};
  const date=value=>{if(value!==''&&!validDate(value))throw Error('Выберите корректную дату.');return value;};
  const book=()=>find(w.books,command.id);
  const syncBook=b=>{if(b.logs.length)b.status=progress(b).page===b.total?'finished':'reading';else if(b.status==='finished')b.status='reading';};
  const mark=(b,value,id)=>{
   if(!validDate(value.date)||value.date>day||!count(value.page,b.total))throw Error('Укажите прошедшую дату или сегодня и страницу от 0 до '+b.total+'.');
   const existing=id?find(b.logs,id):b.logs.find(l=>l.date===value.date);
   if(id&&b.logs.some(l=>l.date===value.date&&l.id!==id))throw Error('За этот день уже есть отметка. Измените её.');
   if(existing)Object.assign(existing,{date:value.date,page:value.page});else b.logs.push({id:newId(),date:value.date,page:value.page});
   syncBook(b);
  };
  if(a==='project_save'){
   const values={title:title(item.title),description:string(item.description,2000),deadline:date(item.deadline)};
   if(command.id)Object.assign(find(w.projects,command.id),values);else w.projects.unshift({id:newId(),...values,steps:[],createdAt:stamp});
  }else if(a==='project_delete'){
   const p=find(w.projects,command.id),ids=new Set(p.steps.map(s=>s.taskId).filter(Boolean));
   state.tasks=state.tasks.filter(t=>!ids.has(t.id));w.projects=w.projects.filter(p=>p.id!==command.id);
  }else if(a==='step_save'){
   const p=find(w.projects,command.projectId),old=command.id?find(p.steps,command.id):null,values={title:title(item.title,'Шаг'),date:date(item.date),time:item.time};
   if(!time(values.time)||!values.date&&values.time)throw Error('Для времени шага выберите дату.');
   const step=old||{id:newId(),done:false,completedOn:null,taskId:null,...values};
   if(old)Object.assign(step,values);else p.steps.push(step);
   if(values.date){
    let task=step.taskId?find(state.tasks,step.taskId):null;
    if(!task){task={id:newId(),projectId:p.id,stepId:step.id,...values,done:step.done,completedOn:step.completedOn};state.tasks.push(task);step.taskId=task.id;}
    else Object.assign(task,values);
   }else if(step.taskId){state.tasks=state.tasks.filter(t=>t.id!==step.taskId);step.taskId=null;}
  }else if(a==='step_check'){
   if(typeof command.done!=='boolean')throw Error('Проверьте отметку шага.');
   const p=find(w.projects,command.projectId),s=find(p.steps,command.id);s.done=command.done;s.completedOn=command.done?day:null;
   if(s.taskId)Object.assign(find(state.tasks,s.taskId),{done:s.done,completedOn:s.completedOn});
  }else if(a==='step_delete'){
   const p=find(w.projects,command.projectId),s=find(p.steps,command.id);
   if(s.taskId)state.tasks=state.tasks.filter(t=>t.id!==s.taskId);p.steps=p.steps.filter(s=>s.id!==command.id);
  }else if(a==='book_save'){
   if(!count(item.total,100000)||!item.total||!['want','reading','finished'].includes(item.status))throw Error('Укажите число страниц от 1 до 100 000 и статус книги.');
   const values={title:title(item.title),author:string(item.author,120),total:item.total,status:item.status};
   const b=command.id?book():{id:newId(),...values,logs:[],notes:[],createdAt:stamp};
   if(b.logs.some(l=>l.page>item.total))throw Error('Число страниц меньше сохранённых отметок. Сначала исправьте историю чтения.');
   if(item.status==='want'&&b.logs.length)throw Error('У книги уже есть история чтения. Выберите «Читаю».');
   Object.assign(b,values);
   if(!command.id){w.books.unshift(b);if(!count(item.page,item.total))throw Error('Проверьте текущую страницу.');if(item.page>0)mark(b,{date:day,page:item.page});}
   if(item.status==='finished')mark(b,{date:day,page:b.total});
   else syncBook(b);
  }else if(a==='book_delete'){book();w.books=w.books.filter(b=>b.id!==command.id);}
  else if(a==='reading_save')mark(book(),item,command.logId);
  else if(a==='reading_delete'){const b=book();find(b.logs,command.logId);b.logs=b.logs.filter(l=>l.id!==command.logId);syncBook(b);}
  else if(a==='note_save'){
   const b=book(),values={text:string(item.text,10000),date:day};if(!values.text)throw Error('Напишите заметку.');
   if(command.noteId)Object.assign(find(b.notes,command.noteId),{text:values.text});else b.notes.unshift({id:newId(),...values});
  }else if(a==='note_delete'){const b=book();find(b.notes,command.noteId);b.notes=b.notes.filter(n=>n.id!==command.noteId);}
  else if(a==='idea_save'){
   if(!['personal','work','money','growth'].includes(item.tag))throw Error('Выберите тему идеи.');
   const values={title:title(item.title),text:string(item.text,10000),tag:item.tag,updatedAt:stamp};
   if(command.id)Object.assign(find(w.ideas,command.id),values);else w.ideas.unshift({id:newId(),...values,createdAt:stamp});
  }else if(a==='idea_delete'){find(w.ideas,command.id);w.ideas=w.ideas.filter(i=>i.id!==command.id);}
  else if(a==='review_save'){
   if(!validDate(item.week)||weekStart(item.week)!==item.week||item.week>weekStart(day))throw Error('Выберите текущую или прошедшую неделю.');
   const values={week:item.week,wins:string(item.wins,4000),barriers:string(item.barriers,4000),focus:string(item.focus,4000),updatedAt:stamp};
   if(!values.wins&&!values.barriers&&!values.focus)throw Error('Заполните хотя бы один ответ.');
   const old=w.reviews.find(r=>r.week===item.week);if(old)Object.assign(old,values);else w.reviews.unshift(values);
  }else if(a==='review_delete'){const old=w.reviews.find(r=>r.week===command.week);if(!old)throw Error('Итог недели не найден.');w.reviews=w.reviews.filter(r=>r.week!==command.week);}
  else throw Error('Действие не поддерживается.');
  syncTasks(state);validate(w,state);
  return state;
 }
 function weekStats(state,week){
  const end=addDays(week,6),inWeek=d=>d&&d>=week&&d<=end,days=new Set();
  for(const b of data(state).books)for(const l of b.logs)if(inWeek(l.date))days.add(l.date);
  return {tasks:state.tasks.filter(t=>t.done&&inWeek(t.completedOn)).length,habits:Object.keys(state.checks).filter(k=>inWeek(k.slice(k.lastIndexOf('@')+1))).length,readingDays:days.size};
 }
 return {fresh,data,validDate,weekStart,addDays,progress,projectProgress,syncTasks,validate,mutate,weekStats};
})();
export { Projects };
