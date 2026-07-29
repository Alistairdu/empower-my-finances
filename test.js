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

// The same, for a `const name = ...` declaration: a braced arrow body ends at
// its matching brace, a one-liner at the first semicolon.
function grabConst(name) {
  const i = src.indexOf(`\n  const ${name} = `);
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, braced = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; braced = true; }
    else if (c === '}') { d--; if (braced && d === 0) return src.slice(i, j + 1) + ';'; }
    else if (c === ';' && d === 0 && !braced) return src.slice(i, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}

const names = [
  'seriesFrom', 'flattenHistory', 'accountTypeById', 'changeAt', 'chartChange',
  'lastChange', 'selectedChange', 'txnNet', 'reconcile', 'reconciledSpan',
  'accountNames', 'lastReported', 'totalsAt', 'residuals', 'postedDay', 'indexOfDay', 'dayKey', 'isLive', 'normalise',
];

const ctx = {
  DAY_MS: 86400000,
  LIABILITIES: new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE']),
  rawAccounts: [],
  series: null,
  seriesRev: 0,
  residualCache: null,
  residualKey: '',
  postKeyUsed: '',
  txns: null,
  selFrom: null,
  selTo: null,
  Date, Set, Map, Number, String, Math, JSON, isFinite, Array, Object, console,
};
// Function declarations become properties of the context; `const` bindings are
// lexical and don't, so they are handed out explicitly.
const consts = ['ymd', 'shiftDay', 'todayLocal', 'balanceDay', 'SETTLE_DAYS', 'POST_KEYS', 'POST_MAX_LAG'];
const expose = consts.map((n) => `globalThis.${n} = ${n};`).join('\n');
vm.createContext(ctx);
vm.runInContext(
  names.map(grab).concat(consts.map(grabConst)).join('\n') + '\n' + expose,
  ctx
);

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
const setNow = (iso) => { Date.now = () => Date.parse(iso); };
// Run something as if the browser were at a given UTC offset, in minutes west
// (240 = New York in summer). todayLocal() asks the instant for its offset, so
// stubbing it here is enough.
const RealDate = Date;
const atOffset = (mins, fn) => {
  class TZ extends RealDate {
    getTimezoneOffset() { return mins; }
    static now() { return RealDate.now(); }
  }
  ctx.Date = TZ;
  try { return fn(); } finally { ctx.Date = RealDate; }
};
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
// selectedChange() reads the module-level selection, so set it and ask.
const selectedChangeOn = (d) => { ctx.selFrom = ctx.selTo = d; const c = ctx.selectedChange(); ctx.selFrom = ctx.selTo = null; return c && c.delta; };
ctx.selectedChangeOn = selectedChangeOn;

// ---------------------------------------------------------------------------
section('a card silent for a week, with transactions that reconcile');
// Reports 2000 owed on the 20th, nothing until the 28th at 2600. The two
// purchases in between account for the whole 600.
noToday();
const rows = [...bankRows, [CARD, '2026-07-20', 2000], [CARD, '2026-07-28', 2600]];
const spend = loaded([txn(CARD, '2026-07-22', -200), txn(CARD, '2026-07-25', -400)]);

const before = ctx.seriesFrom(hist(rows), null);
ctx.series = before; ctx.residualCache = null;
eq('without transactions, the week lands on one day', ctx.lastChange().delta, -500);
eq('...and the 27th is flat all week', values(before).slice(1, 8).map((v) => v[1]),
  [3100, 3200, 3300, 3400, 3500, 3600, 3700]);

const after = ctx.seriesFrom(hist(rows), spend);
ctx.series = after; ctx.residualCache = null;
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
ctx.series = s2; ctx.residualCache = null;
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
ctx.series = s3; ctx.residualCache = null;
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
ctx.series = s5; ctx.residualCache = null;
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
ctx.series = ctx.seriesFrom(hist(rows), spend); ctx.residualCache = null;
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
ctx.series = ctx.seriesFrom(hist(dailyRows), dailyTxns); ctx.residualCache = null;
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
ctx.series = ctx.seriesFrom(hist(driftRows), dailyTxns); ctx.residualCache = null;
ctx.txns = dailyTxns;

eq('the interest is attributed to the bank, by name',
  ctx.reconcile('2026-07-24', '2026-07-24'),
  [{ id: '1', name: 'Checking', amount: 5, kind: 'unexplained', when: '' }]);
