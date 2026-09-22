# procurement-flow

Live dashboard for Estela Living's procurement/release process. Static site, no backend —
every page load (and every 45s after) fetches the 4 source systems directly from the browser,
joins them, and computes:

1. **Release Queue** — per house, whether Stage F / L / O / Q is due, not yet due, or blocked
   behind an earlier stage. This is a pure mirror of the source APIs: a house's current stage
   comes 100% from `houserelease.wostage`, `permitStatus`, and the schedule dates, recomputed
   every refresh. Nothing clicked in this tool ever changes what stage a house is considered to
   be at — that only changes when the real systems change.
2. **Budget vs WO Reconciliation** — every cost code with at least one released work order,
   compared line-by-line against the budget, flagging duplicates and amount mismatches. The 14
   cost codes that depend on lot size/site conditions (see below) are tagged **Job-Specific** —
   their OK/Caution/Flagged badge isn't meaningful for those, so they always carry a separate
   "reviewed against drawings/site" checkbox regardless of amount status. A dedicated
   **Job-Specific** filter widens the table to every house's line for those 14 codes even before
   a work order exists, since the budget itself needs checking against drawings from day one.
   This used to be a separate tab; it's one table now so there's nowhere else to check.

Nothing is ever written back to the 4 source systems. The only things this app writes anywhere
are purely informational bookkeeping — a personal "I released this" note (has zero effect on
anything computed), which reconciliation lines you've reviewed, and which job-specific lines
you've checked against drawings — stored in one small Supabase table, `procurement_flow_state`.

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

   Until this exists, the app still works fully — release status is always computed live from
   the APIs regardless — but the "I released this" notes and "Mark reviewed" checkmarks won't
   survive a page reload.

2. Create an empty GitHub repo (e.g. `estelaliving/procurement-flow`), push this folder to it,
   then enable GitHub Pages (Settings → Pages → Deploy from branch → `main` / root) — same as
   `permitflow` and `house-release-tracker`.

## Known assumptions to confirm

- **Address is the join key** between the permit tracker and the other 3 systems (there's no
  shared house number). Normalized as "text before the first comma, uppercased." Any address
  formatting drift between the two systems will cause a house to silently not show permit info.
- **Stage F rule**: `permitStatus === "applied"` only (actively under city review). `presubmit`
  means not submitted yet; `issued`/`co` means the city review window has already passed —
  either way it's excluded from the F queue.
- **A house only ever has one actionable stage at a time, derived purely from the API.**
  `houserelease.wostage` is the source system's own "what stage is this house currently at"
  marker and is the sole source of truth: any stage at or before `wostage` is already passed.
  The next stage after `wostage` is evaluated against its real condition (permit status /
  schedule date); everything further out is blocked behind it. This tool has no memory of its
  own that affects any of this — nothing you click here can advance a house. If `wostage` hasn't
  caught up to reality yet, this queue won't either, by design.
- **Reconciliation tolerance**: ≤$200 diff = OK, $200–300 = Caution, >$300 = Flagged (applied to
  `|WO total − budget|` per cost code); more than one WO per house+cost-code = Duplicate.
- Saw a `stagecode` value of `"I"` in the work orders data (outside F/L/O/Q) — displayed as-is,
  doesn't affect any logic, just flagging in case it's meaningful to you.
- **Job-specific codes** (lot size / site condition dependent, reviewed by drawings rather than
  a dollar tolerance): `200-01, 230-01, 230-03, 300-01, 310-01, 310-02, 430-01, 430-02, 430-03,
  430-04, 430-05, 430-06, 435-01, 435-02`.
