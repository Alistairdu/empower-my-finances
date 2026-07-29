# Empower — My Numbers

A small Chrome extension that adds a **Net Cash** button to the Empower Personal
Dashboard. Click it and a floating panel shows figures Empower won't compute for
you — starting with `banks − credit cards`.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the folder containing `manifest.json`
4. Open your Empower dashboard and log in
5. Click the **Net Cash** pill in the bottom-right corner

After editing `content.js`, hit the reload arrow on the extension card, then
refresh the Empower tab.

Windows, macOS and Linux all run the same two files unchanged — it is browser
JavaScript, with no build step, no filesystem access and no OS-specific APIs.
Two things to watch when copying the folder to Windows:

- **Keep the files UTF-8 without a BOM.** The UI uses `−`, `»` and `←`
  characters; an editor that adds a byte-order mark or saves as ANSI will
  garble them, and a BOM on `manifest.json` can stop the extension loading.
- **Put the folder on a real local disk**, not a OneDrive-synced or mapped
  network path — Chrome reloads unpacked extensions from disk on every start
  and sync placeholders make that unreliable.

## How it works

The dashboard is a single-page app that loads your accounts from an internal
JSON endpoint — `https://pc-api.empower-retirement.com/api/newaccount/getAccounts2`,
which is a *different origin* from the page you're looking at.

The content script runs in the page's own JS context and reads the response to
that request as the dashboard makes it. That sidesteps CSRF tokens, CORS and
cross-origin cookies entirely: the data is already arriving, we just look at it.
It also tries calling the endpoint directly for on-demand refreshes, and falls
back to the snooped copy when that isn't possible.

**This means you must load the panel on a page that fetches accounts.** Open or
reload your dashboard with the extension enabled, then click the pill. If the
footer says "as of <time>", you're seeing the snooped copy — reload the page for
fresher figures.

- No credentials are stored, requested, or transmitted.
- Nothing leaves your browser — there is no server, no analytics, no network
  call to anywhere but Empower itself.
- Read-only. It never writes to your accounts.

## Customising the numbers

Everything lives in the `CONFIG` block at the top of `content.js`. Each tile is
a label plus a formula over the per-category subtotals:

```js
const TILES = [
  { label: 'Net Cash', hint: 'banks − credit cards', primary: true,
    formula: (g) => g.BANK - g.CREDIT_CARD },
];
```

Available subtotals: `BANK`, `CREDIT_CARD`, `INVESTMENT`, `LOAN`, `MORTGAGE`,
`OTHER_ASSETS`. Liabilities are normalised to a positive "amount owed", so you
subtract them.

Add a tile by adding an entry. For example, cash minus one month of expenses:

```js
{ label: 'Buffer', formula: (g) => g.BANK - g.CREDIT_CARD - 6500 },
```

## The injected Net Cash card

A **Net Cash** card is added to Empower's own Overview grid, directly above
Net Worth. It is found the same way cards are hidden — match the words on
screen, climb to the surrounding card — and then reuses that card's own class
list, so it inherits Empower's background, corner radius, shadow and grid
sizing without hardcoding anything about their design system.

```js
const CARD_PLACEMENT = [
  { text: 'Performance', where: 'before' }, // middle column, under the graph
  { text: 'Net Worth', where: 'after' },    // fallback: just below Net Worth
];
```

Anchors are tried in order. Because the sidebar also says "Net Worth", matches
are ranked by exact title first and then by area — the sidebar row is small, the
real card is a big block — so the card lands in the main column.

The chart is a filled area scaled to the data, so the series uses the full plot
height. Zero is not forced into the axis — it is only the *fill baseline*: fill
above zero is green, below zero is red, and when zero is off-screen the baseline
clamps to the plot edge so an all-positive series fills solidly. A distinct zero
rule is drawn only when zero is actually in view.

The tile's title and figure sit on one row, and the title is **matched to
Empower's own Net worth heading** — same family, size, weight, colour and
letter case. Adopting their class list alone wasn't enough: lifted out of their
card the class lands in a different cascade, which is how "Net worth" came out
as an uppercase "NET CASH". So the heading's *computed* type is snapshotted and
set inline, where nothing outranks it; the class list is still copied for
anything not in the snapshot. The title reads "Net cash" in sentence case, to
sit under theirs without looking like a different design.

A `»` follows the title, the same affordance their cards use to say there is
more behind a click.

Below the title, **cash and cards are stacked** rather than run together on one
line, with the figures in their own right-aligned column so the digits line up
and the gap between them is readable without doing the subtraction yourself.