eq('the card fee is attributed to the card',
  ctx.reconcile('2026-07-22', '2026-07-22'),
  [{ id: '2', name: 'Blue Card', amount: -12, kind: 'unexplained', when: '' }]);
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
ctx.series = ctx.seriesFrom(hist(quietRows), spend); ctx.residualCache = null;
ctx.txns = spend;
eq('the gap did not reconcile, so the card is carried',
  ctx.series[5].held.has('2'), true);
eq('the bank reported, so it is not', ctx.series[5].held.has('1'), false);

// The 25th: a 400 purchase the card's balance knows nothing about yet.
const quiet = ctx.reconcile('2026-07-25', '2026-07-25');
eq('the day of a purchase during the silence', [quiet[0].name, quiet[0].amount], ['Blue Card', 400]);
eq('...is reported as a balance that has not caught up', quiet[0].kind, 'stale');
eq('...naming when the account last spoke', quiet[0].when, '2026-07-20');

// The 28th: the balance finally arrives, carrying the whole week at once.
const resumed = ctx.reconcile('2026-07-28', '2026-07-28');
eq('the day it resumes carries the whole silence', resumed[0].amount, -650);
eq('...and is still a reporting story, not a money one', resumed[0].kind, 'stale');

// Across the whole silence, both ends reported, so what is left is the real
// 50 that no transaction accounts for.
const whole = ctx.reconcile('2026-07-21', '2026-07-28');
eq('end to end, only the genuine shortfall remains',
  whole.filter((g) => g.id === '2').map((g) => [g.amount, g.kind]), [[-50, 'unexplained']]);

// The invariant holds throughout: listed plus reconciling equals the balances.
for (const [a, b] of [['2026-07-25', '2026-07-25'], ['2026-07-28', '2026-07-28'], ['2026-07-21', '2026-07-28']]) {
  ctx.selFrom = a;
  ctx.selTo = b;
  const sum = ctx.txnNet(a, b).sum + ctx.reconcile(a, b).reduce((s, g) => s + g.amount, 0);
  eq(`${a}→${b}: the list still adds up`, Math.round(sum * 100) / 100, ctx.selectedChange().delta);
}
ctx.selFrom = ctx.selTo = null;

// ---------------------------------------------------------------------------
section('a charge dated one day and posted another');
// The shape that filled the list with noise: a card charge dated the 9th that
// the bank posts on the 11th, with the balance republished at 1000 in between.
// Anchoring on balance *changes* rather than on reports now derives straight
// through it — the charge lands on the day it was made, and there is nothing
// left over to report at all.
noToday();
const postRows = [
  [BANK, '2026-07-08', 5000], [BANK, '2026-07-09', 5000], [BANK, '2026-07-10', 5000],
  [BANK, '2026-07-11', 5000], [BANK, '2026-07-12', 5000],
  [CARD, '2026-07-08', 1000], [CARD, '2026-07-09', 1000], [CARD, '2026-07-10', 1000],
  [CARD, '2026-07-11', 1134], [CARD, '2026-07-12', 1134],
];
const postTxns = loaded([txn(CARD, '2026-07-09', -134)]);
ctx.series = ctx.seriesFrom(hist(postRows), postTxns); ctx.residualCache = null;
ctx.txns = postTxns;
ctx.seriesRev = (ctx.seriesRev || 0) + 1;

eq('the charge lands on the day it was made',
  values(ctx.series),
  [['08', 4000], ['09', 3866], ['10', 3866], ['11', 3866], ['12', 3866]]);
for (const d of ['2026-07-09', '2026-07-10', '2026-07-11']) {
  eq(`${d}: no row at all`, ctx.reconcile(d, d), []);
}

// The matcher still earns its keep where deriving can't reach: a balance that
// moves *before* its transaction row appears. There is no closing reading to
// prove the window, so the two halves are left as residuals — and paired.
const lateRows = [
  [BANK, '2026-07-08', 5000], [BANK, '2026-07-09', 5000], [BANK, '2026-07-10', 5000],
  [BANK, '2026-07-11', 5000], [BANK, '2026-07-12', 5000],
  [CARD, '2026-07-08', 1000], [CARD, '2026-07-09', 1000], [CARD, '2026-07-10', 1134],
  [CARD, '2026-07-11', 1134], [CARD, '2026-07-12', 1134],
];
const lateTxns = loaded([txn(CARD, '2026-07-12', -134)]);
ctx.series = ctx.seriesFrom(hist(lateRows), lateTxns); ctx.residualCache = null;
ctx.txns = lateTxns;
ctx.seriesRev++;

const moved = ctx.reconcile('2026-07-10', '2026-07-10');
eq('the day the balance moved is marked settling',
  [moved[0].kind, moved[0].amount], ['settling', -134]);
