import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function verifyMonths() {
  const sources=await Promise.all(['../server.js','../public/index.html'].map(path=>readFile(new URL(path,import.meta.url),'utf8')));
  const extract=source=>{const start=source.indexOf('const Core = (() => {');return source.slice(start,source.indexOf('\n})();',start)+6);};
  assert.equal(extract(sources[0]),extract(sources[1]),'server and browser use identical financial rules');
  const C=new Function(extract(sources[0])+'\nreturn Core;')();
  let checks=1;
  const eq=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;};
  const item=(id,type,repeat='monthly',date='2024-01-31',amount=10000)=>({id,title:id,type,repeat,date,amount});
  const plan=items=>({...C.fresh(),balance:1000000,items});
  for(const type of ['income','payment']){
    const s=plan([item(type,type)]);
    const first=C.currentEvents(s,type,'2024-01-31')[0];
    eq(first.originalDate,'2024-01-31',type+': January anchor');
    C.record(s,first,10000,'2024-01-31');
    eq(C.currentEvents(s,type,'2024-01-31'),[],type+': confirmed entry disappears this month');
    eq(C.scheduled(s,'2024-01-31','2024-01-31',true),[],type+': confirmation removes forecast event');
    const feb=C.currentEvents(s,type,'2024-02-01')[0];
    eq(feb.originalDate,'2024-02-29',type+': returns on first day with leap-month due date');
    eq(s.ledger[0].plannedDate,'2024-01-31',type+': previous history retained');
    C.record(s,feb,12000,'2024-02-01');
    eq(C.currentEvents(s,type,'2024-02-15'),[],type+': early confirmation hides February entry');
    eq(C.currentEvents(s,type,'2024-03-01')[0].originalDate,'2024-03-31',type+': March restores original day');
    eq(s.ledger.map(e=>[e.date,e.plannedDate]),[['2024-02-01','2024-02-29'],['2024-01-31','2024-01-31']],type+': actual and scheduled dates preserved');
    eq(s.balance,type==='income'?1022000:978000,type+': balance changes only for actual confirmations');
    eq(C.validate(s),s,type+': persisted plan remains valid');
    const once=plan([item('once',type,'none')]);
    C.record(once,C.currentEvents(once,type,'2024-01-31')[0],10000,'2024-01-31');
    eq(C.currentEvents(once,type,'2024-02-01'),[],type+': one-time entry never returns');
    const entry=once.ledger[0];
    once.balance+=type==='income'?-entry.amount:entry.amount;delete once.done[entry.key];once.ledger=[];
    eq(C.currentEvents(once,type,'2024-02-01')[0].key,'once@2024-01-31',type+': undo restores one-time entry');
    eq(once.balance,1000000,type+': undo restores balance');
  }
  const unpaid=plan([item('rent','payment'),item('salary','income'),item('once','payment','none')]);
  eq(C.scheduled(unpaid,'2024-02-01','2024-02-29',true).map(e=>e.key).sort(),['once@2024-01-31','rent@2024-02-29','salary@2024-02-29'],'monthly unpaid January does not carry into February');
  eq(C.pastEvents(unpaid,'payment','2024-02-01'),[],'monthly reset creates no separate overdue debt');
  eq(C.currentEvents(unpaid,'payment','2024-02-01').map(e=>e.key),['rent@2024-02-29','once@2024-01-31'],'once-overdue remains pending while monthly cycle resets');
  eq(C.scheduled(plan([item('rent','payment')]),'2024-01-31','2024-01-31',true)[0].overdue,false,'current monthly date retained');
  eq(C.scheduled(plan([item('rent','payment','monthly','2024-01-15')]),'2024-01-31','2024-01-31',true)[0].overdue,true,'unpaid current-month charge remains overdue until reset');
  eq(C.scheduled(unpaid,'2024-01-29','2024-03-10',false,'2024-02-01').filter(e=>e.id==='rent').map(e=>e.originalDate),['2024-02-29'],'calendar spillover hides old unpaid monthly dates');
  const future=plan([item('future','income','monthly','2024-04-10')]);
  eq(C.currentEvents(future,'income','2024-02-01')[0].originalDate,'2024-04-10','new future schedule remains manageable');
  C.record(future,C.currentEvents(future,'income','2024-02-01')[0],10000,'2024-02-01');
  eq(C.currentEvents(future,'income','2024-04-01'),[],'early future confirmation is not repeated');
  eq(C.currentEvents(future,'income','2024-05-01')[0].originalDate,'2024-05-10','future schedule returns in next cycle');
  for(const [repeat,next,date] of [['weekly','2024-02-05','2024-02-07'],['yearly','2025-01-01','2025-01-31']]){
    const s=plan([item(repeat,'payment',repeat)]);
    C.record(s,C.currentEvents(s,'payment','2024-01-31')[0],10000,'2024-01-31');
    eq(C.currentEvents(s,'payment','2024-01-31'),[],repeat+': current cycle hidden');
    eq(C.currentEvents(s,'payment',next)[0].originalDate,date,repeat+': next cycle restored');
  }
  eq(C.monthEnd('2024-02-10'),'2024-02-29','leap February month end');
  eq(C.monthEnd('2025-02-10'),'2025-02-28','ordinary February month end');
  eq(C.forecastEnd('2024-01-31'),'2024-02-29','two-month cutoff current plus next');
  eq(C.forecastEnd('2024-12-31'),'2025-01-31','two-month cutoff across year');
  const financial=plan([item('pay','payment','none','2024-02-29',20000),item('income','income','none','2024-02-28',50000),item('outside','income','none','2024-03-01',999999)]);
  financial.daily=1000;
  const f=C.monthlyForecast(financial,'2024-02-28');
  eq(f.end,'2024-02-29','monthly forecast exact cutoff');
  eq(f.rows.map(r=>r.date),['2024-02-28','2024-02-29'],'forecast includes today and month end');
  eq(f.accountEnd,1028000,'month-end accounts include incomes, payments and daily spending');
  eq(f.availableEnd,1028000,'without goals available equals accounts');
  const longer=C.forecast(financial,'2024-01-31');
  eq(longer.rows.at(-1).date,'2024-02-29','default forecast ends next month');
  eq(longer.events.some(e=>e.id==='outside'),false,'forecast excludes following month');
  const goals=plan([]);
  goals.daily=1000;
  goals.goals=[{id:'goal',title:'goal',target:100000,saved:50000,mode:'monthly',monthly:10000,start:'2024-01-31',deadline:'2024-01-31',done:[]}];
  const savings=C.monthlyForecast(goals,'2024-01-31');
  eq(savings.availableEnd,939000,'available month-end deducts reserved and planned saving');
  eq(savings.accountEnd,999000,'goal transfers do not reduce total on accounts');
  eq(C.allowance(plan([]),'2024-02-28').count,2,'without incomes daily limit uses remaining calendar days');
  const budget=plan([
    item('first','income','monthly','2024-01-01',150000),
    item('salary','income','monthly','2024-01-31',300000),
    item('week','payment','weekly','2024-01-03',5000),
    item('purchase','payment','none','2024-01-10',10000),
    item('rent','payment','monthly','2024-01-31',20000),
    item('outside','income','none','2024-02-01',999999),
    item('past','payment','none','2023-12-31',999999)
  ]);
  budget.daily=1000;
  budget.goals=[{id:'budgetgoal',title:'Подушка',target:100000,saved:50000,mode:'monthly',monthly:10000,start:'2024-01-31',deadline:'2024-01-31',done:[]}];
  const totals=()=>C.monthOverview(budget,'2024-01-15');
  const before=totals();
  eq([before.start,before.end,before.count],['2024-01-01','2024-01-31',31],'summary covers full month, including days before today');
  eq([before.income,before.payments,before.daily,before.expenses,before.savings,before.opening,before.remaining],[450000n,55000n,31000n,86000n,10000n,1000000n,1354000n],'full-month totals include all occurrences, daily budget and opening balance');
  C.record(budget,C.currentEvents(budget,'payment','2024-01-15').find(e=>e.id==='purchase'),12000,'2024-01-14','2024-01-15');
  eq(totals(),{...before,specified:true},'paying a different actual amount does not change monthly plan or opening');
  C.record(budget,C.currentEvents(budget,'income','2024-01-15').find(e=>e.id==='salary'),280000,'2024-01-15','2024-01-15');
  eq(totals(),{...before,specified:true},'early income confirmation leaves complete monthly summary unchanged');
  C.record(budget,C.currentEvents(budget,'income','2024-01-15').find(e=>e.id==='first'),160000,'2023-12-31','2024-01-15');
  eq(totals(),{...before,specified:true},'backdated confirmation does not shift already fixed opening budget');
  const entry=budget.ledger[0];budget.balance-=entry.amount;delete budget.done[entry.key];budget.ledger=budget.ledger.filter(e=>e.id!==entry.id);
  eq(totals(),{...before,specified:true},'undo does not remove planned income from monthly totals');
  const expense=item('expense','payment','none','2024-01-05',6000);
  budget.items.push(expense);C.record(budget,C.currentEvents(budget,'payment','2024-01-15').find(e=>e.id==='expense'),6000,'2024-01-05','2024-01-15');
  eq([totals().payments,totals().expenses,totals().remaining],[61000n,92000n,1348000n],'quick recorded expense is included exactly once through its plan item');
  const goal=budget.goals[0];
  C.freezeGoalMonth(goal,'2024-01-15');goal.saved+=5000;goal.done.push('2024-01-31');
  eq(totals().savings,10000n,'partial actual goal contribution does not remove planned monthly contribution');
  goal.saved=goal.target;
  eq(totals().savings,10000n,'completing goal retains this month contribution');
  eq(C.monthOverview(budget,'2024-02-01').savings,0n,'completed goal does not add a new contribution next month');
  budget.monthlyIncludeDaily=false;
  eq([totals().daily,totals().expenses,totals().remaining],[0n,61000n,1379000n],'daily-budget switch excludes only daily allocation');
  const actualBalance=budget.balance;budget.monthBalances['2024-01']=200000;
  eq([totals().opening,totals().remaining],[200000n,579000n],'explicit opening balance is added once');
  eq(budget.balance,actualBalance,'editing opening does not change actual balance');
  eq(C.validate(budget),budget,'new month fields persist in a valid plan');
  const legacy=plan([]);legacy.balance=1000;
  legacy.ledger=[{type:'income',date:'2024-01-05',amount:600},{type:'payment',date:'2024-01-10',amount:800},{type:'payment',date:'2023-12-31',amount:500}];
  eq(C.monthOpening(legacy,'2024-01-15'),1200n,'legacy opening is reconstructed from actual month history');
  legacy.ledger.push({type:'income',date:'2024-02-01',amount:400});
  eq(C.monthOpening(legacy,'2024-01-15'),800n,'reconstruction reverses later-month actual operations too');
  const leap=plan([item('leap','income','monthly','2024-01-31',10000)]);leap.daily=1000;
  eq([C.monthOverview(leap,'2024-02-15').income,C.monthOverview(leap,'2024-02-15').daily],[10000n,29000n],'summary uses leap February last-day anchor and all 29 days');
  eq(C.monthOverview(leap,'2025-02-15').daily,28000n,'summary uses ordinary February 28 days');
  const deadline={id:'deadline',title:'deadline',target:90000,saved:0,mode:'deadline',monthly:0,start:'2024-01-31',deadline:'2024-03-31',done:[]};
  eq(C.goalMonthAmount(deadline,'2024-01-15'),30000,'deadline goal monthly allocation');
  C.freezeGoalMonth(deadline,'2024-01-15');deadline.saved=30000;deadline.done=['2024-01-31'];
  eq(C.goalMonthAmount(deadline,'2024-01-15'),30000,'deadline contribution remains after reservation');
  eq(C.goalMonthAmount(deadline,'2024-02-01'),30000,'deadline remaining allocation for following month');
  const finalGoal={...deadline,target:5000,saved:0,mode:'monthly',monthly:10000,start:'2024-01-01',done:[],monthPlans:undefined};
  eq(C.goalMonthAmount(finalGoal,'2024-01-15'),5000,'last contribution is capped at remaining goal amount');
  C.freezeGoalMonth(finalGoal,'2024-01-15');finalGoal.saved=5000;finalGoal.done=['2024-01-01'];
  eq(C.goalMonthAmount(finalGoal,'2024-01-15'),5000,'capped final contribution stays in monthly budget after completion');
  const huge=plan(Array.from({length:500},(_,n)=>item('huge'+n,'payment','none','2024-01-15',99999999999999)));
  eq(C.monthOverview(huge,'2024-01-15').expenses,500n*99999999999999n,'monthly total stays exact beyond Number integer precision');
  for(const invalid of [
    {...budget,monthBalances:{'2024-13':1}},
    {...budget,monthlyIncludeDaily:'false'},
    {...budget,goals:[{...budget.goals[0],monthPlans:{'2024-01':-1}}]}
  ]){assert.throws(()=>C.validate(invalid),/Некоррект/);checks++;}
  for(const type of ['income','payment']){
    const mixed=plan([item('monthly',type,'monthly','2020-06-20'),item('later',type,'none','2026-10-30'),item('earliest',type,'none','2026-10-12'),item('yearly',type,'yearly','2021-10-18')]);
    eq(C.currentEvents(mixed,type,'2026-10-14').map(e=>[e.id,e.date]),[['earliest','2026-10-12'],['yearly','2026-10-18'],['monthly','2026-10-20'],['later','2026-10-30']],type+': active list follows next occurrence, not insertion order or recurring anchor');
    eq(C.currentEvents(mixed,type,'2026-10-14').reduce((sum,e)=>sum+e.amount,0),40000,type+': sorting preserves the planned total');
  }
  console.log('RITM_MONTHS_PASS '+checks+' checks');
}