Under the graph, a **change figure** sits at each bottom corner exactly as
Empower's does — red below zero, green above. They answer two different
questions, and each can be checked against something else on the screen.

**Left is the graph itself, end to end.** Read the first and last points off the
picture and this is their difference. Not a fixed 90-day window: the graph draws
`SPARK_DAYS` of history, so a fixed 90-day figure under a chart of any other
length is a number you can't check against what you're looking at, and the two
won't agree because they aren't measuring the same thing. The label reports the span
actually covered, so a short history reads "60-day" rather than claiming a
window it hasn't got.

**Right is what the transactions came to** — for the last day by default, or for
whatever is selected on the chart. Click a day, drag a span, or walk it with the
arrow keys, and the figure follows. The label switches from a span (`1-day`) to
the dates themselves (`2026-07-14`, or `2026-07-01 → 2026-07-14`), so a selected
change can't be misread as the daily one. Only this number is repainted when the
selection moves — rebuilding the view would tear the search box out mid-keystroke.

Being the transactions' total is what makes it checkable: in the detail view it
is the sum of the rows listed directly underneath it, and a change that doesn't
match the list it sits above is a number you have to take on trust. The
selection is read the way the list reads it — **both ends inclusive** — so the
measurement starts at the point *before* the first selected day, and what
happened on that day counts as part of it. Netting is unaffected by the
`− net pmts` toggle, since a pair is equal and opposite by definition and
removing both legs removes zero. The search box doesn't apply either: it is a
way of finding a row, not a redefinition of what the days came to.

One consequence worth knowing: **a day whose transactions haven't posted yet
reads as zero**, because that is what the list says too. Where the balances moved
by something the transactions don't show, the list says so on its own line — see
below.

Hovering either figure shows what it was measured between: both dates, both
totals, and any reason the two ends aren't strictly comparable (see below).

### The header follows the selection too

Select a span on the graph and the figures above it — the net cash headline and
the cash/cards pair — become the figures **as they stood at the end of that
span**, with an `as of 2026-07-14` beside them. Series points carry their
per-account balances, so this is only a matter of splitting them by product type:
the same split `group()` does on the live payload, over a day that has already
been.

A selection is a question about a day that has passed, and answering it with
today's balances beside a graph pinned to that day is exactly the sort of
mismatch the rest of this file exists to remove. The date is never omitted — a
stale number that looks live is worse than no number at all. Clearing the
selection puts the live figures back.

Cash minus cards equals the graph's own value at that point, at every point, so
the header can't drift away from the picture.

### Why the daily change used to read wrong

Two things made it so, and both are now handled.

**The graph ended somewhere other than the number printed above it.** The
headline figure comes from the accounts payload; the graph comes from
`getHistories`. They are different endpoints and they don't land together —
history routinely stops at yesterday, or carries a row for today taken before
this morning's sync. So the "1-day" change compared two history days while the
headline had already moved on: right about the series, wrong about the question.
Your live balances are now treated as **a reading for today like any other**,
and a better one than history's, so the graph ends on the figure printed above
it. They are taken per account rather than as one total: an account that arrives
without a balance costs only its own reading, and the rest still update. An
account with no balance field is skipped rather than read as zero — `normalise()`
would call a missing balance 0, and a card at zero reads as paid off.

**Carrying a balance forward moves an account's whole gap onto one day.** It is
what keeps the total comparable across a reporting gap, but the flip side is
that a card silent for a week posts seven days of spending as a single step. The
money is real; it just isn't one day's worth — and this was the bigger of the
two errors. The fix is below.

### The graph is drawn from the transactions, not just the balances

We know when money moved: the transactions are dated. So the graph doesn't have
to guess at a reporting gap, and it no longer does.

Each account's balance for a day now comes from one of three places, in order
of authority:

1. **What it reported that day** — including a live balance, per above.
2. **What the dated transactions say it must have been**, across a gap whose two
   ends both reported and whose transactions add up to the difference.
3. **Its last known balance, carried** — the old behaviour, now the last resort
   rather than the only option.

Inside a gap that reconciles, *every* calendar day is known, not just the ones a
transaction is dated on: the balance is the earlier reading plus everything
dated on or before that day, and the later reading proves the sum. The quiet
days in between are the flat stretches of the graph, and they are as known as
the days money moved. A weekend the banks don't report on is drawn, and a
Saturday purchase lands on Saturday rather than on Monday — where it used to
read as a three-day step.