eq('...pointing at the day the row is dated', moved[0].when, '2026-07-12');
eq('the day the row appears is the other half',
  ctx.reconcile('2026-07-12', '2026-07-12').map((g) => [g.kind, g.amount]), [['settling', 134]]);
eq('a span covering both is silent', ctx.reconcile('2026-07-09', '2026-07-12'), []);

// A genuine discrepancy still gets through: a 9 fee with nothing behind it and
// nothing within the settle window to cancel against.
const feeRows = lateRows.map((r) =>
  r[0] === CARD && r[1] >= '2026-07-11' ? [r[0], r[1], r[2] + 9] : r
);
ctx.series = ctx.seriesFrom(hist(feeRows), lateTxns); ctx.residualCache = null;
ctx.seriesRev++;
eq('the fee is called out on its own day',
  ctx.reconcile('2026-07-11', '2026-07-11').map((g) => [g.kind, g.amount]), [['unexplained', -9]]);
eq('and the settling pair survives beside it',
  ctx.reconcile('2026-07-10', '2026-07-10').map((g) => [g.kind, g.amount]), [['settling', -134]]);

// ---------------------------------------------------------------------------
section('a feed that republishes the same balance for days');
// What a card actually does: report 1000 owed every day while charges are made,
// then move in a lump when the batch posts. Anchored on days the account
// *reported*, every one of those days had a transaction against an unmoved
// balance — so nothing derived, the figures never budged, and each day produced
// an unexplained row pointing the opposite way to its own transaction.
noToday();
const staleRows = [
  [BANK, '2026-07-08', 5000], [BANK, '2026-07-09', 5000], [BANK, '2026-07-10', 5000],
  [BANK, '2026-07-11', 5000], [BANK, '2026-07-12', 5000],
  [CARD, '2026-07-08', 1000], [CARD, '2026-07-09', 1000], [CARD, '2026-07-10', 1000],
  [CARD, '2026-07-11', 1000], [CARD, '2026-07-12', 1360],
];
// Three charges over three days, posting together on the 12th.
const staleTxns = loaded([
  txn(CARD, '2026-07-09', -134),
  txn(CARD, '2026-07-10', -86),
  txn(CARD, '2026-07-11', -140),
]);
ctx.series = ctx.seriesFrom(hist(staleRows), staleTxns); ctx.residualCache = null;
ctx.txns = staleTxns;
ctx.seriesRev++;

eq('the graph moves on the days money moved',
  values(ctx.series),
  [['08', 4000], ['09', 3866], ['10', 3780], ['11', 3640], ['12', 3640]]);
eq('the cards figure moves day to day',
  ctx.series.map((p) => ctx.totalsAt(p).CREDIT_CARD), [1000, 1134, 1220, 1360, 1360]);
eq('the repeated readings are marked derived, not reported',
  [ctx.series[1].fresh, ctx.series[1].derived], [1, 1]);

// And the rows that started all this are gone.
for (const d of ['2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12']) {
  eq(`${d}: nothing left to reconcile`, ctx.reconcile(d, d), []);
}
eq('the day figure is the charge made that day', ctx.txnNet('2026-07-09', '2026-07-09').sum, -134);
eq('...and matches the balance movement', ctx.selectedChangeOn('2026-07-09'), -134);

// A window whose transactions do not add up is still refused, so a stale
// reading is only overwritten where the sums prove it was stale.
const unprovable = loaded([txn(CARD, '2026-07-09', -134)]);
ctx.series = ctx.seriesFrom(hist(staleRows), unprovable); ctx.residualCache = null;
eq('an unproven window keeps the reported figures',
  values(ctx.series),
  [['08', 4000], ['09', 4000], ['10', 4000], ['11', 4000], ['12', 3640]]);

// ---------------------------------------------------------------------------
section('the reported version is the shipped version');
const manifestVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8')
).version;
const codeVersion = (src.match(/const VERSION = '([^']+)'/) || [])[1];
eq('content.js agrees with manifest.json', codeVersion, manifestVersion);

// ---------------------------------------------------------------------------
section('finding a posting date, if the payload has one');
eq('the usual spelling', ctx.postedDay({ postedDate: '2026-07-11' }, '2026-07-09'), '2026-07-11');
eq('another spelling', ctx.postedDay({ settleDate: '2026-07-11' }, '2026-07-09'), '2026-07-11');
eq('a field named like one we did not list',
  ctx.postedDay({ someClearedOn: '2026-07-11' }, '2026-07-09'), '2026-07-11');
