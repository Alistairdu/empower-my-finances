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

Under the graph, the **change over each window** sits at the two bottom corners
exactly as Empower's does: roughly 90-day on the left, 1-day on the right, red
below zero and green above. Each is measured against the history point *nearest*
that many days back, never an index offset — the series has gaps (weekends, a
missed sync) and counting rows would slide the window onto the wrong dates. The
label reports the span actually measured, so a short history reads "60-day"
instead of claiming 90.

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
at once, in `visibleTxns()`.

### Filtering the transaction list

The transactions heading is a toolbar: the heading on the left, a **search box**
in the middle, and a **− net payments** toggle on the right.

Search matches the description and the account name, case-insensitively, so
`amazon` pulls every Amazon row across all cards. It filters as you type.
Only the rows are rebuilt on each keystroke, never the whole view — re-rendering
the lot would tear out the box mid-word and take the focus with it. Esc in the
box clears it rather than closing the view — the box swallows its own Esc, so
you get the search back before you lose the view. The search starts empty
each time the view opens, since a search is about the question you had a moment
ago. The toggle is a way of reading the list, so it stays as you left it.

**− net payments** hides movements where both legs are visible: money leaving one
account and the same amount arriving in another, a few days apart. A credit card
payment is the usual case, and a transfer between accounts is the same shape.
They net to zero, so as a record of what was actually *spent* they are noise —
and they double-count the amount while they're there. The button shows how many
rows it will remove, and wears the same grey as those rows so the connection is
visible rather than something to work out. Its sign says what the *click* will
do rather than what the state is: `− net payments` takes them out, `+ net
payments` puts them back.

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

`TXN_DAYS` is deliberately tied to `SPARK_DAYS` rather than set independently.
The graph selects into this list, so a shorter transaction window means dragging
over the older half of the chart silently finds nothing: whatever you can point
at, you can read. If a selection does land before everything loaded — Empower
can cap the range server-side whatever you ask for — the empty state says
"nothing is loaded before <date>" rather than implying the days were empty.

### Where the history and transactions come from

The sparkline and detail view need data the accounts payload doesn't carry, so
these are fetched directly:

- `/api/account/getHistories` — daily balances, summed into net cash
- `/api/transaction/getUserTransactions` — transactions for cash and card accounts

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