**Reconciling to the cent is the whole safeguard.** A gap is filled only when
its transactions account for the difference exactly. A pending charge, an
interest posting, a transaction window that doesn't reach back far enough — any
of them and the sums won't meet, which means the gap isn't understood, and it
carries forward as before rather than being filled with something
plausible-looking. Being a cent out is enough to refuse.

Two things that look like the same case but aren't:

- **Not having the transactions is not the same as an account having none.** A
  gap whose balance ends where it started reconciles against an empty list
  trivially, and would be drawn flat on no evidence at all. So nothing is
  derived until the list is actually loaded, and only back as far as it was
  asked to cover — before that, "no transactions" means "none loaded", not
  "none happened".
- **A movement with nothing to prove it is left out.** If an account never
  reports again, there is no closing balance to check its transactions against,
  and they aren't drawn. Its balance carries, as it always did.

Signs need no conversion between the two sources: the series holds a card as a
negative amount owed, and transaction amounts are already signed
money-in/money-out, so a $100 card purchase is −100 to both, and a $500 card
payment is +500 to both. A card payment therefore nets to zero on the day it
clears, which is what it should do to *net* cash.

This is why transactions are now loaded as soon as there are accounts to load
them for, rather than when the detail view opens — the card's own graph and
change figure need them. Opening the view is instant as a result, which is the
agreeable half of paying for the call up front.

Hovering a change figure says which of the three it relied on: `2 of 5 balances
on 2026-07-27 worked out from dated transactions`, or `1 of 5 accounts hadn't
reported by 2026-07-27 and couldn't be reconciled from transactions`. A step
that still looks too big explains itself rather than just looking wrong.

## Tests

```
node test.js
```

No dependencies, no build step, nothing to install. The series arithmetic is the
one part of this that can be wrong without *looking* wrong — a balance graph
draws a confident line through whatever it is handed — so the functions that
build it are lifted out of `content.js` by name and run against made-up history
and transactions, where the right answer is known. The source is read rather
than copied, so a passing test is a statement about the code that actually
ships.

The graph is measured to fill whatever height the card has left, after the
header, the breakdown and the change row have taken theirs.

Clicking the tile opens a detail view that clears the main content area down to
just the chart and transactions — every other tile, including the Net Worth
graph in its own row, is hidden. The **accounts sidebar and the site header stay
put**: the sweep spares any narrow full-height rail and anything containing
`nav`/`header`. Closing restores everything, and cards you chose to hide via
`HIDE_TILES` stay hidden.

There is no Back button: **click the "Net cash" title, or press Esc**. The title
underlines on hover to say so. Esc matters here — without it, losing the button
would leave a page reload as the only way out.

The clearing is **re-applied on every sweep, not just when the view opens**.
Tiles like Budgeting and Cash Flow mount after the click, so a one-shot sweep
leaves them to reappear on top of the transactions. Hidden elements are marked
with an attribute instead of being collected in a list, so a tile React
re-created — a different node in the same slot — is caught on the next pass.

The **page footer is hidden too, for as long as the detail view is open**.
Empower lays the footer out against the sidebar's height rather than the main
column's, so a long transaction list runs underneath it and the last rows are
covered. The footer sits outside the card's ancestor chain, so the isolation
sweep never reaches it; it is matched separately by `footer`,
`role="contentinfo"`, or a `footer` in the class or id. Matches are tracked by
attribute rather than in the restore list, because the SPA re-inserts the footer
while the view is open and every sweep has to re-hide it. Anything filling the
screen is skipped — that's a layout wrapper, not a footer.

Transaction amounts are **green for money in and red for money out**, carrying an
explicit `+`/`−` as well so the sign survives a screenshot or a colourblind
reader. The pair comes from the same background sampling as the chart, so it
stays legible on a light or dark dashboard.

The accent colour is chosen by sampling the card's actual background, so it
stays readable on a light or dark dashboard.

### Picking dates off the graph

The chart is a date picker as well as a picture. **Click a day** to show only
that day's transactions; **drag across** to select a span. The selection is
drawn as a grey band, the tally names it (`12 of 379 transactions on
2026-07-14`), and **clear** next to the tally drops it. Clicking the selected
day again also clears it — otherwise a one-day selection is a filter you can set
from the chart but not unset.

