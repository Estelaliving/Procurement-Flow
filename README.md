# procurement-flow

Live dashboard for Estela Living's procurement/release process. Static site, no backend —
every page load (and every 45s after) fetches the 4 source systems directly from the browser,
joins them, and computes:

1. **Release Queue** — per house, whether Stage F / L / O / Q is due, not yet due, or already
   marked released.
2. **Budget vs WO Reconciliation** — every cost code with at least one released work order,
   compared line-by-line against the budget, flagging duplicates and amount mismatches.

Nothing is ever written back to the 4 source systems. The only thing this app writes anywhere
is its own state (which stages you've marked released, which reconciliation lines you've
reviewed) — stored in one small Supabase table, `procurement_flow_state`.

## Sources (read-only)

- Permit tracker — Supabase `permit_database` table (same project as `permitflow`)
- House release schedule — `.../prod/houserelease`
- House budget vs actual — `.../prod/housebudget`
- Work orders — `.../prod/workorders`

## One-time setup

1. In the Supabase SQL Editor (same project as permitflow — `raqiscditxkvgadiostr`), run:

   ```sql
   create table if not exists procurement_flow_state (
     id bigint primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table procurement_flow_state enable row level security;
   create policy "public read" on procurement_flow_state for select using (true);
   create policy "public insert" on procurement_flow_state for insert with check (true);
   create policy "public update" on procurement_flow_state for update using (true);
   ```

   Until this exists, the app still works, but "Mark released" / "Mark reviewed" won't
   survive a page reload.

2. Create an empty GitHub repo (e.g. `estelaliving/procurement-flow`), push this folder to it,
   then enable GitHub Pages (Settings → Pages → Deploy from branch → `main` / root) — same as
   `permitflow` and `house-release-tracker`.

## Known assumptions to confirm

- **Address is the join key** between the permit tracker and the other 3 systems (there's no
  shared house number). Normalized as "text before the first comma, uppercased." Any address
  formatting drift between the two systems will cause a house to silently not show permit info.
- **Stage F rule**: `permitStatus` is anything other than `presubmit` (i.e. `applied`,
  `issued`, or `co`). "Days since submitted" is shown for prioritization.
- **"Already released" is tracked entirely by us** (the Mark released checkbox), not inferred
  from `houserelease.wostage`/`release_date` — those fields' meaning wasn't clearly a reliable
  "has this stage already been released" signal from the sample data, so first load will show
  a large backlog of "due now" items across every house's history until each is checked off.
  Worth a bulk pass together the first time this goes live.
- **Reconciliation tolerance**: ≤$200 diff = OK, $200–300 = Caution, >$300 = Flagged (applied to
  `|WO total − budget|` per cost code); more than one WO per house+cost-code = Duplicate.
- Saw a `stagecode` value of `"I"` in the work orders data (outside F/L/O/Q) — displayed as-is,
  doesn't affect any logic, just flagging in case it's meaningful to you.
