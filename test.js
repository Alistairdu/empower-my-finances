// `node test.js` — no dependencies, no build step, nothing to install.
//
// The series arithmetic is the one part of this extension that can be wrong
// without looking wrong: a balance graph draws a confident line through
// whatever it is handed. So the functions that build it are lifted out of
// content.js by name and run against made-up history and transactions, where
// the right answer is known. The source is read rather than copied, so a test
// that passes is a statement about the code that actually ships.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'content.js'), 'utf8');

function grab(name) {
  const i = src.indexOf(`\n  function ${name}(`);
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const names = [
  'seriesFrom', 'flattenHistory', 'accountTypeById', 'changeAt', 'chartChange',
  'lastChange', 'selectedChange', 'txnNet', 'reconcile', 'reconciledSpan',
  'accountNames', 'lastReported', 'indexOfDay', 'dayKey', 'isLive', 'normalise',
];

const ctx = {
  DAY_MS: 86400000,
  ymd: (d) => new Date(d).toISOString().slice(0, 10),
  LIABILITIES: new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE']),
  rawAccounts: [],
  series: null,
  txns: null,
  selFrom: null,
  selTo: null,
  Date, Set, Map, Number, String, Math, JSON, isFinite, Array, Object, console,
};
vm.createContext(ctx);
vm.runInContext(names.map(grab).join('\n'), ctx);

let fails = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}  got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`);
};
const section = (s) => console.log(`\n— ${s}`);

const BANK = 1, CARD = 2;
const accounts = [
  { userAccountId: BANK, productType: 'BANK', balance: 0, name: 'Checking' },
  { userAccountId: CARD, productType: 'CREDIT_CARD', balance: 0, name: 'Blue Card' },
];
ctx.rawAccounts = accounts;

const realNow = Date.now;
const setToday = (d) => { Date.now = () => Date.parse(d + 'T12:00:00Z'); };
// Before the series: no live reading is taken, so history stands alone.
const noToday = () => setToday('2026-07-01');

const hist = (rows) => ({ spData: { histories: rows.map(([id, date, balance]) => ({ userAccountId: id, date, balance })) } });
const txn = (id, day, amount, type) => ({ day, amount, acctId: String(id), type: type || '', desc: '', account: '' });
// fetchTransactions tags the list with the window it asked for. Everything the
// tests hand in covers the whole of July.
const loaded = (list) => Object.assign(list, { from: '2026-07-01' });

// A bank that reports every day, climbing 100/day from 5000 on the 20th.
const bankRows = [];
for (let d = 20; d <= 28; d++) bankRows.push([BANK, `2026-07-${d}`, 5000 + (d - 20) * 100]);
const values = (s) => s.map((p) => [p.date.slice(8), p.value]);

// ---------------------------------------------------------------------------
section('a card silent for a week, with transactions that reconcile');
// Reports 2000 owed on the 20th, nothing until the 28th at 2600. The two
// purchases in between account for the whole 600.
noToday();
const rows = [...bankRows, [CARD, '2026-07-20', 2000], [CARD, '2026-07-28', 2600]];
const spend = loaded([txn(CARD, '2026-07-22', -200), txn(CARD, '2026-07-25', -400)]);

const before = ctx.seriesFrom(hist(rows), null);
ctx.series = before;
eq('without transactions, the week lands on one day', ctx.lastChange().delta, -500);
eq('...and the 27th is flat all week', values(before).slice(1, 8).map((v) => v[1]),
  [3100, 3200, 3300, 3400, 3500, 3600, 3700]);

const after = ctx.seriesFrom(hist(rows), spend);
ctx.series = after;
eq('spending lands on the days it happened', values(after),
  [['20', 3000], ['21', 3100], ['22', 3000], ['23', 3100], ['24', 3200],
   ['25', 2900], ['26', 3000], ['27', 3100], ['28', 3200]]);
eq('the daily change is the bank alone', ctx.lastChange().delta, 100);
// −200 of card against +100 of bank on the same day.
eq('the 22nd shows the purchase', after[2].value - after[1].value, -100);
eq('nothing is carried on a derived day', after[3].fresh + after[3].derived, after[3].of);
eq('derived days are counted as derived', [after[3].fresh, after[3].derived], [1, 1]);
eq('the long figure is the graph end to end',
  ctx.chartChange().delta, after[8].value - after[0].value);
eq('...and reports the span it covers', ctx.chartChange().days, 8);

// ---------------------------------------------------------------------------
section('a gap the transactions do not account for');
// The card closes at 2650, but only 600 of the 650 is explained. Filling the
// gap would mean inventing the other 50, so it carries as before.
const short = [...bankRows, [CARD, '2026-07-20', 2000], [CARD, '2026-07-28', 2650]];
const s2 = ctx.seriesFrom(hist(short), spend);
ctx.series = s2;
eq('unreconciled gap carries', values(s2).slice(1, 8).map((v) => v[1]),
  [3100, 3200, 3300, 3400, 3500, 3600, 3700]);
eq('and says an account was carried', [s2[4].fresh, s2[4].derived, s2[4].of], [1, 0, 2]);
eq('a cent short is still short', ctx.seriesFrom(
  hist([...bankRows, [CARD, '2026-07-20', 2000], [CARD, '2026-07-28', 2600.01]]), spend
)[4].derived, 0);

// ---------------------------------------------------------------------------
section('transaction days history never reported');
// The bank reports Mon-Fri only. Saturday's card purchase has no history point
// to land on, so one is added for it.
noToday();
const wk = [
  [BANK, '2026-07-24', 5000], [BANK, '2026-07-27', 5000],
  [CARD, '2026-07-24', 1000], [CARD, '2026-07-27', 1300],
];
const weekend = loaded([txn(CARD, '2026-07-25', -300)]);
const s3 = ctx.seriesFrom(hist(wk), weekend);
ctx.series = s3;
eq('the weekend gets a point of its own', values(s3),
  [['24', 4000], ['25', 3700], ['26', 3700], ['27', 3700]]);
eq('Saturday is a real 1-day step', ctx.changeAt(s3[0], s3[1]).days, 1);
eq('without the transaction there is no weekend at all',
  values(ctx.seriesFrom(hist(wk), null)), [['24', 4000], ['27', 3700]]);
eq('...and Monday then reads as a three-day step', ctx.seriesFrom(hist(wk), null).length, 2);

section('a movement with no closing balance to prove it');
// Same week, but the card never reports again — so there is nothing to check
// the Saturday purchase against, and it is not drawn. The bank's own days are
// still known: its transactions are loaded and it has none, which is evidence
// of a flat weekend rather than an absence of evidence.
const open = [[BANK, '2026-07-24', 5000], [BANK, '2026-07-27', 5000], [CARD, '2026-07-24', 1000]];
eq('an unprovable movement is left out',
  values(ctx.seriesFrom(hist(open), weekend)),
  [['24', 4000], ['25', 4000], ['26', 4000], ['27', 4000]]);
eq('the card is carried, not derived', ctx.seriesFrom(hist(open), weekend)[1].derived, 1);

// ---------------------------------------------------------------------------
section('sign conventions');
// A card payment is money *in* to the card: owed falls, net cash is unmoved
// because the bank paid for it. Both legs must land on the same day.
noToday();
const payRows = [
  [BANK, '2026-07-20', 5000], [BANK, '2026-07-24', 4500],
  [CARD, '2026-07-20', 2000], [CARD, '2026-07-24', 1500],
];
const pay = loaded([txn(BANK, '2026-07-22', -500), txn(CARD, '2026-07-22', 500)]);
const s4 = ctx.seriesFrom(hist(payRows), pay);
eq('a card payment nets to zero on the day it clears',
  values(s4), [['20', 3000], ['21', 3000], ['22', 3000], ['23', 3000], ['24', 3000]]);
eq('both legs were derived, neither carried', [s4[2].fresh, s4[2].derived], [0, 2]);
eq('the quiet days between two readings are filled in too', s4.length, 5);

// ---------------------------------------------------------------------------
section('live balances as today\'s reading');
setToday('2026-07-28');
accounts[0].balance = 5900;
accounts[1].balance = 2650;
const s5 = ctx.seriesFrom(hist(rows), spend);
ctx.series = s5;
eq('today takes the live balances over history', s5[s5.length - 1].value, 5900 - 2650);
eq('today is flagged live', s5[s5.length - 1].live, true);
eq('earlier days are not', s5[0].live, false);

setToday('2026-07-30');
const s6 = ctx.seriesFrom(hist(rows), spend);
eq('history that stops short still gets a point for today', s6[s6.length - 1].date, '2026-07-30');
eq('and it is the live total', s6[s6.length - 1].value, 5900 - 2650);

// An account that arrives with no balance on it costs only its own reading:
// the other still updates, and the total is over the same accounts either way.
// normalise() would call the missing balance 0, which would read as a card
// paid off in full — so no reading is taken at all and history stands.
setToday('2026-07-28');
delete accounts[1].balance;
const s7 = ctx.seriesFrom(hist(rows), spend);
eq('an account with no balance keeps its history', s7[s7.length - 1].value, 5900 - 2600);
eq('...rather than reading as zero', s7[s7.length - 1].value !== 5900, true);
accounts[1].balance = 2650;

// The live reading closes the trailing gap, so transactions since the last
// history point can be placed too.
setToday('2026-07-28');
accounts[0].balance = 5000;
accounts[1].balance = 1300;
const trail = [[BANK, '2026-07-24', 5000], [CARD, '2026-07-24', 1000]];
const s8 = ctx.seriesFrom(hist(trail), loaded([txn(CARD, '2026-07-26', -300)]));
eq('the trailing gap is filled from the live closing balance',
  values(s8), [['24', 4000], ['25', 4000], ['26', 3700], ['27', 3700], ['28', 3700]]);
accounts[0].balance = 5900;
accounts[1].balance = 2650;

// ---------------------------------------------------------------------------
section('the series still starts where every account has reported');
noToday();
const stagger = [
  [BANK, '2026-07-01', 1000], [BANK, '2026-07-05', 1100],
  [CARD, '2026-07-03', 200], [CARD, '2026-07-05', 250],
];
const s9 = ctx.seriesFrom(hist(stagger), null);
eq('starts at the later first reading', s9[0].date, '2026-07-03');
eq('and carries the bank into it', s9[0].value, 1000 - 200);

// ---------------------------------------------------------------------------
section('selection-driven change');
noToday();
ctx.series = ctx.seriesFrom(hist(rows), spend);
ctx.selFrom = ctx.selTo = null;
eq('no selection, no figure', ctx.selectedChange(), null);

// Both ends inclusive, as the transaction list reads a selection — so the
// measurement starts at the point *before* the first selected day, and what
// happened on that day counts as part of it.
ctx.selFrom = '2026-07-22';
ctx.selTo = '2026-07-26';
const range = ctx.selectedChange();
eq('a range includes its first day', [range.from, range.to], ['2026-07-21', '2026-07-26']);
eq('range delta', range.delta, 3000 - 3100);

ctx.selFrom = ctx.selTo = '2026-07-25';
const one = ctx.selectedChange();
eq('a single day is measured against the day before', one.delta, 2900 - 3200);
eq('single day span', one.days, 1);
eq('single day endpoints', [one.from, one.to], ['2026-07-24', '2026-07-25']);

ctx.selFrom = ctx.selTo = '2026-07-20';
eq('the first point has nothing to measure against', ctx.selectedChange(), null);

ctx.selFrom = ctx.selTo = '2026-08-05';
eq('an out-of-range selection clamps to the last point', ctx.selectedChange().to, '2026-07-28');

// ---------------------------------------------------------------------------
section('the day figure is the net of that day\'s transactions');
ctx.txns = loaded([
  txn(CARD, '2026-07-22', -200),
  txn(CARD, '2026-07-25', -400),
  txn(BANK, '2026-07-25', 250),
]);
eq('a day nets its own transactions', ctx.txnNet('2026-07-25', '2026-07-25'), { sum: -150, n: 2 });
eq('a range nets everything inside it, both ends included',
  ctx.txnNet('2026-07-22', '2026-07-25'), { sum: -350, n: 3 });
eq('a day with nothing on it nets zero', ctx.txnNet('2026-07-23', '2026-07-23'), { sum: 0, n: 0 });
ctx.txns = null;
eq('not loaded is not the same as zero', ctx.txnNet('2026-07-25', '2026-07-25'), null);

// ---------------------------------------------------------------------------
section('the figure and the graph agree where transactions explain the movement');
// Both accounts report daily and every movement has a transaction behind it:
// a −200 card purchase on the 21st, a −300 one on the 22nd, and a 500 card
// payment clearing both legs on the 23rd.
noToday();
const dailyRows = [
  [BANK, '2026-07-20', 5000], [BANK, '2026-07-21', 4800], [BANK, '2026-07-22', 4800],
  [BANK, '2026-07-23', 4300], [BANK, '2026-07-24', 4300],
  [CARD, '2026-07-20', 1000], [CARD, '2026-07-21', 1000], [CARD, '2026-07-22', 1300],
  [CARD, '2026-07-23', 800], [CARD, '2026-07-24', 800],
];
const dailyTxns = loaded([
  txn(BANK, '2026-07-21', -200),
  txn(CARD, '2026-07-22', -300),
  txn(BANK, '2026-07-23', -500),
  txn(CARD, '2026-07-23', 500),
]);
ctx.series = ctx.seriesFrom(hist(dailyRows), dailyTxns);
ctx.txns = dailyTxns;
eq('net cash by day', values(ctx.series),
  [['20', 4000], ['21', 3800], ['22', 3500], ['23', 3500], ['24', 3500]]);

for (const day of ['2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24']) {
  ctx.selFrom = ctx.selTo = day;
  const bal = ctx.selectedChange();
  eq(`${day}: the figure matches the balance movement`,
    ctx.txnNet(day, day).sum, bal.delta);
}

ctx.selFrom = '2026-07-21';
ctx.selTo = '2026-07-23';
eq('a range matches too', ctx.txnNet('2026-07-21', '2026-07-23').sum, ctx.selectedChange().delta);
eq('...and it is the whole three days', ctx.selectedChange().delta, 3500 - 4000);

// A card payment nets to zero without vanishing from the count: both legs are
// listed, and the toggle that hides them removes an equal and opposite pair.
eq('the payment day nets zero across both its legs',
  ctx.txnNet('2026-07-23', '2026-07-23'), { sum: 0, n: 2 });

ctx.selFrom = ctx.selTo = null;
eq('with nothing selected the figure is the last step', ctx.lastChange().delta, 0);
eq('the graph end to end', ctx.chartChange().delta, 3500 - 4000);
eq('...over the days it actually spans', ctx.chartChange().days, 4);

// Everything is accounted for, so there is nothing to reconcile.
eq('a fully explained span reconciles to nothing',
  ctx.reconcile('2026-07-21', '2026-07-24'), []);

// ---------------------------------------------------------------------------
section('balance movement with no transaction behind it');
// The same week, but the bank quietly gains 5 in interest on the 24th and the
// card is charged a 12 fee on the 22nd. Neither posts as a transaction.
noToday();
const driftRows = [
  [BANK, '2026-07-20', 5000], [BANK, '2026-07-21', 4800], [BANK, '2026-07-22', 4800],
  [BANK, '2026-07-23', 4300], [BANK, '2026-07-24', 4305],
  [CARD, '2026-07-20', 1000], [CARD, '2026-07-21', 1000], [CARD, '2026-07-22', 1312],
  [CARD, '2026-07-23', 812], [CARD, '2026-07-24', 812],
];
ctx.series = ctx.seriesFrom(hist(driftRows), dailyTxns);
ctx.txns = dailyTxns;

eq('the interest is attributed to the bank, by name',
  ctx.reconcile('2026-07-24', '2026-07-24'),
  [{ id: '1', name: 'Checking', amount: 5, stale: false, since: '' }]);
eq('the card fee is attributed to the card',
  ctx.reconcile('2026-07-22', '2026-07-22'),
  [{ id: '2', name: 'Blue Card', amount: -12, stale: false, since: '' }]);
// Both accounts reported on both days, so this is money, not reporting.
eq('a reporting account yields a real discrepancy',
  ctx.reconcile('2026-07-24', '2026-07-24')[0].stale, false);
eq('over the whole week, both show up biggest first',
  ctx.reconcile('2026-07-21', '2026-07-24').map((g) => [g.name, g.amount]),
  [['Blue Card', -12], ['Checking', 5]]);

// The point of the rows: listed transactions plus reconciling rows come to
// exactly what the balances did.
ctx.selFrom = '2026-07-21';
ctx.selTo = '2026-07-24';
const listed = ctx.txnNet('2026-07-21', '2026-07-24').sum;
const unexplained = ctx.reconcile('2026-07-21', '2026-07-24').reduce((s, g) => s + g.amount, 0);
eq('the list now adds up to the balance movement',
  Math.round((listed + unexplained) * 100) / 100, ctx.selectedChange().delta);

// A day where nothing posted but the balance moved anyway — the case the rows
// exist for, since the list would otherwise say nothing happened.
ctx.selFrom = ctx.selTo = '2026-07-24';
eq('a day with no transactions still explains itself',
  ctx.txnNet('2026-07-24', '2026-07-24'), { sum: 0, n: 0 });
eq('...via the reconciling row', ctx.reconcile('2026-07-24', '2026-07-24')[0].amount, 5);
eq('...which matches the day\'s balance movement', ctx.selectedChange().delta, 5);

// The span reconciled is the selection, or the whole graph when there is none.
eq('a selection sets the span', ctx.reconciledSpan(), { from: '2026-07-24', to: '2026-07-24' });
ctx.selFrom = ctx.selTo = null;
eq('otherwise it is the graph, from its second point',
  ctx.reconciledSpan(), { from: '2026-07-21', to: '2026-07-24' });

// Nothing to measure against before the first point.
eq('the first point cannot be reconciled', ctx.reconcile('2026-07-20', '2026-07-20'), []);
ctx.txns = null;
eq('nor can anything without the transactions', ctx.reconcile('2026-07-24', '2026-07-24'), []);

// ---------------------------------------------------------------------------
section('an account that has gone quiet is not an account with a discrepancy');
// The card reports 2000 owed on the 20th and nothing until the 28th at 2650.
// Its two purchases come to 600, so the gap does not reconcile (a 50 fee never
// posted) and the balance carries. Measured naively, every day in the silence
// looks like unexplained money, and the whole silence lands on the 28th.
noToday();
const quietRows = [...bankRows, [CARD, '2026-07-20', 2000], [CARD, '2026-07-28', 2650]];
ctx.series = ctx.seriesFrom(hist(quietRows), spend);
ctx.txns = spend;
eq('the gap did not reconcile, so the card is carried',
  ctx.series[5].held.has('2'), true);
eq('the bank reported, so it is not', ctx.series[5].held.has('1'), false);

// The 25th: a 400 purchase the card's balance knows nothing about yet.
const quiet = ctx.reconcile('2026-07-25', '2026-07-25');
eq('the day of a purchase during the silence', [quiet[0].name, quiet[0].amount], ['Blue Card', 400]);
eq('...is reported as a balance that has not caught up', quiet[0].stale, true);
eq('...naming when the account last spoke', quiet[0].since, '2026-07-20');

// The 28th: the balance finally arrives, carrying the whole week at once.
const resumed = ctx.reconcile('2026-07-28', '2026-07-28');
eq('the day it resumes carries the whole silence', resumed[0].amount, -650);
eq('...and is still a reporting story, not a money one', resumed[0].stale, true);

// Across the whole silence, both ends reported, so what is left is the real
// 50 that no transaction accounts for.
const whole = ctx.reconcile('2026-07-21', '2026-07-28');
eq('end to end, only the genuine shortfall remains',
  whole.filter((g) => g.id === '2').map((g) => [g.amount, g.stale]), [[-50, false]]);

// The invariant holds throughout: listed plus reconciling equals the balances.
for (const [a, b] of [['2026-07-25', '2026-07-25'], ['2026-07-28', '2026-07-28'], ['2026-07-21', '2026-07-28']]) {
  ctx.selFrom = a;
  ctx.selTo = b;
  const sum = ctx.txnNet(a, b).sum + ctx.reconcile(a, b).reduce((s, g) => s + g.amount, 0);
  eq(`${a}→${b}: the list still adds up`, Math.round(sum * 100) / 100, ctx.selectedChange().delta);
}
ctx.selFrom = ctx.selTo = null;

Date.now = realNow;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