**← and →** walk the selection a day at a time, and **Shift+→ / Shift+←** grow
and shrink it from the right-hand end. With nothing selected yet, the first
press anchors on the most recent day. The arrows step by *calendar* day rather
than by series index: the history can have gaps, and stepping by index would
skip the days inside them — days that have transactions even though no balance
was reported. Dates are parsed and formatted in UTC throughout, so a step never
lands on 23:00 the previous day when the clocks change.

Dates are handled in UTC throughout *for arithmetic* — a day string parses as
UTC midnight, so stepping one lands on midnight and never on 23:00 the day
before when the clocks change. But "today" is a different question, and asking
it in UTC was a bug: west of Greenwich, UTC rolls over in the early evening, so
`ymd(Date.now())` started answering with tomorrow partway through the afternoon
and the graph grew a point for a day that hadn't happened. `todayLocal()` asks
the instant for its own offset — right on both sides of a daylight-saving
change — and everything that means "today" now goes through it.

Sliding a range moves both ends or neither: clamping one end at the edge of the
chart would silently resize the range rather than move it. The arrows are
ignored while the search box has focus, where they belong to the caret.

The crosshair and tooltip work as before; dragging just adds a band. Releasing
outside the plot commits whatever was covered rather than dropping the
selection, and text selection is suppressed while dragging so the page doesn't
highlight under the cursor.

Selection is held as dates, not as indices into the series, so it survives the
history being refetched. Dates are normalised through `dayKey()` before
comparison — history points and transactions come from different endpoints and
need not agree on format — and a selected day with no matching history point
falls back to the nearest one.

The day filter stacks with the search and the transfer toggle: all three apply
at once, in `visibleTxns()`. The change figure at the bottom-right of the graph
follows the selection as well, and is the net of exactly the rows the selection
puts in the list.

### What the transactions don't account for

Two things describe the same days and don't always agree: the balances, from
`getHistories`, and the itemised movements, from `getUserTransactions`. They
drift apart for real reasons — interest credited, a monthly fee, a charge that
has hit the balance but hasn't posted as a row yet, a transaction Empower
didn't return. Neither payload says why. It is the one figure in the view that
can be *measured* but not derived: the code can tell you the gap to the cent and
cannot tell you what it consists of.

So it is reported rather than absorbed, and reported **as rows at the foot of
the transaction list** — because it is money that moved, the list is the record
of money that moved, and leaving it out is what made the totals disagree in the
first place. With those rows, the transactions above plus the reconciling rows
below come to exactly what the balances did.

**One row per account, named.** A single lump is a dead end: "$412 unexplained"
tells you something is off and nothing else, where "$412 unexplained on
Checking" tells you where to go and look. Per-account balances are kept on each
series point for this, so a discrepancy can be attributed to the account it came
from. Biggest first — that is the one worth chasing.

The rows cover the selection if there is one, otherwise the whole graph. Not the
whole loaded list: transactions dated before the series starts have no opening
balance to be measured against, so there is nothing to reconcile them to.

They are **not shown while a search is running.** The visible rows are then a
subset chosen by a word, and the balance movement has nothing to do with that
word — a reconciling line under it would be arithmetic about two unrelated
things. The `− net pmts` toggle is fine: a pair is equal and opposite, so
hiding both legs changes the total by zero.

They also appear when nothing else matches. A selected day with no transactions
whose balance moved anyway is the case they exist for — without them the view
would say "nothing happened" over a graph that visibly stepped.

**A charge dated one day and posted another is not a discrepancy either.** This
is the big one on a credit card: a transaction is dated when you *made* the
charge and the balance moves when the bank *posts* it, routinely a day or three
later and longer over a weekend. Read a day at a time, one purchase makes two
accusations in opposite directions — the charge day shows a transaction against
a balance that hasn't moved, and the posting day shows a balance that moves with
no transaction dated to it. On a card in daily use that was most of the list.

**If the payload ships a posting date, that is used instead** and the problem
doesn't arise. `postedDay()` tries the known spellings — `postedDate`,
`postDate`, `settleDate` and friends — then anything else whose name looks like
one, the same tolerance the history parsing has and for the same reason: field
names move between builds. A candidate is only accepted if it parses to a date
that is on or after the charge and no more than `POST_MAX_LAG` (30) days later,
so a field named like a posting date but holding something else falls back
rather than corrupting every comparison. Diagnose reports which field was used
under `txnProbe.postingDateField`, or says none was found.

Everything that compares transactions to balances goes through `balanceDay()` —
the series derivation, the residuals, the day figure, and the list's own day
filter — so selecting a day on the graph lists what moved the balance *that*
day. Rows still show the date you'd recognise, the day the charge was made, and
say `Charged 2026-07-09, posted 2026-07-11` on hover when the two differ.

