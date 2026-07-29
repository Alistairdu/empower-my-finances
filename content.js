/* Empower — My Numbers
 *
 * Runs in the page's MAIN world on the Empower Personal Dashboard, calls the
 * same internal JSON endpoint the dashboard itself uses (with your existing
 * session cookie — no credentials are stored, sent anywhere, or logged), and
 * renders a floating panel of custom figures.
 *
 * Everything you'd want to change lives in the CONFIG block below.
 */

(function () {
  'use strict';

  const VERSION = '0.18.0';

  // The same file is injected into both the page's MAIN world (where
  // `window.csrf` is reachable) and the extension's ISOLATED world (which
  // always runs, even where MAIN-world injection is unavailable). Only one of
  // them should draw the UI; MAIN wins if it got there, ISOLATED is the
  // fallback. `chrome.runtime.id` only exists in the isolated world.
  const IS_ISOLATED = !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
  const WORLD = IS_ISOLATED ? 'isolated' : 'main';

  console.info(
    `[Empower My Numbers] v${VERSION} loaded in ${WORLD} world on ${location.host}`
  );

  // ===========================================================================
  // CONFIG — edit this bit.
  //
  // `g` is an object of subtotals keyed by Empower's productType:
  //   g.BANK  g.CREDIT_CARD  g.INVESTMENT  g.LOAN  g.MORTGAGE  g.OTHER_ASSETS
  // Every key always exists (0 if you have no such accounts).
  // Liabilities are normalised to a POSITIVE "amount owed", so you subtract.
  // ===========================================================================

  const TILES = [
    {
      label: 'Net Cash',
      hint: 'banks − credit cards',
      primary: true,
      formula: (g) => g.BANK - g.CREDIT_CARD,
    },
    {
      label: 'Cash + Investments',
      accent: 'green',
      formula: (g) => g.BANK + g.INVESTMENT,
    },
    {
      label: 'Net Worth',
      hint: 'assets − liabilities',
      accent: 'green',
      formula: (g) =>
        g.BANK + g.INVESTMENT + g.OTHER_ASSETS - g.CREDIT_CARD - g.LOAN - g.MORTGAGE,
    },
  ];

  // [productType, label, accent]
  const BREAKDOWN = [
    ['BANK', 'Cash', 'green'],
    ['CREDIT_CARD', 'Credit cards'],
    ['INVESTMENT', 'Investments', 'green'],
    ['LOAN', 'Loans'],
    ['MORTGAGE', 'Mortgage'],
    ['OTHER_ASSETS', 'Other assets'],
  ];

  // Empower's own Overview cards to hide, matched case-insensitively against
  // the card's heading text. Add entries here, or use the panel's "Hide a
  // card" picker to click one directly (those are saved in localStorage).
  const HIDE_TILES = [
    'Insights',
    'Emergency Fund',
    'Retirement Savings',
    'Market Movers',
  ];

  const LIABILITIES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE']);

  // Label on the pill and in the panel's title bar.
  const LABEL = 'Analysis';

  // Where the pill and panel sit. Swap `top` for `bottom` to move them down.
  const ANCHOR = 'top:16px;right:20px;';

  // ===========================================================================
  // Endpoint discovery
  //
  // Empower is mid-migration to a "new experience", so the accounts endpoint
  // isn't guaranteed. We record the URLs the page requests (URLs only — never
  // bodies or responses) so that if the known endpoint fails, the panel can
  // tell you what the page is actually calling.
  // ===========================================================================

  const seenUrls = new Set();
  const apiBases = new Set();

  // The dashboard fetches your accounts on load, so the cheapest and most
  // reliable source is the page's own traffic — no CSRF, no CORS, no auth to
  // reproduce. We snoop the response and keep the parsed payload.
  let cached = null; // { accounts, at }
  let capturedCsrf = null;
  let rawAccounts = [];

  const ACCOUNTS_RE = /\/api\/newaccount\/getAccounts2?(\?|$)/;

  function noteUrl(u) {
    try {
      const abs = new URL(u, location.href);
      seenUrls.add(abs.origin + abs.pathname);
      if (abs.pathname.startsWith('/api/')) apiBases.add(abs.origin);
    } catch (_) {}
  }

  // Every dashboard API call posts a valid csrf in its body. Lifting it from
  // there beats scraping the HTML, and it is what makes our own calls to the
  // history and transaction endpoints possible.
  function noteBody(body) {
    try {
      let s = '';
      if (typeof body === 'string') s = body;
      else if (body && typeof body.toString === 'function' &&
               body instanceof URLSearchParams) s = body.toString();
      else return;
      const m = s.match(/(?:^|&)csrf=([^&]*)/);
      if (m && m[1]) capturedCsrf = decodeURIComponent(m[1]);
    } catch (_) {}
  }

  function captureAccounts(json, from) {
    const accounts = json?.spData?.accounts;
    if (Array.isArray(accounts) && accounts.length) {
      cached = { accounts, at: Date.now() };
      console.info(`[Empower My Numbers] captured ${accounts.length} accounts from ${from}`);
      // Data arriving causes no DOM mutation, so nothing would otherwise
      // prompt a repaint of the injected card.
      try {
        const el = document.getElementById(CARD_ID);
        if (el) paintCard(el);
      } catch (_) {}
    }
  }

  (function recordRequests() {
    if (IS_ISOLATED) return; // patching here would only see our own calls

    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url) noteUrl(url);
          if (init && init.body) noteBody(init.body);
        } catch (_) {}
        const p = origFetch.apply(this, arguments);
        if (url && ACCOUNTS_RE.test(url)) {
          p.then((res) => {
            res
              .clone()
              .json()
              .then((j) => captureAccounts(j, 'page fetch'))
              .catch(() => {});
          }).catch(() => {});
        }
        return p;
      };
    }

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        if (url) noteUrl(url);
        if (url && ACCOUNTS_RE.test(String(url))) {
          this.addEventListener('load', () => {
            try {
              captureAccounts(JSON.parse(this.responseText), 'page XHR');
            } catch (_) {}
          });
        }
      } catch (_) {}
      return origOpen.apply(this, arguments);
    };

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      if (body) noteBody(body);
      return origSend.apply(this, arguments);
    };
  })();

  // Known API host, used if nothing better has been observed yet.
  const FALLBACK_BASE = 'https://pc-api.empower-retirement.com';

  function candidateUrls() {
    const bases = [...apiBases];
    if (!bases.includes(FALLBACK_BASE)) bases.push(FALLBACK_BASE);
    bases.push(location.origin);
    const urls = [];
    for (const b of bases) {
      urls.push(b + '/api/newaccount/getAccounts2');
    }
    return [...new Set(urls)];
  }

  function findCsrf() {
    // Most reliable: the token the page just used on one of its own calls.
    if (capturedCsrf) return capturedCsrf;
    if (window.csrf) return window.csrf;
    const m = document.documentElement.innerHTML.match(
      /csrf['"]?\s*[:=]\s*['"]([0-9a-f-]{16,})['"]/i
    );
    return m ? m[1] : null;
  }

  async function postApi(url, csrf) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, apiClient: 'WEB', lastServerChangeId: '-1' }),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} → HTTP ${res.status}`);
    return res.json();
  }

  // Ask the API ourselves. Best effort: it is cross-origin and needs a valid
  // CSRF token, either of which can fail. Snooped data is the safety net.
  async function fetchLive() {
    let csrf = findCsrf();
    if (!csrf) throw new Error('no CSRF token available');

    let lastErr;
    for (const url of candidateUrls()) {
      try {
        let json = await postApi(url, csrf);
        // A stale token comes back with a fresh one in the header; retry once.
        if (json?.spHeader?.errors?.length && json?.spHeader?.csrf) {
          csrf = json.spHeader.csrf;
          json = await postApi(url, csrf);
        }
        const accounts = json?.spData?.accounts;
        if (Array.isArray(accounts) && accounts.length) return accounts;
        lastErr = new Error(`${new URL(url).host} returned no accounts`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('no endpoint responded');
  }

  const FRESH_MS = 90 * 1000;

  async function fetchAccounts() {
    // 1. Recently snooped from the dashboard's own request — always correct.
    if (cached && Date.now() - cached.at < FRESH_MS) {
      return { accounts: cached.accounts, source: 'live', at: cached.at };
    }

    // 2. Ask the API directly.
    try {
      const accounts = await fetchLive();
      return { accounts, source: 'live', at: Date.now() };
    } catch (e) {
      // 3. Fall back to whatever we snooped earlier this session.
      if (cached) {
        return { accounts: cached.accounts, source: 'cached', at: cached.at };
      }
      throw new Error(
        `Could not read your accounts (${e.message}).\n\n` +
          `Reload the dashboard with this panel installed — the page fetches ` +
          `accounts on load and the panel reads that.`
      );
    }
  }

  // ===========================================================================
  // Shaping
  // ===========================================================================

  function isLive(a) {
    if (a.closedDate) return false;
    if (a.isExcludeFromHousehold) return false;
    if (String(a.accountStatus || '').toUpperCase() === 'CLOSED') return false;
    return true;
  }

  // Empower reports liability balances inconsistently (sometimes negative,
  // sometimes positive). Normalise to: assets positive, liabilities positive
  // amount-owed. If a figure reads backwards, this is the function to flip.
  function normalise(a) {
    const raw = Number(a.balance ?? a.currentBalance ?? 0);
    return LIABILITIES.has(a.productType) ? Math.abs(raw) : raw;
  }

  // ===========================================================================
  // History and transactions, for the card's graph and its detail view
  // ===========================================================================

  const DAY_MS = 86400000;
  const ymd = (d) => new Date(d).toISOString().slice(0, 10);

  // Reduce whatever date shape a build hands back to a plain YYYY-MM-DD, so
  // history points and transactions can be compared to each other at all.
  function dayKey(v) {
    const s = String(v || '');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s);
    return isFinite(t) ? ymd(t) : '';
  }

  // Nearest series point to a day, so a selection survives the history being
  // refetched with slightly different coverage.
  function indexOfDay(series, day) {
    if (!series || !series.length) return null;
    let best = 0;
    let bestGap = Infinity;
    const target = Date.parse(day);
    for (let i = 0; i < series.length; i++) {
      if (dayKey(series[i].date) === day) return i;
      const gap = Math.abs(Date.parse(series[i].date) - target);
      if (isFinite(gap) && gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    return best;
  }

  function apiBase() {
    for (const b of apiBases) {
      if (/pc-api|personalcapital|empower/i.test(b)) return b;
    }
    return FALLBACK_BASE;
  }

  async function apiPost(path, params) {
    const csrf = findCsrf();
    if (!csrf) throw new Error('no CSRF token seen yet — reload the dashboard');
    const res = await fetch(apiBase() + path, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, apiClient: 'WEB', ...params }),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    const json = await res.json();
    const errs = json?.spHeader?.errors;
    if (errs && errs.length) {
      throw new Error(errs[0].message || `${path} was rejected`);
    }
    return json;
  }

  function cashAccountIds() {
    return rawAccounts
      .filter((a) => isLive(a) && (a.productType === 'BANK' || a.productType === 'CREDIT_CARD'))
      .map((a) => a.userAccountId ?? a.accountId ?? a.id)
      .filter((v) => v !== undefined && v !== null);
  }

  // Response shapes vary across Empower's builds, so read defensively and key
  // off whatever identifies the account rather than a fixed field name.
  // Balances come back either as a flat list of per-account-per-day rows, or
  // as one entry per account with a nested array of points. Handle both, and
  // read whichever field name this build happens to use.
  function flattenHistory(sp) {
    const out = [];
    const pt = (id, p) => ({
      id,
      date: p.date || p.asOfDate || p.balanceDate || p.transactionDate,
      balance: Number(p.balance ?? p.value ?? p.currentBalance ?? p.amount),
    });
    const roots = [sp && sp.histories, sp && sp.accountHistories, sp && sp.balances];
    for (const rows of roots) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const id = r.userAccountId ?? r.accountId ?? r.id;
        const nested = r.histories || r.balances || r.dailyBalances || r.aggregates;

        // The live shape: one row per date, with `balances` an object keyed by
        // account id — plus sibling "<id>Annotation" strings to skip.
        if (nested && !Array.isArray(nested) && typeof nested === 'object') {
          const date = r.date || r.asOfDate || r.balanceDate;
          for (const key of Object.keys(nested)) {
            if (/Annotation$/i.test(key)) continue;
            const bal = Number(nested[key]);
            if (!isFinite(bal)) continue;
            out.push({ id: key, date, balance: bal });
          }
          continue;
        }

        if (Array.isArray(nested)) {
          for (const p of nested) out.push(pt(id, p));
        } else {
          out.push(pt(id, r));
        }
      }
    }
    return out;
  }

  // productType keyed by account id, for anything that arrives carrying an id
  // but no type of its own — history points and transactions both do.
  function accountTypeById() {
    const m = new Map();
    for (const a of rawAccounts) {
      const id = a.userAccountId ?? a.accountId ?? a.id;
      if (id != null) m.set(String(id), a.productType);
    }
    return m;
  }

  // Net cash per day, summed over the *same* accounts every day.
  //
  // Summing whatever reported on each date is what makes this wrong: accounts
  // don't all sync daily, and a day where a card didn't report drops that
  // card's debt from the total, so net cash leaps up and falls back the next
  // day. That is a reporting gap being drawn as a spike — and it corrupts any
  // comparison between two dates, which is exactly what the 90-day figure is.
  //
  // Each account's balance for a given day therefore comes from one of three
  // places, in order of authority:
  //
  //   1. what the account reported that day — including a live balance from
  //      the accounts payload, which is a reading for today like any other and
  //      a fresher one than history's
  //   2. what the dated transactions say it must have been, across a gap whose
  //      two ends both reported and whose transactions add up to the difference
  //   3. its last known balance, carried
  //
  // (2) is why transactions are loaded for the graph and not just the detail
  // view. Carrying forward keeps the total comparable across a reporting gap,
  // but it moves the account's whole gap onto the day it resumes: a card silent
  // for a week posts seven days of spending as a single step, and the daily
  // change reads that step as one day's worth. We know when the money actually
  // moved — the transactions are dated — so where those dated movements account
  // for the gap exactly, they walk the balance across it day by day instead.
  //
  // "Exactly" is the safeguard, and it is the whole of it. A gap is only filled
  // when its transactions reconcile to the cent against the balances at both
  // ends. A pending charge, an interest posting, a transaction window that
  // doesn't reach back far enough — any of them and the sums won't meet, which
  // means the gap isn't understood, and it carries forward as before rather
  // than being filled with something plausible-looking.
  function seriesFrom(json, movements) {
    const typeById = accountTypeById();
    const perAcct = new Map(); // id → Map(day → signed balance)
    const reported = new Set(); // days some account actually reported on

    for (const h of flattenHistory(json && json.spData)) {
      const type = typeById.get(String(h.id));
      // Net cash is banks minus cards only. The endpoint can return every
      // account, so filter here rather than trusting the request filter.
      if (type !== 'BANK' && type !== 'CREDIT_CARD') continue;
      const day = dayKey(h.date);
      if (!day || !isFinite(h.balance)) continue;
      const id = String(h.id);
      if (!perAcct.has(id)) perAcct.set(id, new Map());
      perAcct.get(id).set(day, type === 'CREDIT_CARD' ? -Math.abs(h.balance) : h.balance);
      reported.add(day);
    }
    if (!perAcct.size) return [];

    // A live balance is a reading for today, and a better one than history's:
    // the accounts payload is current, where history stops at yesterday or
    // carries today's row from a balance taken before this morning's sync.
    // It also gives each account a closing balance to reconcile its most
    // recent gap against, which history alone never provides for the days
    // since it last spoke. Per account rather than as one total, so an account
    // missing from the payload costs only its own reading.
    const today = ymd(Date.now());
    const live = new Set();
    for (const a of rawAccounts) {
      if (!isLive(a)) continue;
      const id = String(a.userAccountId ?? a.accountId ?? a.id);
      const m = perAcct.get(id);
      if (!m) continue;
      // normalise() defaults a missing balance to 0, which is a real figure and
      // a badly wrong one — a card with no balance field would read as paid off.
      // Only take a reading from an account that actually carries one.
      const raw = a.balance ?? a.currentBalance;
      if (raw === null || raw === undefined || !isFinite(Number(raw))) continue;
      const v = normalise(a);
      let latest = '';
      for (const d of m.keys()) if (d > latest) latest = d;
      // History dated ahead of the clock is not something to argue with.
      if (latest > today) continue;
      // normalise() hands liabilities back as a positive amount owed; the
      // series signs them the other way. Going through it anyway keeps the
      // sign fix in one place, as the README promises.
      m.set(today, a.productType === 'CREDIT_CARD' ? -v : v);
      live.add(id);
      reported.add(today);
    }

    // The series can only start once every account has a balance to carry.
    let start = '';
    for (const m of perAcct.values()) {
      let first = '';
      for (const d of m.keys()) if (!first || d < first) first = d;
      if (first > start) start = first;
    }

    // Movements per account per day. The series signs a card as a negative
    // amount owed and transaction amounts are already signed money-in/money-out,
    // so the two agree without conversion: a $100 card purchase is −100 to
    // both the balance and the total, and a $500 card payment is +500 to both.
    //
    // Not having the transactions yet is a different thing from an account
    // having none, and the difference matters: a gap whose balance happens to
    // end where it started reconciles against an empty list trivially, and
    // would be drawn as a flat stretch on no evidence at all. Derive only from
    // a list we actually hold, and only back as far as it was asked to cover —
    // before that, "no transactions" means "none loaded", not "none happened".
    const haveTxns = Array.isArray(movements);
    const txnFrom = (movements && movements.from) || '';
    const moved = new Map(); // id → Map(day → summed amount)
    for (const t of movements || []) {
      if (!t || !t.day || !isFinite(t.amount) || !perAcct.has(t.acctId)) continue;
      if (!moved.has(t.acctId)) moved.set(t.acctId, new Map());
      const m = moved.get(t.acctId);
      m.set(t.day, (m.get(t.day) || 0) + t.amount);
    }

    const cents = (n) => Math.round(n * 100);
    const nextDay = (d) => ymd(Date.parse(d) + DAY_MS);
    const known = new Map(); // id → Map(day → value)
    const derived = new Map(); // id → Set(day) worked out rather than reported

    for (const [id, m] of perAcct) {
      const vals = new Map(m);
      const from = new Set();
      const mv = moved.get(id) || new Map();
      const said = [...m.keys()].sort();

      for (let k = 0; haveTxns && k + 1 < said.length; k++) {
        const a = said[k];
        const b = said[k + 1];
        if (a < txnFrom) continue;

        let total = 0;
        for (const [d, amt] of mv) if (d > a && d <= b) total += amt;
        // Doesn't add up: the gap isn't understood, so leave it to be carried.
        if (cents(total) !== cents(m.get(b) - m.get(a))) continue;

        // Every calendar day between the two readings, not just the ones a
        // transaction is dated on. Inside a gap that reconciles, the balance on
        // each day is known exactly: it is the earlier reading plus whatever is
        // dated on or before that day, and the later reading proves the sum.
        // The quiet days in between are the flat stretches of the graph, and
        // they are as known as the days money moved.
        let v = m.get(a);
        for (let d = nextDay(a); d < b; d = nextDay(d)) {
          v += mv.get(d) || 0;
          vals.set(d, v);
          from.add(d);
        }
      }
      known.set(id, vals);
      derived.set(id, from);
    }

    // A day is worth drawing if anyone reported on it or anyone can be shown to
    // have been at a particular balance on it. A day where every account is
    // merely carrying holds no information, and drawing a point for it implies
    // a daily resolution the data doesn't have.
    const days = new Set(reported);
    for (const from of derived.values()) for (const d of from) days.add(d);

    const carry = new Map();
    const out = [];
    for (const day of [...days].sort()) {
      // How the day was arrived at, per account, so the change figure can say
      // what it is really comparing.
      let fresh = 0;
      let worked = 0;
      const held = new Set();
      for (const [id, vals] of known) {
        if (!vals.has(day)) {
          if (carry.has(id)) held.add(id);
          continue;
        }
        carry.set(id, vals.get(day));
        if (derived.get(id).has(day)) worked++;
        else fresh++;
      }
      // Days before the start still build up `carry`; they just aren't drawn.
      if (day < start) continue;
      let sum = 0;
      for (const v of carry.values()) sum += v;
      out.push({
        date: day,
        value: sum,
        fresh,
        derived: worked,
        of: perAcct.size,
        live: day === today && live.size > 0,
        // The per-account balances behind the total, so a discrepancy between
        // the graph and the transaction list can be attributed to the account
        // it came from. A copy: `carry` goes on being mutated.
        parts: new Map(carry),
        // Which of them are carried rather than known today. A carried balance
        // is not a statement about this day, so any difference measured against
        // it is a statement about reporting, not about money.
        held,
      });
    }
    return out;
  }

  // Parameter names have changed across Empower builds; try the known spellings
  // rather than betting on one.
  const HISTORY_VARIANTS = [
    (ids, s, e) => ({
      startDate: s, endDate: e, intervalType: 'DAY',
      types: JSON.stringify(['balances']), userAccountIds: JSON.stringify(ids),
    }),
    (ids, s, e) => ({
      startDate: s, endDate: e, interval: 'DAY',
      types: JSON.stringify(['balances']), userAccountIds: JSON.stringify(ids),
    }),
    (ids, s, e) => ({
      startDate: s, endDate: e, intervalType: 'DAY',
      types: JSON.stringify(['balances']),
    }),
  ];

  let historyProbe = null;

  async function fetchSeries(days) {
    const ids = cashAccountIds();
    if (!ids.length) throw new Error('no cash or credit card accounts found');
    const s0 = ymd(Date.now() - days * DAY_MS);
    const e0 = ymd(Date.now());

    const probes = [];
    let lastErr = null;
    for (let i = 0; i < HISTORY_VARIANTS.length; i++) {
      try {
        const json = await apiPost('/api/account/getHistories', HISTORY_VARIANTS[i](ids, s0, e0));
        const sp = (json && json.spData) || {};
        const s = seriesFrom(json, txns);
        probes.push({
          variant: i,
          spDataKeys: Object.keys(sp),
          rowCount: flattenHistory(sp).length,
          sample: JSON.stringify(flattenHistory(sp)[0] || null).slice(0, 200),
          raw: JSON.stringify(sp).slice(0, 500),
          points: s.length,
        });
        if (s.length) {
          historyProbe = probes;
          // Kept so the series can be rebuilt in place when its other two
          // inputs — the live balances and the transactions — arrive or move
          // on, without paying for the call again.
          historyJson = json;
          return s;
        }
      } catch (e) {
        lastErr = e;
        probes.push({ variant: i, error: String((e && e.message) || e) });
      }
    }
    historyProbe = probes;
    throw new Error(
      lastErr
        ? `history call failed: ${lastErr.message}`
        : 'history returned no balances — see historyProbe in Diagnose'
    );
  }

  async function fetchTransactions(days) {
    const ids = cashAccountIds();
    if (!ids.length) throw new Error('no cash or credit card accounts found');
    const from = ymd(Date.now() - days * DAY_MS);
    const json = await apiPost('/api/transaction/getUserTransactions', {
      startDate: from,
      endDate: ymd(Date.now()),
      userAccountIds: JSON.stringify(ids),
    });
    const rows = (json && json.spData && json.spData.transactions) || [];
    const typeById = accountTypeById();
    const out = rows
      .map((t) => {
        const amt = Number(t.amount);
        const acctId = String(t.userAccountId ?? t.accountId ?? t.accountName ?? '');
        return {
          date: t.transactionDate || t.date || '',
          day: dayKey(t.transactionDate || t.date || ''),
          desc: t.description || t.originalDescription || t.merchant || '',
          account: t.accountName || '',
          acctId,
          type: typeById.get(acctId) || '',
          // Empower reports a positive amount plus a direction flag; fall back
          // to an already-signed amount when the flag is absent.
          amount:
            t.isCredit === undefined
              ? amt
              : t.isCredit
                ? Math.abs(amt)
                : -Math.abs(amt),
        };
      })
      .filter((t) => t.date && isFinite(t.amount))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    // The window asked for, so the series knows how far back the *absence* of
    // a transaction is evidence of anything.
    out.from = from;
    markPairs(out);
    return out;
  }

  // How far apart the two legs of one movement may be dated. A card payment
  // posts to the bank and the card on different days.
  const PAIR_DAYS = 5;

  // Find movements we can see both sides of: money leaving one account and the
  // same amount arriving in another — a card payment, a transfer between
  // accounts. They net to zero, so as a record of what was actually spent they
  // are noise, and double-count the amount while they're at it.
  //
  // Matched on equal magnitude, opposite sign, different accounts, close dates
  // and the right pair of account types. Deliberately not matched on
  // description: the two legs are worded by two different institutions and
  // rarely agree.
  //
  // The type test is what stops amount alone from lying. A $500 card purchase
  // and a $500 deposit three days apart are equal, opposite and in different
  // accounts, but they are not two halves of anything — and without this both
  // would vanish. A real movement leaves a bank; it lands on a card (a payment)
  // or in another bank (a transfer). Money out of a *card* is a purchase, and
  // can never be a leg.
  function isTransferShape(out, ins) {
    // Some builds don't give transactions an id we can resolve to an account,
    // in which case type is unknowable and amount matching is all there is.
    if (!out.type || !ins.type) return true;
    if (out.type !== 'BANK') return false;
    return ins.type === 'CREDIT_CARD' || ins.type === 'BANK';
  }

  function markPairs(rows) {
    const groups = new Map();
    for (const t of rows) {
      t.paired = false;
      const key = Math.round(Math.abs(t.amount) * 100);
      if (!key) continue; // a zero-amount row pairs with everything
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const ins = g.filter((t) => t.amount > 0);
      for (const out of g) {
        if (out.amount >= 0) continue;
        const mate = ins.find(
          (i) =>
            !i.paired &&
            i.acctId !== out.acctId &&
            isTransferShape(out, i) &&
            Math.abs(Date.parse(i.date) - Date.parse(out.date)) <= PAIR_DAYS * DAY_MS
        );
        if (mate) {
          mate.paired = true;
          out.paired = true;
        }
      }
    }
  }

  function group(accounts) {
    rawAccounts = accounts;
    const totals = {
      BANK: 0,
      CREDIT_CARD: 0,
      INVESTMENT: 0,
      LOAN: 0,
      MORTGAGE: 0,
      OTHER_ASSETS: 0,
    };
    const rows = {};
    for (const a of accounts) {
      if (!isLive(a)) continue;
      const t = a.productType || 'OTHER_ASSETS';
      const v = normalise(a);
      totals[t] = (totals[t] || 0) + v;
      (rows[t] = rows[t] || []).push({
        name: a.name || a.originalName || '(unnamed)',
        firm: a.firmName || '',
        value: v,
      });
    }
    return { totals, rows };
  }

  // ===========================================================================
  // Hiding Empower's own Overview cards
  //
  // Matching on heading text rather than CSS selectors: Empower's markup is
  // generated and its class names change between builds, but the words on the
  // card stay put. Every sweep re-matches from scratch, so cards stay hidden
  // through the SPA's re-renders.
  // ===========================================================================

  const HIDE_KEY = 'ecd-hidden-tiles-v1';
  // "block" and "container" appear on generic layout wrappers (including the
  // sidebar column), so they are not evidence of a card. "widget" is — Empower
  // names its real cards dashboard__item--*-widget.
  const CARDISH = /card|tile|widget|panel|module/i;
  const PROTECTED = new Set(['HTML', 'BODY', 'MAIN']);

  let hidingPaused = false;

  function loadHidden() {
    try {
      const v = JSON.parse(localStorage.getItem(HIDE_KEY));
      return Array.isArray(v) ? v : [];
    } catch (_) {
      return [];
    }
  }

  function saveHidden(list) {
    try {
      localStorage.setItem(HIDE_KEY, JSON.stringify(list));
    } catch (_) {}
  }

  function phrases() {
    return [...HIDE_TILES, ...loadHidden()];
  }

  // Hard stop: our own UI, page chrome, or anything so large that hiding it
  // would blank the page. Reaching one of these ends the climb.
  function isForbidden(el) {
    if (!el || !el.tagName || PROTECTED.has(el.tagName)) return true;
    if (el.id === 'ecd-panel' || el.id === 'ecd-fab') return true;
    if (el.closest && el.closest('#ecd-panel, #ecd-fab')) return true;
    const r = el.getBoundingClientRect();
    if (r.height > innerHeight * 0.85 && r.width > innerWidth * 0.85) return true;
    return false;
  }

  function isCardSized(el) {
    const r = el.getBoundingClientRect();
    return r.width >= 200 && r.height >= 60;
  }

  // Climb from a title's element to the card that contains it. Small wrapper
  // divs sit between the two, so being too small is a reason to keep climbing,
  // never a reason to stop — stopping there was why nothing got hidden.
  function cardFor(el) {
    let best = null;
    let fallback = null;
    let node = el;
    for (let i = 0; i < 10 && node && node.parentElement; i++) {
      node = node.parentElement;
      if (isForbidden(node)) break;
      if (!isCardSized(node)) continue;

      // First ancestor big enough to be the card body: hides the whole block
      // even when nothing in the chain looks card-like.
      if (!fallback) fallback = node;

      const cls = typeof node.className === 'string' ? node.className : '';
      let styled;
      try {
        styled = getComputedStyle(node);
      } catch (_) {
        continue;
      }
      const looksLikeCard =
        CARDISH.test(cls) ||
        (styled.boxShadow && styled.boxShadow !== 'none') ||
        parseFloat(styled.borderRadius) > 2 ||
        node.tagName === 'SECTION' ||
        node.tagName === 'ARTICLE';
      if (looksLikeCard) best = node;
    }
    return best || fallback || null;
  }

  function hideCard(el) {
    if (!el || el.dataset.ecdHidden) return false;
    el.dataset.ecdHidden = '1';
    el.style.setProperty('display', 'none', 'important');
    return true;
  }

  const SKIP_INSIDE =
    'nav, header, #ecd-panel, #ecd-fab, #ecd-card, #ecd-detail, [data-ecd-hidden]';

  // Walk raw text nodes rather than querying headings. Empower's card titles
  // are not <h*> elements and carry no predictable class, so anchoring to
  // markup finds nothing; the words on screen are the one stable handle.
  function* textNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) yield n;
  }

  function tidy(s) {
    return (s || '').trim().replace(/\s+/g, ' ');
  }

  function applyHidden() {
    if (hidingPaused || !document.body) return;
    const want = phrases().map((p) => String(p).toLowerCase()).filter(Boolean);
    if (!want.length) return;

    const hits = [];
    for (const node of textNodes(document.body)) {
      const text = tidy(node.textContent);
      // Card titles are short. Long runs are body copy and would over-match.
      if (text.length < 3 || text.length > 60) continue;
      const lower = text.toLowerCase();
      if (!want.some((p) => lower.includes(p))) continue;
      const el = node.parentElement;
      if (!el || (el.closest && el.closest(SKIP_INSIDE))) continue;
      hits.push(el);
    }
    for (const el of hits) hideCard(cardFor(el));
  }

  function unhideAll() {
    hidingPaused = true;
    saveHidden([]);
    for (const el of document.querySelectorAll('[data-ecd-hidden]')) {
      el.style.removeProperty('display');
      delete el.dataset.ecdHidden;
    }
  }

  // Must return something `applyHidden` can find again: a single short text
  // node from inside the card, not a slice of its concatenated text.
  function phraseFor(card) {
    for (const node of textNodes(card)) {
      const t = tidy(node.textContent);
      if (t.length >= 3 && t.length <= 60) return t;
    }
    return '';
  }

  // Click-to-hide mode, for cards whose wording isn't worth hardcoding.
  function startPicker() {
    let current = null;

    const banner = document.createElement('div');
    banner.id = 'ecd-pick-banner';
    banner.textContent = 'Click a card to hide it — Esc to finish';
    document.body.appendChild(banner);

    const clear = () => {
      if (current) current.classList.remove('ecd-pick-hover');
      current = null;
    };

    const onMove = (e) => {
      const card = cardFor(e.target);
      if (card === current) return;
      clear();
      if (card) {
        current = card;
        current.classList.add('ecd-pick-hover');
      }
    };

    const onClick = (e) => {
      if (!current) return;
      e.preventDefault();
      e.stopPropagation();
      const p = phraseFor(current);
      if (p) saveHidden([...new Set([...loadHidden(), p])]);
      const target = current;
      clear();
      hideCard(target);
      hidingPaused = false;
      if (panel) load();
    };

    const onKey = (e) => {
      if (e.key === 'Escape') stop();
    };

    function stop() {
      clear();
      banner.remove();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (panel) panel.style.display = '';
      else addFab();
    }

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    // Get the panel out of the way while picking.
    if (panel) panel.style.display = 'none';
  }

  // ===========================================================================
  // A card injected into Empower's own Overview grid
  //
  // Located the same way cards are hidden: match the words on screen, climb to
  // the surrounding card. We then reuse that card's own class list, so ours
  // inherits Empower's background, radius, shadow and grid sizing without
  // knowing anything about their design system.
  // ===========================================================================

  const CARD_ID = 'ecd-card';
  // Sentence case, because that is how Empower writes "Net worth" — the tile
  // sits directly under theirs and reads as a mismatch otherwise.
  const CARD_TITLE = 'Net cash';

  // Where to slot the card, tried in order until one anchor is found. The
  // words are matched against Empower's own card titles.
  // Whose typography the tile copies.
  const CARD_ANCHOR_STYLE = 'Net Worth';

  const CARD_PLACEMENT = [
    { text: 'Performance', where: 'before' }, // middle column, under the graph
    { text: 'Net Worth', where: 'after' }, // fallback: just below Net Worth
  ];

  function findCardsByText(phrase) {
    const want = phrase.toLowerCase();
    const out = [];
    const seen = new Set();
    for (const node of textNodes(document.body)) {
      const t = tidy(node.textContent);
      if (t.length < 3 || t.length > 60) continue;
      const lower = t.toLowerCase();
      if (!lower.includes(want)) continue;
      const el = node.parentElement;
      if (!el || (el.closest && el.closest(SKIP_INSIDE))) continue;
      const card = cardFor(el);
      if (!card || seen.has(card)) continue;
      seen.add(card);
      out.push({ card, exact: lower === want });
    }
    return out;
  }

  // The same words appear in the sidebar and in the main column's card. Area
  // alone gets this wrong — a full-height sidebar column (279×2986) outweighs
  // a real card (770×265). Score on what actually distinguishes a card: card-ish
  // naming, main-column width, and a height that fits on screen.
  function cardScore(el) {
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === 'string' ? el.className : '';
    let s = 0;
    if (CARDISH.test(cls)) s += 100;
    if (r.width >= 400) s += 50; // main column, not a sidebar rail
    if (r.height <= innerHeight * 1.2) s += 25; // a card, not a whole column
    return s + Math.min(20, r.width / 100);
  }

  function bestCard(phrase) {
    const cands = findCardsByText(phrase);
    if (!cands.length) return null;
    cands.sort((a, b) => b.exact - a.exact || cardScore(b.card) - cardScore(a.card));
    return cands[0].card;
  }

  // Empower's cards may be light or dark regardless of the OS theme, so read
  // the actual background rather than trusting prefers-color-scheme.
  // Cards are often transparent over a coloured ancestor, and a transparent
  // background parses as rgb(0,0,0) — reading it naively calls a white page
  // dark. Climb to the first background that is actually painted.
  function opaqueBg(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      let bg = '';
      try {
        bg = getComputedStyle(node).backgroundColor || '';
      } catch (_) {}
      const m = bg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i);
      if (m && (m[4] === undefined || parseFloat(m[4]) > 0.1)) {
        return [+m[1], +m[2], +m[3]];
      }
      node = node.parentElement;
    }
    return null;
  }

  function accentFor(el) {
    const dark = { pos: '#48d18b', neg: '#ff7b6b' };
    const light = { pos: '#127a45', neg: '#c0392b' };
    const rgb = opaqueBg(el);
    if (!rgb) return light;
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return lum < 0.5 ? dark : light;
  }

  // The dashboard's own accounts request usually lands after we first render,
  // so adopt the snooped payload as soon as it appears rather than waiting on
  // the network retry.
  function syncFromCache() {
    if (lastData || !cached) return;
    lastData = group(cached.accounts);
    lastData.source = 'live';
    lastData.at = cached.at;
  }

  // ---------------------------------------------------------------------------
  // Charts. One series, so no legend — the card title names it. Thin 2px line,
  // recessive axes, a direct label on the final point rather than every point.
  // ---------------------------------------------------------------------------

  function scale(series, w, h, pad) {
    const vals = series.map((p) => p.value);
    // Scale to the data so the series uses the full height. Zero is not forced
    // into the domain — it is only the *fill* baseline (see zeroBaseline), so a
    // series far from zero still fills the plot instead of hugging the top.
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const span = max - min;
    min -= span * 0.1;
    max += span * 0.1;
    const x = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
    return { x, y, min, max };
  }

  function linePath(series, s) {
    return series
      .map((p, i) => `${i ? 'L' : 'M'}${s.x(i).toFixed(1)},${s.y(p.value).toFixed(1)}`)
      .join(' ');
  }

  let clipSeq = 0;

  // The fill hangs from the line down to zero. When zero sits outside the
  // visible range the baseline clamps to the plot edge, so an all-positive
  // series fills the whole plot rather than leaving a gap.
  function zeroBaseline(s, h, pad) {
    return Math.max(pad.t, Math.min(h - pad.b, s.y(0)));
  }

  // One area path, two clipped copies: green above the zero line, red below.
  function twoTone(series, s, w, h, pad, pair) {
    const top = pad.t;
    const bottom = h - pad.b;
    const zeroY = zeroBaseline(s, h, pad);
    const d = linePath(series, s);
    const area =
      `${d} L${s.x(series.length - 1).toFixed(1)},${zeroY.toFixed(1)} ` +
      `L${s.x(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

    const n = ++clipSeq;
    const up = `ecd-up-${n}`;
    const dn = `ecd-dn-${n}`;
    const stroke =
      'stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ' +
      'vector-effect="non-scaling-stroke" fill="none"';

    return {
      zeroY,
      svg:
        `<defs>` +
        `<clipPath id="${up}"><rect x="0" y="${top}" width="${w}" ` +
        `height="${Math.max(0, zeroY - top).toFixed(1)}"/></clipPath>` +
        `<clipPath id="${dn}"><rect x="0" y="${zeroY.toFixed(1)}" width="${w}" ` +
        `height="${Math.max(0, bottom - zeroY).toFixed(1)}"/></clipPath>` +
        `</defs>` +
        `<path d="${area}" fill="${pair.pos}" opacity=".85" clip-path="url(#${up})"/>` +
        `<path d="${area}" fill="${pair.neg}" opacity=".85" clip-path="url(#${dn})"/>` +
        `<path d="${d}" stroke="${pair.pos}" ${stroke} clip-path="url(#${up})"/>` +
        `<path d="${d}" stroke="${pair.neg}" ${stroke} clip-path="url(#${dn})"/>`,
    };
  }

  // Floor and ceiling for the tile graph. The actual height is measured from
  // the card at paint time — see sparkHeight — so the graph fills whatever
  // room the card leaves rather than sitting at a guessed size.
  const SPARK_MIN_HEIGHT = 140;
  const SPARK_MAX_HEIGHT = 420;

  function sparkSvg(series, pair, h) {
    const w = 320;
    const pad = { l: 1, r: 1, t: 6, b: 2 };
    const s = scale(series, w, h, pad);
    const t = twoTone(series, s, w, h, pad, pair);
    const last = series[series.length - 1];
    return (
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" ` +
      `style="width:100%;height:${h}px;display:block;overflow:visible" ` +
      `aria-hidden="true">` +
      t.svg +
      `<circle cx="${s.x(series.length - 1).toFixed(1)}" cy="${s.y(last.value).toFixed(1)}" ` +
      `r="3" fill="${last.value < 0 ? pair.neg : pair.pos}" vector-effect="non-scaling-stroke"/>` +
      `</svg>`
    );
  }

  // Value labels sit in a left gutter, outside the filled area, so a solid
  // fill can't swallow them.
  const CHART_PAD = { l: 66, r: 10, t: 14, b: 26 };

  function chartSvg(series, pair, ink) {
    const w = 720;
    const h = 260;
    const pad = CHART_PAD;
    const s = scale(series, w, h, pad);
    const t = twoTone(series, s, w, h, pad, pair);

    // Gridlines across the visible range, labels in the gutter.
    let grid = '';
    for (let i = 0; i <= 2; i++) {
      const v = s.min + ((s.max - s.min) * i) / 2;
      const y = s.y(v).toFixed(1);
      grid +=
        `<line x1="${pad.l}" x2="${w - pad.r}" y1="${y}" y2="${y}" ` +
        `stroke="${ink}" stroke-width="1" opacity=".12"/>` +
        `<text x="${pad.l - 8}" y="${(+y + 4).toFixed(1)}" fill="${ink}" ` +
        `opacity=".5" font-size="11" text-anchor="end">${money(v)}</text>`;
    }

    // A distinct zero rule, drawn only when zero is actually in view.
    if (s.min < 0 && s.max > 0) {
      grid +=
        `<line x1="${pad.l}" x2="${w - pad.r}" y1="${t.zeroY.toFixed(1)}" ` +
        `y2="${t.zeroY.toFixed(1)}" stroke="${ink}" stroke-width="1" opacity=".45"/>`;
    }

    const first = series[0];
    const last = series[series.length - 1];
    const labels =
      `<text x="${pad.l}" y="${h - 8}" fill="${ink}" opacity=".5" font-size="11">${first.date}</text>` +
      `<text x="${w - pad.r}" y="${h - 8}" fill="${ink}" opacity=".5" font-size="11" ` +
      `text-anchor="end">${last.date}</text>`;

    return (
      `<svg class="ecd-chart-svg" viewBox="0 0 ${w} ${h}" ` +
      `style="width:100%;height:auto;display:block" role="img" ` +
      `aria-label="Net cash over time">` +
      grid +
      t.svg +
      `<rect class="ecd-sel" y="${pad.t}" height="${(h - pad.t - pad.b).toFixed(1)}" ` +
      `fill="${ink}" opacity="0" pointer-events="none"/>` +
      `<circle class="ecd-cursor" r="4" fill="${pair.pos}" stroke="#fff" stroke-width="2" ` +
      `opacity="0"/>` +
      `<line class="ecd-cross" y1="${pad.t}" y2="${h - pad.b}" stroke="${ink}" ` +
      `stroke-width="1" opacity="0"/>` +
      labels +
      `</svg>`
    );
  }

  // Crosshair + tooltip, and the chart doubles as the date filter: click a day,
  // or drag across a span. An SVG chart on a page is interactive by default.
  function attachHover(wrap, series, pair) {
    const svg = wrap.querySelector('.ecd-chart-svg');
    const tip = wrap.querySelector('.ecd-tip');
    if (!svg || !tip) return;
    const cursor = svg.querySelector('.ecd-cursor');
    const cross = svg.querySelector('.ecd-cross');
    const band = svg.querySelector('.ecd-sel');
    const s = scale(series, 720, 260, CHART_PAD);
    const plotW = 720 - CHART_PAD.l - CHART_PAD.r;

    const indexAt = (clientX) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return null;
      const rel = ((clientX - r.left) / r.width) * 720;
      const i = Math.round(((rel - CHART_PAD.l) / plotW) * Math.max(1, series.length - 1));
      return Math.max(0, Math.min(series.length - 1, i));
    };

    // Painted from indices while dragging, and from the committed dates
    // afterwards, so a redraw of the chart restores the band.
    const paintBand = (a, b) => {
      if (!band) return;
      if (a === null || b === null) {
        band.setAttribute('opacity', '0');
        return;
      }
      const x0 = s.x(Math.min(a, b));
      const x1 = s.x(Math.max(a, b));
      // A single day has no width of its own; give it a couple of pixels so
      // the selection is visible at all.
      const w = Math.max(2.5, x1 - x0);
      band.setAttribute('x', (x1 - x0 < 2.5 ? x0 - 1.25 : x0).toFixed(1));
      band.setAttribute('width', w.toFixed(1));
      band.setAttribute('opacity', '.16');
    };

    const paintCommitted = () => {
      if (!selFrom) return paintBand(null, null);
      paintBand(indexOfDay(series, selFrom), indexOfDay(series, selTo));
    };
    paintCommitted();
    repaintSelection = paintCommitted;

    let dragFrom = null;
    let dragTo = null;

    const commit = () => {
      if (dragFrom === null) return;
      const a = series[Math.min(dragFrom, dragTo)];
      const b = series[Math.max(dragFrom, dragTo)];
      dragFrom = dragTo = null;
      const from = dayKey(a.date);
      const to = dayKey(b.date);
      // Clicking the selected day again clears it — otherwise a one-day
      // selection is a filter you can set but not unset from the chart.
      if (selFrom === from && selTo === to) selectDays(null, null);
      else selectDays(from, to);
      paintCommitted();
    };

    svg.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // otherwise the drag selects the page's text
      dragFrom = dragTo = indexAt(e.clientX);
      paintBand(dragFrom, dragTo);
    });
    svg.addEventListener('mouseup', commit);
    svg.addEventListener('mousemove', (e) => {
      const i = indexAt(e.clientX);
      if (i === null) return;
      if (dragFrom !== null) {
        dragTo = i;
        paintBand(dragFrom, dragTo);
      }
      const p = series[i];
      const c = p.value < 0 ? pair.neg : pair.pos;
      cursor.setAttribute('cx', s.x(i).toFixed(1));
      cursor.setAttribute('cy', s.y(p.value).toFixed(1));
      cursor.setAttribute('fill', c);
      cursor.setAttribute('opacity', '1');
      cross.setAttribute('x1', s.x(i).toFixed(1));
      cross.setAttribute('x2', s.x(i).toFixed(1));
      cross.setAttribute('opacity', '.25');
      tip.innerHTML =
        `<span class="ecd-tip-d">${p.date}</span>` +
        `<span class="ecd-tip-v" style="color:${c}">${money(p.value)}</span>`;
      tip.style.opacity = '1';
      const rw = svg.getBoundingClientRect().width || 1;
      tip.style.left = Math.min(rw - 120, Math.max(0, (s.x(i) / 720) * rw - 60)) + 'px';
    });
    svg.addEventListener('mouseleave', () => {
      // Dragging off the edge commits what was covered, rather than dropping
      // the selection on the floor.
      commit();
      cursor.setAttribute('opacity', '0');
      cross.setAttribute('opacity', '0');
      tip.style.opacity = '0';
    });
  }

  // Lift the typography off Empower's own Net Worth card: find its title and
  // its currency figure, and reuse their classes on ours. Matching their
  // utility classes beats guessing font sizes, and it tracks their restyles.
  let styleRefs = null;

  function findStyleRefs() {
    if (styleRefs) return styleRefs;
    const nw = bestCard(CARD_ANCHOR_STYLE);
    if (!nw) return null;
    // The text usually sits in a bare <span>; the styling lives a level or two
    // up, so climb to the nearest ancestor that actually carries classes.
    const classed = (el) => {
      let n = el;
      for (let i = 0; i < 4 && n && n !== nw; i++) {
        const c = typeof n.className === 'string' ? n.className.trim() : '';
        if (c) return c;
        n = n.parentElement;
      }
      return '';
    };

    // Only the title. Their figure class is the card's hero number — sized to
    // dominate the tile, which is far too large for a corner figure.
    let title = '';
    let titleCss = null;
    for (const node of textNodes(nw)) {
      const t = tidy(node.textContent);
      if (!t) continue;
      if (t.toLowerCase() === CARD_ANCHOR_STYLE.toLowerCase()) {
        title = classed(node.parentElement);
        titleCss = typeSnapshot(node.parentElement);
        if (title) break;
      }
    }
    if (!title) return null;
    styleRefs = { title, titleCss };
    console.info('[Empower My Numbers] adopted card typography from Net Worth');
    return styleRefs;
  }

  // The class list alone isn't enough: lifted out of their card, a utility
  // class can land in a different cascade and render nothing like the original
  // — which is how "Net worth" became an uppercase "NET CASH". Copy what the
  // element actually computes to, and set it inline where nothing outranks it.
  const TYPE_PROPS = [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'color',
  ];

  function typeSnapshot(el) {
    try {
      const cs = getComputedStyle(el);
      const out = {};
      for (const p of TYPE_PROPS) out[p] = cs[p];
      return out;
    } catch (_) {
      return null;
    }
  }

  function applyStyleRefs(card) {
    if (card.dataset.ecdStyled) return;
    const refs = findStyleRefs();
    if (!refs) return;
    const title = card.querySelector('.ecd-c-title');
    if (title) {
      if (refs.title) title.className = 'ecd-c-title ' + refs.title;
      if (refs.titleCss) for (const p of TYPE_PROPS) title.style[p] = refs.titleCss[p];
    }
    card.dataset.ecdStyled = '1';
  }

  // What moved between two points of the series, carrying enough of both ends
  // to say honestly what was compared.
  function changeAt(a, b) {
    if (!a || !b) return null;
    const from = dayKey(a.date);
    const to = dayKey(b.date);
    const span = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
    if (!from || !to || !isFinite(span) || span < 1) return null;
    return { delta: b.value - a.value, days: span, from, to, a, b };
  }

  // The figure bottom-left is the whole graph: first point to last. Not a fixed
  // 90-day window — the graph draws SPARK_DAYS of history, so a 90-day figure
  // under a 180-day picture is a number you cannot check against what you are
  // looking at, and the two won't agree because they aren't measuring the same
  // thing. The label reports the span actually covered, so a short history
  // reads "60-day" rather than claiming a window it hasn't got.
  function chartChange() {
    if (!series || series.length < 2) return null;
    return changeAt(series[0], series[series.length - 1]);
  }

  // The most recent step in the series. With the series filled in from dated
  // transactions this is usually literally yesterday to today; where a gap
  // wouldn't reconcile it is further back, and changeAt() says so.
  function lastChange() {
    if (!series || series.length < 2) return null;
    return changeAt(series[series.length - 2], series[series.length - 1]);
  }

  // The balance movement across the selection, measured as the transaction list
  // reads the selection: both ends inclusive. So it runs from the point
  // *before* the first selected day — what happened on that day is part of what
  // was selected, and measuring from the day itself would leave it out.
  function selectedChange() {
    if (!selFrom || !series || series.length < 2) return null;
    const i = indexOfDay(series, selFrom);
    const j = indexOfDay(series, selTo);
    if (i === null || j === null) return null;
    const lo = Math.min(i, j) - 1;
    // Nothing before the first point to measure the first point against.
    if (lo < 0) return null;
    return changeAt(series[lo], series[Math.max(i, j)]);
  }

  // What the listed transactions come to over a span of days.
  //
  // Netting is unaffected by the "− net payments" toggle: a pair is equal and
  // opposite by definition, so removing both legs removes zero. The search box
  // doesn't apply either — that is a way of finding a row, not a redefinition
  // of what the days came to.
  function txnNet(from, to) {
    if (!txns) return null;
    let sum = 0;
    let n = 0;
    for (const t of txns) {
      if (!t.day || t.day < from || t.day > to) continue;
      sum += t.amount;
      n++;
    }
    return { sum, n };
  }

  function accountNames() {
    const m = new Map();
    for (const a of rawAccounts) {
      const id = String(a.userAccountId ?? a.accountId ?? a.id);
      m.set(id, a.name || a.originalName || a.firmName || '');
    }
    return m;
  }

  // Where a span's balance movement isn't accounted for by the transactions,
  // and on which account.
  //
  // Per account rather than as one lump, because the lump is a dead end: "$412
  // unexplained" tells you something is off and nothing else, where "$412
  // unexplained on Checking" tells you where to go and look. The two sides come
  // from different endpoints — balances from getHistories, movements from
  // getUserTransactions — and neither payload says why they disagree, so this
  // is the one figure in the view that can be measured but not derived.
  // Interest and fees are the usual answers; a charge that has hit the balance
  // but not yet posted as a row is the other.
  //
  // Measured from the point *before* the first day, so the first day's own
  // movement is inside the span — the same rule the change figure uses, so the
  // two agree.
  function reconcile(from, to) {
    if (!series || series.length < 2 || !txns || !from || !to) return [];
    const i = indexOfDay(series, from);
    const j = indexOfDay(series, to);
    if (i === null || j === null) return [];
    const lo = Math.min(i, j) - 1;
    if (lo < 0) return [];
    const opening = series[lo].parts;
    const closing = series[Math.max(i, j)].parts;
    if (!opening || !closing) return [];

    const net = new Map();
    for (const t of txns) {
      if (!t.day || t.day < from || t.day > to) continue;
      net.set(t.acctId, (net.get(t.acctId) || 0) + t.amount);
    }

    const names = accountNames();
    const openPt = series[lo];
    const closePt = series[Math.max(i, j)];
    const out = [];
    for (const [id, after] of closing) {
      // An account with no opening balance hasn't moved as far as we can tell.
      const moved = after - (opening.has(id) ? opening.get(id) : after);
      const diff = Math.round((moved - (net.get(id) || 0)) * 100) / 100;
      if (!diff) continue;
      // A balance carried across one or both ends of the span isn't a
      // statement about these days, so the difference measured against it is a
      // statement about *reporting*, not about money. Calling that "unexplained"
      // would be a confident accusation about an account that simply hasn't
      // spoken — and it points the wrong way twice over: the transactions look
      // unexplained while the account is quiet, then the whole silence lands as
      // one lump on the day it resumes. Same number either way; only the story
      // it tells is different, and the story is the reason for the row.
      const stale = openPt.held.has(id) || closePt.held.has(id);
      out.push({
        id,
        name: names.get(id) || 'an account',
        amount: diff,
        stale,
        since: stale ? lastReported(id, Math.max(i, j)) : '',
      });
    }
    // Biggest discrepancy first — that's the one worth chasing.
    return out.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }

  // The most recent day this account said anything, at or before `upto`.
  function lastReported(id, upto) {
    for (let k = upto; k >= 0; k--) {
      if (!series[k].held.has(id)) return dayKey(series[k].date);
    }
    return '';
  }

  // The days the transaction list is currently reconciled over: the selection
  // if there is one, otherwise the whole graph. Not the whole loaded list —
  // transactions dated before the series starts have no opening balance to be
  // measured against, so there is nothing to reconcile them to.
  function reconciledSpan() {
    if (!series || series.length < 2) return null;
    if (selFrom) return { from: selFrom, to: selTo };
    return {
      from: dayKey(series[1].date),
      to: dayKey(series[series.length - 1].date),
    };
  }

  // Why each end of a comparison is or isn't solid ground.
  function pointNotes(p) {
    const day = dayKey(p.date);
    const out = [];
    if (p.live) out.push(`${day} uses your live balances`);
    if (p.derived) {
      out.push(`${p.derived} of ${p.of} balances on ${day} worked out from dated transactions`);
    }
    const carried = (p.of || 0) - (p.fresh || 0) - (p.derived || 0);
    if (carried > 0) {
      out.push(
        `${carried} of ${p.of} accounts hadn't reported by ${day} and couldn't be ` +
          `reconciled from transactions — their last known balance is carried, so ` +
          `anything they did lands on the day they next report`
      );
    }
    return out;
  }

  function chartTitle(c) {
    return [`The whole graph — ${c.from}  ${money(c.a.value)}  →  ${c.to}  ${money(c.b.value)}`]
      .concat(pointNotes(c.a), pointNotes(c.b))
      .join('\n');
  }

  // The day figure is the transactions', so its tooltip reconciles it against
  // the balances. Where they disagree the difference is money that moved
  // without a transaction to show for it, and naming it is the point: it is
  // the one number here that no amount of care in this file can derive.
  function spanTitle(bal, net, from, to) {
    const when = from === to ? `on ${from}` : `from ${from} to ${to}`;
    const bits = [];
    if (net) {
      bits.push(`${net.n} transaction${net.n === 1 ? '' : 's'} ${when}, netting ${signed(net.sum)}`);
      const drift = Math.round((bal.delta - net.sum) * 100) / 100;
      if (drift) {
        bits.push(
          `The balances moved ${signed(bal.delta)} over the same days. The ${signed(drift)} ` +
            `difference isn't in the transaction list — interest, a fee, or a charge ` +
            `that hasn't posted yet`
        );
      }
    } else {
      bits.push(`Balance movement ${when} — transactions not loaded`);
    }
    bits.push(`${bal.from}  ${money(bal.a.value)}  →  ${bal.to}  ${money(bal.b.value)}`);
    return bits.concat(pointNotes(bal.a), pointNotes(bal.b)).join('\n');
  }

  function chgHtml(label, delta, title, accent) {
    if (delta === null || delta === undefined || !isFinite(delta)) return '<span></span>';
    return (
      `<span class="ecd-chg" title="${escapeHtml(title)}">` +
      `<span class="ecd-chg-l">${escapeHtml(label)}</span> ` +
      `<span class="ecd-chg-v" style="color:${delta < 0 ? accent.neg : accent.pos}">` +
      `${signed(delta)}</span></span>`
    );
  }

  // Empower prints a long-window change bottom-left of the graph and a daily
  // one bottom-right; ours sits in the same corners and answers two different
  // questions, each checkable against something on the screen.
  //
  // Left is the graph itself, end to end — read the first and last points off
  // the picture and this is their difference.
  //
  // Right is what the *transactions* came to: for the last day by default, or
  // for whatever is selected on the chart. That makes it the total of the rows
  // listed underneath it in the detail view, which is the other thing on screen
  // it could be checked against — and a change that doesn't match the list it
  // sits above is a number you have to take on trust. Where the balances moved
  // by something else, the tooltip says by how much and why that happens.
  function changeHtml(accent) {
    const chart = chartChange();
    const bal = selFrom ? selectedChange() : lastChange();
    let out = chart ? chgHtml(`${chart.days}-day`, chart.delta, chartTitle(chart), accent) : '<span></span>';
    if (!bal) return out + '<span></span>';

    // The days whose transactions account for this change: the selection as the
    // list reads it, or everything after the previous point up to the last.
    const from = selFrom || shiftDay(bal.from, 1);
    const to = selFrom ? selTo : bal.to;
    const net = txnNet(from, to);
    const label = selFrom
      ? selFrom === selTo
        ? selFrom
        : `${selFrom} → ${selTo}`
      : `${bal.days}-day`;

    return out + chgHtml(label, net ? net.sum : bal.delta, spanTitle(bal, net, from, to), accent);
  }

  // Cash over cards, stacked with the figures in their own right-aligned
  // column. The whole point of the pair is eyeballing the gap between the two
  // numbers, which a single run-on line leaves you to do in your head.
  function subHtml(t) {
    if (!t) return '';
    return (
      `<span class="ecd-sub-l">Cash</span>` +
      `<span class="ecd-sub-n">${money(t.BANK)}</span>` +
      `<span class="ecd-sub-l">Cards</span>` +
      `<span class="ecd-sub-n">−${money(t.CREDIT_CARD)}</span>`
    );
  }

  function paintCard(card) {
    applyStyleRefs(card);
    const val = card.querySelector('.ecd-c-val');
    const sub = card.querySelector('.ecd-c-sub');
    if (!val || !sub) return;
    syncFromCache();
    if (!lastData) {
      val.textContent = '—';
      sub.innerHTML = '';
      return;
    }
    const t = lastData.totals;
    const net = t.BANK - t.CREDIT_CARD;
    const accent = accentFor(card);
    val.textContent = money(net);
    val.style.color = net < 0 ? accent.neg : accent.pos;
    sub.innerHTML = subHtml(t);

    const foot = card.querySelector('.ecd-c-foot');
    if (foot) foot.innerHTML = series && series.length > 1 ? changeHtml(accent) : '';

    const spark = card.querySelector('.ecd-c-spark');
    if (spark) {
      if (series && series.length > 1) {
        const h = sparkHeight(card, spark);
        // paintCard runs on every sweep; only redraw when something actually
        // changed, otherwise the graph flickers a few times a second.
        const key = `${seriesRev}:${h}:${net < 0}`;
        if (spark.dataset.ecdKey !== key) {
          spark.dataset.ecdKey = key;
          spark.style.height = h + 'px';
          spark.innerHTML = sparkSvg(series, accent, h);
        }
      } else if (seriesError) {
        spark.innerHTML = '';
        delete spark.dataset.ecdKey;
      }
    }
    ensureSeries();
    loadTransactions();
  }

  // How much vertical room the card has left once the header and breakdown
  // have taken theirs. When the card sizes to its content this settles at the
  // current height rather than growing without bound.
  function sparkHeight(card, wrap) {
    const cardH = card.clientHeight || 0;
    if (!cardH) return SPARK_MIN_HEIGHT;
    let used = 0;
    try {
      const cs = getComputedStyle(card);
      used += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      for (const kid of card.children) {
        if (kid === wrap) continue;
        const ks = getComputedStyle(kid);
        used +=
          kid.offsetHeight +
          (parseFloat(ks.marginTop) || 0) +
          (parseFloat(ks.marginBottom) || 0);
      }
      const ws = getComputedStyle(wrap);
      used += (parseFloat(ws.marginTop) || 0) + (parseFloat(ws.marginBottom) || 0);
    } catch (_) {
      return SPARK_MIN_HEIGHT;
    }
    const avail = cardH - used - 2;
    return Math.max(SPARK_MIN_HEIGHT, Math.min(SPARK_MAX_HEIGHT, Math.round(avail)));
  }

  let series = null;
  let seriesError = null;
  let seriesTriedAt = 0;
  let historyJson = null;
  // Bumped on every rebuild. The sparkline redraws off this rather than off the
  // series' length: a rebuild can change values all through the series without
  // changing how many there are, and comparing lengths would leave the old
  // shape on screen.
  let seriesRev = 0;

  // The series has three inputs that arrive at different times — the history
  // call, the live balances, and the transactions. Rebuilding from whatever is
  // to hand keeps it one function's job to combine them, rather than a set of
  // patches applied to an already-built series in whatever order they land.
  function rebuildSeries() {
    if (!historyJson) return;
    const s = seriesFrom(historyJson, txns);
    if (!s.length) return;
    series = s;
    seriesRev++;
  }

  async function ensureSeries() {
    if (series || !rawAccounts.length) return;
    if (Date.now() - seriesTriedAt < 30000) return;
    seriesTriedAt = Date.now();
    try {
      series = await fetchSeries(SPARK_DAYS);
      seriesRev++;
      seriesError = null;
      const c = document.getElementById(CARD_ID);
      if (c) paintCard(c);
      if (detailEl && detailEl.isConnected) renderDetail();
    } catch (e) {
      seriesError = String((e && e.message) || e);
      console.info('[Empower My Numbers] history unavailable:', seriesError);
    }
  }

  let fetching = false;
  let lastTryAt = 0;
  let lastCardMissAt = 0;

  async function ensureData() {
    if (lastData || fetching || Date.now() - lastTryAt < 10000) return;
    fetching = true;
    lastTryAt = Date.now();
    try {
      const { accounts, source, at } = await fetchAccounts();
      lastData = group(accounts);
      lastData.source = source;
      lastData.at = at;
      // Balances are one of the series' inputs, so a fresh set of them is a
      // reason to rebuild it. Accounts normally arrive first, but a refresh
      // can land the other way round.
      rebuildSeries();
      const c = document.getElementById(CARD_ID);
      if (c) paintCard(c);
    } catch (_) {
      // Leave the placeholder; the next sweep retries.
    } finally {
      fetching = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Detail view. Empower's own tiles expand into the main column and leave the
  // sidebar in place, so this does the same: hide the column's other cards,
  // append our detail, restore them on Back. Cards we deliberately hid stay
  // hidden — they are excluded from the stash rather than blanket-restored.
  // ---------------------------------------------------------------------------

  const SPARK_DAYS = 180;

  // Tied to the graph's window on purpose: the graph selects into this list,
  // so a shorter transaction window means dragging over the older half of the
  // chart silently finds nothing. Whatever you can point at, you can read.
  const TXN_DAYS = SPARK_DAYS;

  let detailEl = null;
  let txns = null;
  let txnError = null;
  let txnQuery = '';
  let hidePaired = false;
  let onKeys = null;
  // Day filter driven by the chart, as YYYY-MM-DD. Equal from/to is one day.
  let selFrom = null;
  let selTo = null;
  let repaintSelection = null;

  function selectDays(from, to) {
    selFrom = from;
    selTo = to;
    refreshRows();
    refreshChange();
  }

  function clearSelection() {
    selectDays(null, null);
    if (repaintSelection) repaintSelection();
  }

  // Parsed and formatted in UTC throughout, so stepping a day never lands on
  // 23:00 the same day when the clocks change.
  const shiftDay = (day, delta) => ymd(Date.parse(day) + delta * DAY_MS);

  // Arrow keys walk the selection along the chart. Steps by calendar day
  // rather than by series index: the series can have gaps, and stepping by
  // index would skip the days inside them — days that have transactions.
  function moveSelection(delta, extend) {
    if (!series || !series.length) return;
    const first = dayKey(series[0].date);
    const last = dayKey(series[series.length - 1].date);
    const clamp = (d) => (d < first ? first : d > last ? last : d);

    if (!selFrom) {
      // Nothing selected yet: the first press anchors on the most recent day,
      // and presses after that move it.
      selFrom = selTo = last;
    } else if (extend) {
      const to = clamp(shiftDay(selTo, delta));
      selTo = to < selFrom ? selFrom : to;
    } else {
      const from = shiftDay(selFrom, delta);
      const to = shiftDay(selTo, delta);
      // Move only if both ends can move. Clamping one end alone would resize
      // the range instead of sliding it, which is not what was asked for.
      if (clamp(from) === from && clamp(to) === to) {
        selFrom = from;
        selTo = to;
      }
    }
    selectDays(selFrom, selTo);
    if (repaintSelection) repaintSelection();
  }

  function closeDetail() {
    if (onKeys) {
      document.removeEventListener('keydown', onKeys);
      onKeys = null;
    }
    if (detailEl) {
      detailEl.remove();
      detailEl = null;
    }
    for (const el of document.querySelectorAll('[data-ecd-iso]')) {
      el.style.removeProperty('display');
      delete el.dataset.ecdIso;
    }
    showFooters();
  }

  // Empower's footer is laid out against the sidebar's height rather than the
  // main column's, so a detail view taller than the sidebar runs underneath it
  // and the last transactions are covered. It lives outside the card's
  // ancestor chain, so isolate() never reaches it — match it by role instead.
  // Re-run every sweep, like isolate(), because the SPA re-inserts the footer
  // while the view is open.
  const FOOTER_SEL =
    'footer, [role="contentinfo"], [class*="footer" i], [id*="footer" i]';

  function hideFooters() {
    for (const el of document.querySelectorAll(FOOTER_SEL)) {
      if (el.dataset.ecdFooter) continue;
      if (el.closest('#ecd-panel, #ecd-fab, #ecd-card, #ecd-detail, nav, header')) continue;
      if (el.closest('[data-ecd-footer]')) continue; // inside one already hidden
      // Never hide something that contains the view we are clearing space for.
      if (el.contains(detailEl) || el.contains(document.getElementById(CARD_ID))) continue;
      // A "footer" that fills the screen is a layout wrapper, not a footer.
      const r = el.getBoundingClientRect();
      if (r.height > innerHeight * 0.85 && r.width > innerWidth * 0.85) continue;
      el.dataset.ecdFooter = '1';
      el.style.setProperty('display', 'none', 'important');
    }
  }

  function showFooters() {
    for (const el of document.querySelectorAll('[data-ecd-footer]')) {
      el.style.removeProperty('display');
      delete el.dataset.ecdFooter;
    }
  }

  // Clear the main content area down to just our detail, while leaving the
  // accounts sidebar and the site chrome alone. Hiding only our card's
  // siblings isn't enough: Empower nests tiles in cells and rows, so the
  // Net Worth graph can live in a different container entirely.
  //
  // Anchored on the detail element and re-run every sweep, because tiles like
  // Budgeting and Cash Flow mount *after* the view opens — hiding once at open
  // time leaves them to reappear on top of the transactions. Hidden elements
  // are marked rather than collected in a list, so a tile React re-created (a
  // different node, same slot) is caught on the next pass instead of being
  // remembered as something that was already dealt with.
  function isolate() {
    if (!detailEl || !detailEl.isConnected) return;
    let node = detailEl;
    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const pw = parent.getBoundingClientRect().width || 1;

      for (const sib of parent.children) {
        if (sib === node) continue;
        if (sib.dataset.ecdHidden) continue; // already hidden on purpose
        if (sib.style.display === 'none') continue; // includes ours from last pass
        if (sib.matches && sib.matches('nav, header')) continue;
        if (sib.querySelector && sib.querySelector('nav, header')) continue;

        // Keep a narrow, full-height rail — that's the accounts sidebar.
        const r = sib.getBoundingClientRect();
        if (r.width > 0 && r.width / pw < 0.45 && r.height > innerHeight * 0.8) continue;

        sib.dataset.ecdIso = '1';
        sib.style.setProperty('display', 'none', 'important');
      }
      node = parent;
    }
  }

  function openDetail() {
    const card = document.getElementById(CARD_ID);
    const col = card && card.parentElement;
    if (!col) return;
    closeDetail();

    detailEl = document.createElement('div');
    detailEl.id = 'ecd-detail';
    detailEl.className = card.className;
    col.appendChild(detailEl);

    // A search and a day selection are both about the question you had a
    // moment ago, so they start empty. The transfer filter is a way of reading
    // the list rather than a question, so it sticks.
    txnQuery = '';
    selFrom = selTo = null;
    repaintSelection = null;

    // With the Back button gone, Esc has to work — otherwise the only way out
    // of the view is a page reload. The search box swallows its own Esc first,
    // so clearing a search doesn't also close the view.
    onKeys = (e) => {
      if (e.key === 'Escape') return closeDetail();
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // Arrows belong to whatever you're typing in, if anything is.
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        return;
      }
      e.preventDefault();
      moveSelection(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    };
    document.addEventListener('keydown', onKeys);

    // The card is now just another sibling of the detail view, so isolate()
    // hides it along with everything else — and closing restores it the same way.
    isolate();
    hideFooters();
    renderDetail();
    loadTransactions();
  }

  // Loaded as soon as there are accounts to load them for, rather than waiting
  // for the detail view to open. The transaction dates are what let the series
  // put a movement on the day it happened instead of the day the account got
  // round to reporting it, so the card's own change figure needs them just as
  // much as the list does. Opening the view is then instant, which is the
  // agreeable half of paying for the call up front.
  let txnTriedAt = 0;

  async function loadTransactions() {
    if (txns || !rawAccounts.length) return;
    if (Date.now() - txnTriedAt < 30000) return;
    txnTriedAt = Date.now();
    try {
      txns = await fetchTransactions(TXN_DAYS);
      txnError = null;
      // The transactions are an input to the graph, not just to the list.
      rebuildSeries();
    } catch (e) {
      txnError = String((e && e.message) || e);
    }
    // Repainted either way: on failure the view has to stop saying "loading"
    // and start saying why.
    const c = document.getElementById(CARD_ID);
    if (c) paintCard(c);
    if (detailEl && detailEl.isConnected) renderDetail();
  }

  function visibleTxns() {
    if (!txns) return [];
    const q = txnQuery.trim().toLowerCase();
    return txns.filter((t) => {
      if (hidePaired && t.paired) return false;
      if (selFrom && (t.day < selFrom || t.day > selTo)) return false;
      if (!q) return true;
      return (t.desc + ' ' + t.account).toLowerCase().includes(q);
    });
  }

  function oldestLoadedDay() {
    let d = '';
    for (const t of txns || []) if (t.day && (!d || t.day < d)) d = t.day;
    return d;
  }

  function selectionLabel() {
    if (!selFrom) return '';
    return selFrom === selTo ? `on ${selFrom}` : `${selFrom} → ${selTo}`;
  }

  function txnRows() {
    if (txnError) {
      return `<div class="ecd-d-note">Transactions unavailable — ${escapeHtml(txnError)}</div>`;
    }
    if (!txns) return `<div class="ecd-d-note">Loading transactions…</div>`;
    if (!txns.length) {
      return `<div class="ecd-d-note">No transactions in the last ${TXN_DAYS} days.</div>`;
    }
    const shown = visibleTxns();
    const sel = selectionLabel();
    const clear = sel
      ? ` ${escapeHtml(sel)} · <button class="ecd-d-clear" type="button">clear</button>`
      : '';
    if (!shown.length) {
      // If the selection predates everything loaded, say so. "Nothing on that
      // day" and "that day isn't loaded" look identical on screen and mean
      // very different things — Empower can cap the window server-side.
      const oldest = oldestLoadedDay();
      const unloaded = sel && oldest && selTo < oldest ? ` — nothing is loaded before ${oldest}` : '';
      const why = txnQuery.trim()
        ? `no transaction mentions “${escapeHtml(txnQuery.trim())}”`
        : sel
          ? `nothing ${escapeHtml(sel)}${unloaded}`
          : 'every transaction is a transfer';
      // A day with no transactions whose balance moved anyway is precisely when
      // the reconciling rows earn their place: without them the view would say
      // "nothing happened" over a graph that visibly stepped.
      const recon = reconRows();
      return (
        `<div class="ecd-d-tally">0 of ${txns.length} transactions${clear}</div>` +
        `<div class="ecd-d-note">Nothing matches — ${why}.</div>` +
        (recon ? `<table class="ecd-d-table"><tbody>${recon}</tbody></table>` : '')
      );
    }
    // Every match is rendered — no cap. A cap needs a "showing the first N"
    // caveat to stay honest, and a 90-day list is a few hundred rows at worst.
    const rows = shown
      .map(
        (t) =>
          `<tr${
            t.paired
              ? ' class="ecd-d-pair" title="Both sides of this movement are in ' +
                'the list — together they net to zero"'
              : ''
          }><td class="ecd-d-date">${escapeHtml(t.date)}</td>` +
          `<td>${escapeHtml(t.desc)}</td>` +
          `<td class="ecd-d-acct">${escapeHtml(t.account)}</td>` +
          `<td class="ecd-d-amt ${t.amount < 0 ? 'ecd-d-out' : 'ecd-d-in'}">${signed(t.amount)}</td></tr>`
      )
      .join('');
    return (
      `<div class="ecd-d-tally">${shown.length} of ${txns.length} transactions${clear}</div>` +
      `<table class="ecd-d-table"><tbody>${rows}${reconRows()}</tbody></table>`
    );
  }

  // The balance movement the listed transactions don't account for, as rows at
  // the foot of the list — one per account, named. It belongs here rather than
  // in a tooltip: it is money that moved, the list is the record of money that
  // moved, and leaving it out is what made the totals disagree in the first
  // place. With these, the rows above plus the rows below come to what the
  // balances actually did.
  //
  // Not shown while a search is running. The visible rows are then a subset
  // chosen by a word, and the balance movement has nothing to do with that
  // word — a reconciling line under it would be arithmetic about two unrelated
  // things. The "− net payments" toggle is fine: a pair is equal and opposite,
  // so hiding both legs changes the total by zero.
  function reconRows() {
    if (txnQuery.trim()) return '';
    const span = reconciledSpan();
    if (!span) return '';
    const gaps = reconcile(span.from, span.to);
    if (!gaps.length) return '';
    const when = span.from === span.to ? `on ${span.from}` : `${span.from} → ${span.to}`;
    return gaps
      .map((g) => {
        // Two different things, and the difference is what you would do about
        // them. Unexplained money is a reason to go and look at a statement.
        // A balance that hasn't been reported is a reason to do nothing at all
        // and let it catch up.
        const what = g.stale
          ? `Not in the balance yet — ${g.name} last reported ${g.since || 'some time ago'}`
          : `Unexplained ${g.amount < 0 ? 'decrease' : 'increase'} — not in the transactions`;
        const title = g.stale
          ? `${g.name} has not reported a balance since ${g.since || 'before this span'}, ` +
            `so the graph doesn't show these days yet. Nothing is wrong; the figure is ` +
            `the amount by which the list runs ahead of the balance, and it will ` +
            `disappear when the account next syncs.`
          : `${g.name} moved ${signed(g.amount)} ${when} with no transaction to show ` +
            `for it. Interest or a fee, a charge that has hit the balance but not ` +
            `posted as a row yet, or a transaction Empower didn't return.`;
        return (
          `<tr class="ecd-d-recon${g.stale ? ' ecd-d-stale' : ''}" title="${escapeHtml(title)}">` +
          `<td class="ecd-d-date"></td>` +
          `<td>${escapeHtml(what)}</td>` +
          `<td class="ecd-d-acct">${escapeHtml(g.name)}</td>` +
          `<td class="ecd-d-amt ${g.amount < 0 ? 'ecd-d-out' : 'ecd-d-in'}">${signed(g.amount)}</td></tr>`
        );
      })
      .join('');
  }

  // Only the rows are rebuilt on a filter change. Re-rendering the whole view
  // would tear out the search box mid-keystroke and take the focus with it.
  function refreshRows() {
    if (!detailEl) return;
    const host = detailEl.querySelector('.ecd-d-rows');
    if (host) host.innerHTML = txnRows();
    const btn = detailEl.querySelector('.ecd-d-toggle');
    if (btn) {
      btn.textContent = toggleLabel();
      btn.setAttribute('aria-pressed', String(hidePaired));
      btn.classList.toggle('ecd-on', hidePaired);
    }
  }

  // The right-hand change figure tracks the selection, so it is repainted
  // alongside the rows — and only it. Re-rendering the view to move one number
  // would tear the search box out mid-keystroke and take the focus with it.
  function refreshChange() {
    if (!detailEl) return;
    const foot = detailEl.querySelector('.ecd-d-foot');
    if (!foot) return;
    foot.innerHTML = series && series.length > 1 ? changeHtml(accentFor(detailEl)) : '';
  }

  function pairedCount() {
    return txns ? txns.filter((t) => t.paired).length : 0;
  }

  // The sign says what the click will do, not what the state is: − takes the
  // payments out, + puts them back.
  function toggleLabel() {
    const n = pairedCount();
    return `${hidePaired ? '+' : '−'} net payments${n ? ` (${n})` : ''}`;
  }

  function toolbarHtml() {
    return (
      `<div class="ecd-d-bar">` +
      `<span class="ecd-d-section">Transactions</span>` +
      `<input class="ecd-d-search" type="search" placeholder="Search transactions" ` +
      `value="${escapeHtml(txnQuery)}">` +
      `<button class="ecd-d-toggle${hidePaired ? ' ecd-on' : ''}" type="button" ` +
      `aria-pressed="${hidePaired}" title="Transfers and card payments where ` +
      `both sides are visible — they net to zero">${toggleLabel()}</button>` +
      `</div>`
    );
  }

  function wireToolbar() {
    if (!detailEl) return;
    const search = detailEl.querySelector('.ecd-d-search');
    if (search) {
      search.oninput = () => {
        txnQuery = search.value;
        refreshRows();
      };
      // Esc clears rather than closing the view — the view is Back's job.
      search.onkeydown = (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        search.value = '';
        txnQuery = '';
        refreshRows();
      };
    }
    const btn = detailEl.querySelector('.ecd-d-toggle');
    if (btn) {
      btn.onclick = () => {
        hidePaired = !hidePaired;
        refreshRows();
      };
    }
  }

  function renderDetail() {
    if (!detailEl) return;
    const accentPair = accentFor(detailEl);
    // Transaction rows colour themselves off these, so the red/green tracks
    // the dashboard's own background the same way the chart's fill does.
    detailEl.style.setProperty('--ecd-pos', accentPair.pos);
    detailEl.style.setProperty('--ecd-neg', accentPair.neg);
    const totals = lastData ? lastData.totals : null;
    const net = totals ? totals.BANK - totals.CREDIT_CARD : 0;
    const accent = net < 0 ? accentPair.neg : accentPair.pos;
    const ink = 'currentColor';

    let chart;
    if (series && series.length > 1) {
      chart =
        `<div class="ecd-d-chartwrap">${chartSvg(series, accentPair, ink)}` +
        `<div class="ecd-tip"></div></div>`;
    } else if (seriesError) {
      chart = `<div class="ecd-d-note">Graph unavailable — ${seriesError}</div>`;
    } else {
      chart = `<div class="ecd-d-note">Loading history…</div>`;
    }

    detailEl.innerHTML =
      `<div class="ecd-d-head">` +
      `<span class="ecd-d-title" title="Back to the Overview">${CARD_TITLE}</span>` +
      `<span class="ecd-d-hero" style="color:${accent}">${totals ? money(net) : '—'}</span>` +
      `</div>` +
      `<div class="ecd-d-sub">${subHtml(totals)}</div>` +
      chart +
      `<div class="ecd-d-foot">${
        series && series.length > 1 ? changeHtml(accentPair) : ''
      }</div>` +
      toolbarHtml() +
      `<div class="ecd-d-rows">${txnRows()}</div>`;

    // No Back button, so the way out is the title or Esc — both wired here.
    const back = detailEl.querySelector('.ecd-d-title');
    if (back) back.onclick = closeDetail;
    // Delegated: the tally holding this button is rebuilt on every filter
    // change, so binding the element directly would last one click.
    detailEl.onclick = (e) => {
      if (e.target.closest('.ecd-d-clear')) clearSelection();
    };
    wireToolbar();
    if (series && series.length > 1) attachHover(detailEl, series, accentPair);
  }

  function placementTarget() {
    const self = document.getElementById(CARD_ID);
    for (const p of CARD_PLACEMENT) {
      const found = bestCard(p.text);
      if (found && found.parentElement && found !== self) {
        return { anchor: found, where: p.where, via: `"${p.text}" (${p.where})` };
      }
    }
    return null;
  }

  function isPlacedAt(card, t) {
    if (card.parentElement !== t.anchor.parentElement) return false;
    return t.where === 'after'
      ? card.previousElementSibling === t.anchor
      : card.nextElementSibling === t.anchor;
  }

  function place(card, t) {
    t.anchor.parentElement.insertBefore(
      card,
      t.where === 'after' ? t.anchor.nextSibling : t.anchor
    );
    // Inherit the neighbouring card's chrome, not whatever we landed next to
    // on a half-rendered page.
    card.className = t.anchor.className;
  }

  let lastPlaceCheck = 0;

  function ensureCard() {
    if (detailEl && detailEl.isConnected) return;
    let card = document.getElementById(CARD_ID);
    if (card && card.isConnected) {
      paintCard(card);
      if (!lastData) ensureData();
      // The SPA renders in stages, so the first anchor we can find is often a
      // transient element. Keep checking, and move the card once the real
      // cards exist.
      if (Date.now() - lastPlaceCheck > 2000) {
        lastPlaceCheck = Date.now();
        const t = placementTarget();
        if (t && !isPlacedAt(card, t)) {
          place(card, t);
          console.info(
            `[Empower My Numbers] card re-homed via ${t.via} → ${describe(t.anchor)}`
          );
        }
      }
      return;
    }

    // Searching walks the tree, so back off when the anchor card simply isn't
    // on this page — but never delay a re-insert when it is there.
    if (Date.now() - lastCardMissAt < 1000) return;

    let t = placementTarget();

    // Last resort: no configured title matched, so drop the tile at the top of
    // whichever container holds the most card-sized children. Better to appear
    // somewhere reasonable than not at all; re-homing will correct it later.
    if (!t) {
      const col = fallbackColumn();
      const first = col && [...col.children].find(isCardSized);
      if (first) t = { anchor: first, where: 'before', via: 'fallback: densest column' };
    }

    if (!t) {
      lastCardMissAt = Date.now();
      console.info(
        '[Empower My Numbers] no placement anchor found; tried ' +
          CARD_PLACEMENT.map((p) => `"${p.text}"`).join(', ') +
          ' — run ecdDiagnose() for details'
      );
      return;
    }

    card = document.createElement('div');
    card.id = CARD_ID;
    // Title left, current figure right on one row — the same shape as
    // Empower's own Net Worth card.
    card.innerHTML =
      `<div class="ecd-c-head">` +
      `<div class="ecd-c-title"><span class="ecd-c-name"></span>` +
      `<span class="ecd-c-more" title="Open Net cash detail">»</span></div>` +
      `<div class="ecd-c-val">—</div>` +
      `</div>` +
      `<div class="ecd-c-sub"></div>` +
      `<div class="ecd-c-spark"></div>` +
      `<div class="ecd-c-foot"></div>`;
    card.querySelector('.ecd-c-name').textContent = CARD_TITLE;
    card.style.cursor = 'pointer';
    card.title = 'Open Net cash detail';
    card.addEventListener('click', openDetail);
    place(card, t);
    lastPlaceCheck = Date.now();

    // If their class carries no padding of its own, supply some.
    try {
      if ((parseFloat(getComputedStyle(card).paddingTop) || 0) < 4) {
        card.style.padding = '20px';
      }
    } catch (_) {}

    console.info(
      `[Empower My Numbers] card inserted via ${t.via} → ${describe(t.anchor)}`
    );

    paintCard(card);
    ensureData();
  }

  function fallbackColumn() {
    let best = null;
    let bestCount = 0;
    for (const el of document.querySelectorAll('div, section, main')) {
      if (isForbidden(el)) continue;
      let count = 0;
      for (const kid of el.children) if (isCardSized(kid)) count++;
      if (count >= 2 && count > bestCount) {
        best = el;
        bestCount = count;
      }
    }
    return best;
  }

  function describe(el) {
    if (!el) return 'none';
    const r = el.getBoundingClientRect();
    const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 60);
    return `<${el.tagName.toLowerCase()} class="${cls}"> ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function buildReport() {
    return {
      version: VERSION,
      world: WORLD,
      host: location.host,
      cardPresent: describe(document.getElementById(CARD_ID)),
      detailOpen: !!(detailEl && detailEl.isConnected),
      accountsLoaded: rawAccounts.length,
      csrf: capturedCsrf ? 'captured' : 'not seen',
      hiddenCards: document.querySelectorAll('[data-ecd-hidden]').length,
      seriesError,
      // Rendered geometry, so a "graph looks small" report can be checked
      // against actual pixels rather than guessed at.
      graph: (() => {
        const c = document.getElementById(CARD_ID);
        const svg = c && c.querySelector('.ecd-c-spark svg');
        const wrap = c && c.querySelector('.ecd-c-spark');
        const vals = series ? series.map((p) => p.value) : [];
        return {
          points: series ? series.length : 0,
          min: vals.length ? Math.min(...vals) : null,
          max: vals.length ? Math.max(...vals) : null,
          svgBox: svg ? describe(svg) : 'none',
          wrapBox: wrap ? describe(wrap) : 'none',
          cardBox: c ? describe(c) : 'none',
          svgHeightAttr: svg ? (svg.getAttribute('style') || '') : '',
        };
      })(),
      historyProbe,
      cashAccountIds: cashAccountIds().length,
      anchors: CARD_PLACEMENT.map((p) => ({
        text: p.text,
        matches: findCardsByText(p.text).map((c) => describe(c.card)),
      })),
      fallbackColumn: describe(fallbackColumn()),
      apiHosts: [...apiBases],
    };
  }

  // Also reachable from the console, for whoever prefers it.
  try {
    window.ecdDiagnose = function () {
      const r = buildReport();
      console.log(JSON.stringify(r, null, 2));
      return r;
    };
  } catch (_) {}

  // ===========================================================================
  // UI
  // ===========================================================================

  const money = (n) =>
    (n < 0 ? '−' : '') +
    '$' +
    Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

  // Movements carry an explicit sign as well as a colour: red/green alone is
  // no good to anyone reading this colourblind, or in a screenshot.
  const signed = (n) => (n > 0 ? '+' : '') + money(n);

  // Neutral grey rather than a colour: it has to sit behind red and green
  // figures without arguing with them, on a light or a dark dashboard.
  const PAIR_SHADE = 'rgba(128,128,128,.14)';

  const CSS = `
  #ecd-panel{position:fixed;${ANCHOR}z-index:2147483000;width:340px;
    font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    background:#fff;color:#16202c;border:1px solid #d9e0e8;border-radius:12px;
    box-shadow:0 12px 32px rgba(16,32,48,.18);overflow:hidden}
  #ecd-panel.ecd-collapsed .ecd-body{display:none}
  #ecd-panel .ecd-head{display:flex;align-items:center;gap:8px;padding:10px 12px;
    background:#0f2942;color:#fff;cursor:move;user-select:none}
  #ecd-panel .ecd-head strong{font-size:12px;letter-spacing:.06em;text-transform:uppercase;flex:1}
  #ecd-panel .ecd-head button{background:transparent;border:0;color:#9fb6cc;cursor:pointer;
    font-size:15px;padding:2px 4px;line-height:1}
  #ecd-panel .ecd-head button:hover{color:#fff}
  #ecd-panel .ecd-body{padding:14px;max-height:calc(100vh - 90px);overflow-y:auto}
  #ecd-panel .ecd-tile{padding:8px 0;border-bottom:1px solid #eef2f6}
  #ecd-panel .ecd-tile:last-of-type{border-bottom:0}
  #ecd-panel .ecd-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#6b7d8f}
  #ecd-panel .ecd-hint{font-size:11px;color:#93a3b3;text-transform:none;letter-spacing:0}
  #ecd-panel .ecd-val{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
  #ecd-panel .ecd-tile.ecd-primary .ecd-val{font-size:30px;letter-spacing:-.01em}
  #ecd-panel .ecd-neg{color:#c0392b}
  #ecd-panel .ecd-green{color:#127a45}
  #ecd-card .ecd-c-head{display:flex;align-items:baseline;gap:16px;
    justify-content:space-between}
  /* Title takes its family/size/case/colour from Empower's own Net worth
     heading, copied inline in applyStyleRefs. This fallback applies only when
     their card couldn't be read. */
  #ecd-card:not([data-ecd-styled]) .ecd-c-title{font:700 16px/1.3 inherit;opacity:.95}
  /* Their "Net worth ⓘ »" uses the same chevron to mean "there is more here". */
  /* Their heading is sentence case, so ours is too — held down hard because
     the case is the one thing the adopted class kept getting wrong. */
  #ecd-card .ecd-c-title{text-transform:none !important;letter-spacing:normal !important}
  #ecd-card .ecd-c-more{margin-left:6px;opacity:.55;font-weight:400}
  #ecd-card:hover .ecd-c-more{opacity:1}
  /* The figure is sized here, deliberately: it sits in the header corner, so
     it should read a step above the title, not like a hero number. */
  #ecd-card .ecd-c-val{font-family:inherit !important;font-size:20px !important;
    line-height:1.25 !important;font-weight:700 !important;letter-spacing:-.01em;
    font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;
    margin:0 !important;padding:0 !important}
  /* Two rows, figures in their own right-aligned column so the digits line up
     under each other and the gap between them is readable at a glance. */
  #ecd-card .ecd-c-sub,#ecd-detail .ecd-d-sub{display:inline-grid;
    grid-template-columns:auto auto;column-gap:16px;row-gap:1px;
    font-variant-numeric:tabular-nums}
  #ecd-card .ecd-c-sub{margin-top:8px;font:400 12px/1.5 inherit;opacity:.6}
  #ecd-card .ecd-c-sub .ecd-sub-n,#ecd-detail .ecd-d-sub .ecd-sub-n{text-align:right}
  /* Change figures sit at the two bottom corners of the graph, as on theirs. */
  #ecd-card .ecd-c-foot,#ecd-detail .ecd-d-foot{display:flex;
    justify-content:space-between;align-items:baseline;margin-top:6px;
    font:400 12px/1.3 inherit;font-variant-numeric:tabular-nums}
  /* A selected span is labelled with its dates, which is wider than "1-day" —
     it may not wrap into two lines and drag the corner out of alignment. */
  #ecd-card .ecd-chg,#ecd-detail .ecd-chg{white-space:nowrap}
  #ecd-card .ecd-chg-l,#ecd-detail .ecd-chg-l{opacity:.6}
  #ecd-card .ecd-chg-v,#ecd-detail .ecd-chg-v{font-weight:700}
  /* Height is set inline from the measured card; these rules only stop
     Empower's card CSS from collapsing the element. */
  #ecd-card .ecd-c-spark{margin-top:12px;display:block;width:100%;
    overflow:visible;flex:1 1 auto}
  #ecd-card .ecd-c-spark svg{display:block;width:100%;height:100%}
  #ecd-detail{font:inherit}
  #ecd-detail .ecd-d-head{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  /* The title is the way back, so it says so on hover — there is no button. */
  #ecd-detail .ecd-d-title{font:700 17px/1.2 inherit;cursor:pointer}
  #ecd-detail .ecd-d-title:hover{text-decoration:underline;text-underline-offset:3px}
  /* Same treatment as the tile: figure pinned to the top right of the header
     row, not a hero block underneath. */
  #ecd-detail .ecd-d-hero{margin-left:auto;font:700 20px/1.25 inherit;
    letter-spacing:-.01em;font-variant-numeric:tabular-nums;white-space:nowrap}
  #ecd-detail .ecd-d-sub{margin-top:8px;font:400 13px/1.5 inherit;opacity:.6}
  #ecd-detail .ecd-d-chartwrap{position:relative;margin-top:18px}
  #ecd-detail .ecd-tip{position:absolute;top:-4px;left:0;opacity:0;
    pointer-events:none;display:flex;gap:8px;align-items:baseline;
    font:12px/1 inherit;transition:opacity .1s}
  #ecd-detail .ecd-tip-d{opacity:.55}
  #ecd-detail .ecd-tip-v{font-weight:600;font-variant-numeric:tabular-nums}
  #ecd-detail .ecd-d-section{margin:0;font:600 13px/1 inherit;
    text-transform:uppercase;letter-spacing:.06em;opacity:.55;flex:none}
  /* Heading left, search centred, filter right — the search takes the slack so
     it stays in the middle whatever the heading's length. */
  #ecd-detail .ecd-d-bar{display:flex;align-items:center;gap:12px;
    flex-wrap:wrap;margin:26px 0 10px}
  #ecd-detail .ecd-d-search{flex:1 1 180px;min-width:0;max-width:340px;
    margin:0 auto;padding:7px 10px;border:1px solid rgba(128,128,128,.35);
    border-radius:7px;background:transparent;color:inherit;font:13px/1.2 inherit}
  #ecd-detail .ecd-d-search:focus{outline:none;border-color:currentColor}
  /* Wears the same grey as the rows it acts on, so the connection between the
     button and the shaded rows is visible rather than something to work out. */
  #ecd-detail .ecd-d-toggle{flex:none;cursor:pointer;background:${PAIR_SHADE};
    border:1px solid rgba(128,128,128,.3);border-radius:6px;padding:5px 9px;
    font:600 8pt/1 inherit;color:inherit;opacity:.75;white-space:nowrap}
  #ecd-detail .ecd-d-toggle:hover{opacity:1}
  #ecd-detail .ecd-d-toggle.ecd-on{opacity:1;border-color:currentColor;
    background:rgba(128,128,128,.28)}
  /* Paired rows stay put by default, greyed rather than gone: the eye can skip
     them, and you can still see the payment happened. */
  #ecd-detail .ecd-d-pair td{background:${PAIR_SHADE}}
  #ecd-detail .ecd-d-tally{margin-bottom:8px;font:12px/1.4 inherit;opacity:.65;
    font-variant-numeric:tabular-nums}
  #ecd-detail .ecd-d-clear{background:none;border:0;padding:0;cursor:pointer;
    color:inherit;font:inherit;text-decoration:underline;text-underline-offset:2px}
  /* The chart is a date picker as well as a graph, so it says so. */
  #ecd-detail .ecd-chart-svg{cursor:crosshair;user-select:none}
  #ecd-detail .ecd-d-note{margin-top:16px;font:13px/1.5 inherit;opacity:.6}
  #ecd-detail .ecd-d-table{width:100%;border-collapse:collapse;font:13px/1.4 inherit}
  #ecd-detail .ecd-d-table td{padding:8px 6px;border-top:1px solid currentColor}
  #ecd-detail .ecd-d-table tr td{border-color:rgba(128,128,128,.18)}
  #ecd-detail .ecd-d-date{white-space:nowrap;opacity:.55;width:1%}
  #ecd-detail .ecd-d-acct{opacity:.55;white-space:nowrap}
  #ecd-detail .ecd-d-amt{text-align:right;white-space:nowrap;
    font-variant-numeric:tabular-nums;font-weight:600}
  /* Money in green, money out red — the pair is set on #ecd-detail from the
     sampled card background, so it stays readable light or dark. */
  #ecd-detail .ecd-d-in{color:var(--ecd-pos,#127a45)}
  #ecd-detail .ecd-d-out{color:var(--ecd-neg,#c0392b)}
  /* Reconciling rows close the list, and are not transactions — a heavier top
     rule and italics say so without needing a heading to explain it. */
  #ecd-detail .ecd-d-recon td{border-top:2px solid rgba(128,128,128,.45);
    font-style:italic;opacity:.85}
  /* A balance that hasn't caught up is not a discrepancy to chase, so it does
     not wear the red or green that says money moved. */
  #ecd-detail .ecd-d-stale td,
  #ecd-detail .ecd-d-stale .ecd-d-amt{color:inherit;opacity:.6}
  #ecd-pick-banner{position:fixed;top:0;left:0;right:0;z-index:2147483002;
    background:#0f2942;color:#fff;padding:11px;text-align:center;
    font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .ecd-pick-hover{outline:2px solid #e0a800 !important;outline-offset:-2px;
    cursor:pointer !important;background:rgba(224,168,0,.06) !important}
  #ecd-panel table{width:100%;border-collapse:collapse;margin-top:10px}
  #ecd-panel td{padding:3px 0;font-size:12px}
  #ecd-panel td:last-child{text-align:right;font-variant-numeric:tabular-nums}
  #ecd-panel .ecd-sub td{color:#6b7d8f}
  #ecd-panel .ecd-acct td{color:#9aa8b6;font-size:11px;padding-left:10px}
  #ecd-panel .ecd-foot{display:flex;gap:10px;align-items:center;margin-top:12px;
    font-size:11px;color:#93a3b3}
  #ecd-panel .ecd-foot a{color:#2a7ab0;cursor:pointer;text-decoration:none}
  #ecd-panel .ecd-err{color:#c0392b;font-size:12px;white-space:pre-wrap}
  #ecd-panel .ecd-pre{margin:10px 0 0;font:11px/1.45 ui-monospace,SFMono-Regular,
    Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;
    max-height:60vh;overflow:auto;opacity:.85}
  #ecd-panel code{font-size:10px;color:#6b7d8f;word-break:break-all;display:block}
  #ecd-fab{position:fixed;${ANCHOR}z-index:2147483000;background:#0f2942;
    color:#fff;border:0;border-radius:20px;padding:9px 16px;
    font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    cursor:pointer;box-shadow:0 6px 18px rgba(16,32,48,.24)}
  @media (prefers-color-scheme: dark){
    #ecd-panel{background:#141b22;color:#e6edf3;border-color:#2a3540;
      box-shadow:0 12px 32px rgba(0,0,0,.5)}
    #ecd-panel .ecd-tile{border-bottom-color:#232d37}
    #ecd-panel .ecd-neg{color:#ff7b6b}
    #ecd-panel .ecd-green{color:#48d18b}
  }`;

  let panel = null;
  let showAccounts = false;
  let lastData = null;

  function ensureStyle() {
    if (document.getElementById('ecd-style')) return;
    const s = document.createElement('style');
    s.id = 'ecd-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function renderError(msg) {
    const urls = [...seenUrls].filter((u) => /api|graphql/i.test(u)).slice(0, 12);
    const body = panel.querySelector('.ecd-body');
    body.innerHTML =
      `<div class="ecd-err">${escapeHtml(msg)}</div>` +
      (urls.length
        ? `<div class="ecd-foot" style="display:block;margin-top:10px">API calls this page made:<code>${urls.join('<br>')}</code></div>`
        : '') +
      `<div class="ecd-foot"><a class="ecd-refresh">Retry</a>` +
      `<a class="ecd-diag" style="margin-left:auto">Diagnose</a></div>`;
    body.querySelector('.ecd-refresh').onclick = load;
    body.querySelector('.ecd-diag').onclick = showDiagnostics;
  }

  function render(data) {
    const { totals, rows } = data;

    const tiles = TILES.map((t) => {
      const v = t.formula(totals);
      return `<div class="ecd-tile ${t.primary ? 'ecd-primary' : ''}">
        <div class="ecd-label">${t.label}${t.hint ? ` <span class="ecd-hint">${t.hint}</span>` : ''}</div>
        <div class="ecd-val ${v < 0 ? 'ecd-neg' : t.accent === 'green' ? 'ecd-green' : ''}">${money(v)}</div>
      </div>`;
    }).join('');

    const table = BREAKDOWN.filter(([k]) => (rows[k] || []).length)
      .map(([k, label, accent]) => {
        const sign = LIABILITIES.has(k) ? '−' : '';
        const cls = accent === 'green' ? ' class="ecd-green"' : '';
        let html =
          `<tr class="ecd-sub"><td>${label}</td>` +
          `<td${cls}>${sign}${money(totals[k])}</td></tr>`;
        if (showAccounts) {
          html += (rows[k] || [])
            .sort((a, b) => b.value - a.value)
            .map(
              (r) =>
                `<tr class="ecd-acct"><td>${r.firm ? r.firm + ' · ' : ''}${r.name}</td>` +
                `<td>${sign}${money(r.value)}</td></tr>`
            )
            .join('');
        }
        return html;
      })
      .join('');

    const body = panel.querySelector('.ecd-body');
    body.innerHTML =
      tiles +
      `<table>${table}</table>` +
      `<div class="ecd-foot">
         <a class="ecd-refresh">Refresh</a>
         <a class="ecd-toggle">${showAccounts ? 'Hide' : 'Show'} accounts</a>
         <span style="margin-left:auto" title="${data.source === 'cached' ? 'Read from the dashboard’s own earlier request; reload the page for fresher numbers' : 'Fetched live'}">
           ${data.source === 'cached' ? 'as of ' : ''}${new Date(data.at || Date.now()).toLocaleTimeString()}
         </span>
       </div>` +
      `<div class="ecd-foot">
         <a class="ecd-pick">Hide a card</a>
         ${hiddenCount() ? `<a class="ecd-unhide">Show ${hiddenCount()} hidden</a>` : ''}
         <a class="ecd-diag" style="margin-left:auto">Diagnose</a>
       </div>`;

    body.querySelector('.ecd-refresh').onclick = load;
    body.querySelector('.ecd-toggle').onclick = () => {
      showAccounts = !showAccounts;
      render(lastData);
    };
    body.querySelector('.ecd-pick').onclick = startPicker;
    body.querySelector('.ecd-diag').onclick = showDiagnostics;
    const unhide = body.querySelector('.ecd-unhide');
    if (unhide) {
      unhide.onclick = () => {
        unhideAll();
        render(lastData);
      };
    }
  }

  function hiddenCount() {
    return document.querySelectorAll('[data-ecd-hidden]').length;
  }

  // Quotes included: the search box's own text is written back into a value
  // attribute on every re-render, so a stray " would end the attribute.
  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  // Rendered in the panel rather than the console: the panel is known to work,
  // and page-context globals are awkward to reach from devtools.
  function showDiagnostics() {
    const body = panel.querySelector('.ecd-body');
    let text;
    try {
      text = JSON.stringify(buildReport(), null, 2);
    } catch (e) {
      text = 'Report failed: ' + ((e && e.stack) || e);
    }
    body.innerHTML =
      `<div class="ecd-foot"><a class="ecd-diagback">← Back</a>` +
      `<a class="ecd-diagcopy">Copy</a></div>` +
      `<pre class="ecd-pre">${escapeHtml(text)}</pre>`;
    body.querySelector('.ecd-diagback').onclick = () =>
      lastData ? render(lastData) : load();
    body.querySelector('.ecd-diagcopy').onclick = () => {
      try {
        navigator.clipboard.writeText(text);
        body.querySelector('.ecd-diagcopy').textContent = 'Copied';
      } catch (_) {}
    };
  }

  async function load() {
    panel.querySelector('.ecd-body').innerHTML = '<div class="ecd-hint">Loading…</div>';
    try {
      const { accounts, source, at } = await fetchAccounts();
      lastData = group(accounts);
      lastData.source = source;
      lastData.at = at;
      render(lastData);
    } catch (e) {
      renderError(String((e && e.message) || e));
    }
  }

  function makeDraggable(handle, el) {
    let ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      dragging = true;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = e.clientX - ox + 'px';
      el.style.top = e.clientY - oy + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  }

  function openPanel() {
    ensureStyle();
    const fab = document.getElementById('ecd-fab');
    if (fab) fab.remove();

    panel = document.createElement('div');
    panel.id = 'ecd-panel';
    panel.innerHTML = `
      <div class="ecd-head">
        <strong>${LABEL}</strong>
        <button class="ecd-min" title="Collapse">–</button>
        <button class="ecd-close" title="Close">×</button>
      </div>
      <div class="ecd-body"></div>`;
    document.body.appendChild(panel);

    panel.querySelector('.ecd-min').onclick = () => panel.classList.toggle('ecd-collapsed');
    panel.querySelector('.ecd-close').onclick = () => {
      panel.remove();
      panel = null;
      addFab();
    };
    makeDraggable(panel.querySelector('.ecd-head'), panel);
    load();
  }

  function addFab() {
    ensureStyle();
    if (document.getElementById('ecd-fab')) return;
    const b = document.createElement('button');
    b.id = 'ecd-fab';
    b.textContent = LABEL;
    b.onclick = openPanel;
    document.body.appendChild(b);
  }

  // ===========================================================================
  // Bootstrap
  //
  // The dashboard is a SPA that re-renders aggressively and can blow away
  // anything we append, so re-add the pill whenever it goes missing.
  // ===========================================================================

  const CLAIM = 'ecdClaimedBy';

  function mounted() {
    return !!(document.getElementById('ecd-fab') || document.getElementById('ecd-panel'));
  }

  // Each step is isolated: a failure in one must not take the others down with
  // it, and must say so rather than failing silently.
  function guard(name, fn) {
    try {
      fn();
    } catch (e) {
      if (!guard.seen) guard.seen = new Set();
      if (!guard.seen.has(name)) {
        guard.seen.add(name);
        console.error(`[Empower My Numbers] ${name} failed:`, e);
      }
    }
  }

  function sweep() {
    if (!document.body) return;
    if (!mounted()) guard('addFab', addFab);
    guard('applyHidden', applyHidden);
    if (detailEl && detailEl.isConnected) {
      guard('isolate', isolate);
      guard('hideFooters', hideFooters);
    }
    guard('ensureCard', ensureCard);
  }

  // Empower re-renders in bursts, so coalesce. This must fire on the trailing
  // edge: a plain "ignore if too soon" throttle drops the final mutation of a
  // burst, which is exactly the one that rebuilt the page.
  const SWEEP_MS = 350;
  let sweepQueued = false;
  let lastSweepAt = 0;

  function requestSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    const wait = Math.max(0, SWEEP_MS - (Date.now() - lastSweepAt));
    setTimeout(() => {
      sweepQueued = false;
      lastSweepAt = Date.now();
      sweep();
    }, wait);
  }

  function watch() {
    const obs = new MutationObserver(requestSweep);
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Belt and braces: the observer can miss wholesale body swaps.
    setInterval(sweep, 3000);
  }

  function start() {
    if (!document.body) return setTimeout(start, 100);

    const claimed = document.documentElement.dataset[CLAIM];
    if (claimed && claimed !== WORLD) {
      // The other world already owns the UI. Stand down.
      console.info(`[Empower My Numbers] ${WORLD} world standing down (${claimed} has it)`);
      return;
    }
    document.documentElement.dataset[CLAIM] = WORLD;

    guard('addFab', addFab);
    guard('applyHidden', applyHidden);
    guard('ensureCard', ensureCard);
    watch();
  }

  if (IS_ISOLATED) {
    // Give the main world a head start; it has access to window.csrf, so it is
    // the better of the two. If it never shows up, we take over.
    const kick = () => setTimeout(start, 600);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', kick);
    } else {
      kick();
    }
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