eq('posting on the day of the charge', ctx.postedDay({ postDate: '2026-07-09' }, '2026-07-09'), '2026-07-09');
eq('no such field', ctx.postedDay({ transactionDate: '2026-07-09' }, '2026-07-09'), '');

// A field can be named like a posting date and be something else entirely.
// Guarding both ends means a wrong guess falls back rather than corrupting
// every comparison the reconciliation makes.
eq('a date before the charge is not a posting',
  ctx.postedDay({ postedDate: '2026-07-01' }, '2026-07-09'), '');
eq('nor is one a year later',
  ctx.postedDay({ postedDate: '2027-07-11' }, '2026-07-09'), '');
eq('nor is a non-date', ctx.postedDay({ postedDate: 'PENDING' }, '2026-07-09'), '');
eq('and nothing is found without a charge date', ctx.postedDay({ postedDate: '2026-07-11' }, ''), '');

// With posting dates present, the charge lands on the day the balance moved
// and there is nothing left to reconcile at all.
noToday();
const withPost = loaded([
  { ...txn(CARD, '2026-07-09', -134), postDay: '2026-07-11' },
]);
eq('balanceDay prefers the posting date', ctx.balanceDay(withPost[0]), '2026-07-11');
ctx.series = ctx.seriesFrom(hist(postRows), withPost); ctx.residualCache = null;
ctx.txns = withPost;
ctx.seriesRev++;
eq('nothing to reconcile on the charge day', ctx.reconcile('2026-07-09', '2026-07-09'), []);
eq('nor on the posting day', ctx.reconcile('2026-07-11', '2026-07-11'), []);
eq('and the day figure lands where the balance moved',
  ctx.txnNet('2026-07-11', '2026-07-11').sum, -134);
eq('...not on the day it was charged', ctx.txnNet('2026-07-09', '2026-07-09').sum, 0);

// ---------------------------------------------------------------------------
section('the cash and cards figures at the end of a selected span');
noToday();
ctx.series = ctx.seriesFrom(hist(rows), spend); ctx.residualCache = null;
// The 25th: bank at 5500, card at 2600 owed after both purchases.
eq('subtotals as they stood that day',
  ctx.totalsAt(ctx.series[5]), { BANK: 5500, CREDIT_CARD: 2600 });
// Cards come back out positive — the series holds them the other way up, and
// the header subtracts rather than adds.
eq('the card is a positive amount owed', ctx.totalsAt(ctx.series[5]).CREDIT_CARD > 0, true);
eq('cash minus cards is the graph point',
  ctx.totalsAt(ctx.series[5]).BANK - ctx.totalsAt(ctx.series[5]).CREDIT_CARD,
  ctx.series[5].value);
// True at every point, which is what stops the header disagreeing with the graph.
eq('...at every point on the graph',
  ctx.series.every((p) => {
    const t = ctx.totalsAt(p);
    return Math.round((t.BANK - t.CREDIT_CARD) * 100) === Math.round(p.value * 100);
  }), true);

// ---------------------------------------------------------------------------
section('today is the date it is here, not the date it is in Greenwich');
// 22:00 on the 28th in New York is already the 29th in UTC.
setNow('2026-07-29T02:00:00Z');
eq('UTC has already rolled over', ctx.ymd(RealDate.now()), '2026-07-29');
eq('but it is still the 28th here', atOffset(240, () => ctx.todayLocal()), '2026-07-28');
eq('and east of Greenwich it can be the other way', atOffset(-660, () => ctx.todayLocal()), '2026-07-29');

// The graph must not grow a point for a day that hasn't happened.
accounts[0].balance = 5900;
accounts[1].balance = 2650;
const tz = atOffset(240, () => ctx.seriesFrom(hist(rows), spend));
eq('the series ends today', tz[tz.length - 1].date, '2026-07-28');
eq('...with no point for tomorrow', tz.filter((p) => p.date > '2026-07-28').length, 0);
eq('...and today carries the live balances', tz[tz.length - 1].live, true);

// Day arithmetic stays in UTC, where a day string is midnight and stepping one
// lands on midnight — including across a daylight-saving boundary.
eq('stepping forward over a spring change', ctx.shiftDay('2026-03-07', 1), '2026-03-08');
eq('stepping back over it', ctx.shiftDay('2026-03-08', -1), '2026-03-07');
eq('stepping forward over an autumn change', ctx.shiftDay('2026-10-31', 1), '2026-11-01');

Date.now = realNow;
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