Where there is no posting date, residuals are computed per account for every day
of the series and then **matched against each other**: equal magnitude, opposite sign, same account,
within `SETTLE_DAYS` (6), one to one — the same shape as `markPairs()`. A matched
pair reads `Still settling — reaches the balance 2026-07-11` on one side and
`Settled here — dated 2026-07-09` on the other, greyed, with nothing to chase.
Over any span containing both days they cancel and no row appears at all. What
survives the matching is what no timing difference can account for.

Matching is on exact magnitude, so a fee landing on the very day a charge posts
merges with it and the pair stops being recognisable — both then read as
unexplained. That is the safe direction to fail in: it over-reports rather than
quietly swallowing a real difference.

**An account that has gone quiet is not an account with a discrepancy.** Where a
balance is *carried* at either end of the span — a gap the transactions couldn't
reconcile — the difference measured against it is a statement about reporting,
not about money, and the row says so instead: `Not in the balance yet — Blue Card
last reported 2026-07-20`. It is greyed rather than coloured, because there is
nothing to chase; it will disappear when the account next syncs.

The distinction matters because the naive reading points the wrong way twice
over. A card that goes quiet on the 20th and resurfaces on the 28th has a
balance that knows nothing of the week in between, so a purchase on the 25th
looks like unexplained money while the account is silent — and then the whole
silence lands as one lump on the 28th. Same numbers either way; only the story
changes, and the story is the entire reason for the row. Measured end to end,
with both ends reported, what is left is the genuine shortfall.

### Filtering the transaction list

The transactions heading is a toolbar: the heading on the left, a **search box**
in the middle, and a **− net pmts** toggle on the right.

Search matches the description and the account name, case-insensitively, so
`amazon` pulls every Amazon row across all cards. It filters as you type.
Only the rows are rebuilt on each keystroke, never the whole view — re-rendering
the lot would tear out the box mid-word and take the focus with it. Esc in the
box clears it rather than closing the view — the box swallows its own Esc, so
you get the search back before you lose the view. The search starts empty
each time the view opens, since a search is about the question you had a moment
ago. The toggle is a way of reading the list, so it stays as you left it.

**− net pmts** hides movements where both legs are visible: money leaving one
account and the same amount arriving in another, a few days apart. A credit card
payment is the usual case, and a transfer between accounts is the same shape.
They net to zero, so as a record of what was actually *spent* they are noise —
and they double-count the amount while they're there. The button shows how many
rows it will remove, and wears the same grey as those rows so the connection is
visible rather than something to work out. Its sign says what the *click* will
do rather than what the state is: `− net pmts` takes them out, `+ net pmts`
puts them back.

By default those rows are **shaded grey rather than removed** — the eye can skip
them, and you can still see the payment happened. The button takes them out
entirely when you want the list to be spending only.

Pairs are matched on five things: equal magnitude to the cent, opposite sign,
different accounts, dates within `PAIR_DAYS` (5) of each other, and the account
types lining up. Matching is greedy and one-to-one, so three $500 movements in a
week don't all cancel each other out.

The account types are what stop amount alone from lying. A $500 card purchase
and a $500 deposit three days apart are equal, opposite and in different
accounts — but they are not two halves of anything, and on amount alone both
would disappear. A real movement **leaves a bank**, and lands either **on a
card** (a payment) or **in another bank** (a transfer); money out of a *card* is
a purchase and can never be a leg. Where a build returns transactions with no id
we can resolve to an account, the type is unknowable and matching falls back to
amount alone.

Descriptions are deliberately not compared at all: the two legs are worded by
two different institutions ("CHASE CARD PAYMENT" against "Payment Thank You")
and rarely agree.

Above the rows, a tally reads `N of M transactions`, so a filter that hid more
than you expected is visible rather than silent. Every match is rendered — no
row cap, because a cap needs a "showing the first N" caveat to stay honest and
the list is a few hundred rows at worst.

`TXN_DAYS` (180) is never shorter than `SPARK_DAYS` (90), and here deliberately
longer. The graph selects into this list, so a shorter transaction window would
mean dragging over the older half of the chart silently finds nothing: whatever
you can point at, you can read. Running past the chart costs nothing and leaves
the list useful in its own right — though the reconciling rows only reach as far
back as the graph, since a transaction older than the series has no opening
balance to be measured against. If a selection does land before everything loaded — Empower
can cap the range server-side whatever you ask for — the empty state says
"nothing is loaded before <date>" rather than implying the days were empty.

### Where the history and transactions come from

The sparkline and detail view need data the accounts payload doesn't carry, so
these are fetched directly:

- `/api/account/getHistories` — daily balances, summed into net cash
- `/api/transaction/getUserTransactions` — transactions for cash and card accounts

Both feed the graph. The series is rebuilt from whatever is to hand each time
one of its three inputs — history, live balances, transactions — arrives or
moves on, so combining them stays one function's job rather than a set of
patches applied in whatever order they land.

Both need a valid CSRF token. Rather than scraping one, the script reads the
token out of the request bodies the dashboard itself posts. Response parsing is
deliberately tolerant of field-name changes across Empower's builds; if a call
fails, the tile keeps working and the detail view says why.

**Every day in the series sums the same accounts.** Accounts don't all sync
daily, and summing whatever reported on each date is silently wrong: a day where
a card didn't report drops that card's debt from the total, so net cash leaps up
and falls back the next day. Those aren't movements, they're reporting gaps
drawn as spikes — and they corrupt any comparison between two dates, which is
precisely what the 90-day figure is.

So `seriesFrom()` keeps a per-account balance, carries each account's last known
value forward across its gaps, and starts the series only once every account has
reported at least once. Before that point there is no honest total to draw, so
none is drawn — which is why the change label reports the span it actually
measured rather than assuming 90 days are available.

Carrying is now the last resort rather than the only option: where the dated
transactions account for a gap exactly, they walk the balance across it day by
day instead, and your live balances close the most recent gap. See "The graph is
drawn from the transactions" above.

## Hiding Empower's own cards

The panel also strips clutter from Empower's Overview page. Cards are matched on
**the words printed on them**, not CSS selectors — Empower's card titles are
plain `<div>`/`<span>` elements with generated class names that change between
builds, so markup is no anchor at all. Matching walks text nodes, then climbs to
the surrounding card. Every sweep re-matches from scratch, so cards stay hidden
through the SPA's re-renders and across page loads.

```js
const HIDE_TILES = ['Insights', 'Emergency Fund', 'Retirement Savings', 'Market Movers'];
```

For anything not worth naming, open the panel and click **Hide a card**: hover
highlights the card under the cursor, click hides it, Esc finishes. Those are
saved in `localStorage` and persist across sessions. **Show N hidden** reveals
everything again for the current page load.

Matching is a substring, so `'Emergency Fund'` also catches a card headed
"Emergency Fund Planning Guide". Narrow the phrase if that bites.

Guard rails: nav and header elements are never touched, nor is anything larger
than 85% of the viewport, so a bad match can't blank the page. Worst case,
reload — nothing is written to Empower.

## If it doesn't work

If the panel shows an error, it also lists the API URLs the page actually
called — that's the information needed to point it at the right host, since
Empower's API origin varies by account.

**Are these closing balances?** Nothing we read says so. `flattenHistory()`
takes the first field it recognises — `balance`, then `value`, then
`currentBalance`, then `amount` — and none of them is labelled posted-closing or
available-net-of-pending. In the live payload shape the question doesn't even
arise: `balances` is an object of one number per account per day, so there is
nothing to choose between. If a build *does* ship both, we would silently take
one and never know the other was there — and that difference would surface as
exactly the drift the reconciling rows report.

So Diagnose now reports the raw field names rather than the flattened point
(which can only show what we made of a row, never a field we dropped on the way
past): `historyProbe[].balanceShape.rowFields` lists what the history rows and
their nested points actually carry, and `accountBalanceFields` does the same for
the accounts payload. If either turns up an `availableBalance` next to a
`balance`, that is the thing to switch to and the drift should shrink.

`balanceShape.annotations` reads the sibling `"<id>Annotation"` strings that
`flattenHistory()` skips. They aren't numbers so they can't be summed, but a
note attached to a balance is exactly where a provider would mark it estimated,
pending or missing — worth reading before concluding a figure is wrong.

Two other things worth checking:

- **Sign flips.** If credit cards read backwards, adjust `normalise()`.
- **Excluded accounts.** Closed accounts and ones marked "exclude from
  household" are skipped; see `isLive()`.

## Caveats

- Unofficial and unsupported. The endpoint is Empower's internal API, not a
  published one, and can change without notice.
- Automated access to your account data may sit outside Empower's terms of use.
  This is read-only, manually triggered, and runs on data already rendered in
  your own browser session — but it's your call.
