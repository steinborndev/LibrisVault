# TASKS-A5 - Plan-percent quota (2026-09-06)

Goal: the Fellows' consumption is measured in the plan's own unit, utilization points of
the 5-hour and 7-day windows, the service learns points per USD per model, proposals are
priced in points, and the gate refuses a step when the research share or a reserve leaves
no room. **Acceptance (docs/agents/SPEC.md section 15): a step is refused when the share
is used up; the recap shows points per run; `npm test` green on both sides.**

Extension milestone in the Curious fork (branch `research-agents`), everything behind
`AGENTS_ENABLED=1`. Findings recorded here, spec first when the code disagrees.

## 0. Decisions while wiring A5

- **D1 - three sources, one monitor.** `pipeline/usage-monitor.ts` keeps the latest sample
  per window. Sources in the spec's order: the SDK's `usage()` method sampled inside every
  Fellow run right after the session started and right after the result arrived (the
  runner exposes an `onPlanUsage` hook); `rate_limit_event` messages during a run; the raw
  usage endpoint for ticks and the dashboard, cached 3 minutes. Every sample goes to
  `usage_samples` (v20) with its window, phase and source.
- **D2 - the delta lives on the run.** The runner puts the before and after samples on the
  run result; the maintenance runner stores the per-window delta on the run row
  (`agent_runs.plan_pct_delta`, v20, json). Calibration is a running median of
  `delta / cost_usd` per model and window over the last 50 runs that carry both; three runs
  make a calibration, fewer are shown as provisional. Amended after F2 and F4: the "before"
  of the delta is the monitor's newest sample from at most three minutes before the run
  when there is one (the previous run's "after" in a shift), else the run's own first
  sample; the "after" is the run's last sample.
- **D3 - USD-equivalent fallback.** Without plan data (an API key, or an OAuth token
  without the `user:profile` scope, which is what the service's setup token turned out to
  lack) the shares still gate, in USD: the section 16 reference values (week about 1000
  USD, 5-hour window about 80 USD list price, both settings: `planWeekUsd`, `plan5hUsd`)
  turn the percent shares into USD budgets, consumption is the Fellows' USD in the last 7
  days and the last 5 hours. Once calibrated, points take over per window. The reserves
  need a measured utilization and stay off without one.
- **D4 - the gate.** The Fellow service's gate takes the run's estimated cost, model and
  kind; the monitor answers: reserve 5h (latest utilization above `reserve5hPct`), reserve
  week, share week (consumed plus the estimate above `researchShareWeekPct`), share 5h.
  Manual research runs from the Research screen stay outside (section 8.2). A refusal names
  the share or reserve and, when known, the reset time; the shift puts the Fellow to sleep
  with the new code `plan` and wakes it at the reset. Amended while testing: planning runs
  go through the same gate with their own estimate (they spend plan points too, and the
  reserves protect the user's own use); only the runs-per-day quota skips them. A refused
  manual step (card, API) is a 409 and leaves the Fellow's state alone.
- **D5 - waiting for a reset.** Inside the night window the shift waits for a 5-hour reset
  that lies within the window (at most until the window's end) before it tries the
  refused Fellows again (section 8.5), through an injectable sleep so the tests run dry.
- **D6 - points everywhere they belong.** Proposals get `est_plan_pct` from the week's
  points per USD when calibrated; the card's week line and the recap's per-run lines show
  points; the recap header shows utilization now (5-hour, week, the model buckets), the
  research share consumed this week against the share, and how many standard steps still
  fit; the spawn dialog shows the projected percent of the week once calibrated.
- **D7 - endpoints.** `GET /usage/plan` (availability and source, windows, calibration,
  shares and reserves with consumption, the gate's answer for a standard step on the
  default model, the reference values) and `GET /usage/samples`.
- **D8 - the dashboard.** System gets a "Plan" panel under usage with the windows, the
  shares and the calibration; the Library's now chip shows the week's share; the Spawn form
  shows the projection.

## 1. Server

- [x] Migration v20; `db/usage-samples.ts`; `agent_runs.plan_pct_delta`; settings keys
      `researchShareWeekPct`, `researchShare5hPct`, `reserve5hPct`, `reserveWeekPct`,
      `planWeekUsd`, `plan5hUsd`.
- [x] `agent-runner.ts`: `onPlanUsage` (samples through the SDK method, guarded, see F2),
      `rate_limit_event` forwarding; `AgentRunResult.planUsage`.
- [x] `usage-monitor.ts`: samples, latest per window, the baseline, endpoint fetch with
      the 3-minute cache, deltas, calibration medians, consumption per window, the gate,
      estimates, the reset times from events (F3).
- [x] Maintenance runner: samples and the delta on the run row, one run log line per
      sample; Fellow service: gate, pricing, sleep code `plan`, the week's points on the
      card; shift: wait for a reset, endpoint refresh before a round.
- [x] Recap: points per run, the header lines; routes `GET /usage/plan`, `GET /usage/samples`;
      wiring (the endpoint fetch only in OAuth mode, the token never logged).

## 2. Dashboard

- [x] Types and client; System's Plan panel; the Library now chip; the Spawn form's
      projection; the card's points. The six plan settings stay API keys (the settings
      editor does not carry the Fellow settings of A1 and A2 either).

## 3. Tests and validation

- [x] Server: parsing of the three sources, deltas and medians, the baseline, consumption
      against window resets, the gate in every mode (unavailable, USD fallback,
      calibrated, reserves), the endpoint cache and single flight, the runner hooks with
      a fake query (windows arriving late, throttle, text-only and turn-summary samples,
      no windows at all), the shift's reset wait and the `plan` sleep, the whole path from
      fake samples to run rows, calibration, priced proposals, the card and a refusal in
      points, recap rendering, the sqlite sample store, routes.
- [x] Web: the projection helper and the share line.
- [x] Real check in the dev instance (2026-09-06, Ada, sonnet-5):
      - The raw usage endpoint refuses the service's setup token: `permission_error`,
        "OAuth token does not meet scope requirement user:profile"; the plan status
        reports it as the reason and accounts in USD-equivalent (D3).
      - The SDK's usage method does report the windows for the same token, from the API's
        rate-limit headers (F1, F2): 5-hour 16 to 25 percent, week 42 to 43 percent, with
        reset stamps, `subscription_type` null. Three probe sessions on Haiku (0.002 to
        0.04 USD each) established when the windows appear (F2).
      - A planning run before the fix: only "after" samples, no delta. After the fix: a
        0.34 USD planning run with "before" (25, 43) and "after" (25, 43) samples and the
        delta `{five_hour: 6, seven_day: 1}` on its row, diffed against the previous
        run's sample six minutes earlier; the six points are mostly the interactive
        session that ran in that gap (F4), hence the three-minute baseline. Calibration
        after one run: provisional (n = 1), the card shows 1 point of the week.
      - A step refused by a share set low: `researchShareWeekPct` 1 (10 USD of the
        1000 USD reference week) with 12.92 USD consumed answers 409 "the research share
        of the week is used up (12.92 of about 10 USD, this step about 2 USD)"; the plan
        status carries the same verdict, the Fellow's state stays `waiting`; the setting
        restored to the default.
      - A forced recap (summary run 0.31 USD) stores the plan block with the USD shares
        (12.92 of 100 USD this week, 43 standard steps left); the per-run lines show no
        points yet because those runs predate the measurement.

## 4. Findings

- **F1 - the SDK reports the windows even where the endpoint refuses.** The usage method
  answers `rate_limits_available: true` for this token; its windows come from the API's
  rate-limit response headers, not from the claude.ai usage endpoint, so the missing
  `user:profile` scope only takes the endpoint fallback away. The parser treated "available
  but no windows" as available-with-null-reason; fixed to name the case.
- **F2 - when the windows appear.** The sample before the session's first request carries
  `rate_limits: null`. The SDK streams a response as one assistant message per content
  block (thinking, tool_use, text) and the windows are set when the response completes:
  in a session with a tool call, the thinking block's sample had none, the tool call's
  sample had them. After the result message the method fails with "Query closed before
  response received". The runner therefore samples on assistant messages until one carries
  windows (up to six tries), then every 30 seconds and always on a text-only message or the
  SDK's `post_turn_summary` note, and the last sample is the "after".
- **F3 - rate-limit events carry the reset, not the utilization.** Every session emitted
  one `rate_limit_event` for the 5-hour window with `status`, `resetsAt` (epoch seconds)
  and overage flags, no `utilization`. The monitor keeps the reset times from these, so
  the consumption windows and refusals know when the window turns even without a
  utilization sample.
- **F4 - noise in the delta.** Utilization is integer percent, and everything the account
  does between two samples lands in the delta. The baseline window is three minutes for
  that reason; the median over runs is what calibrates, and the night shift's back-to-back
  runs are the clean measurements.
- **F5 - the token.** `claude setup-token` with the installed CLI (2.1.197) references the
  `user:profile` scope; a regenerated token may unlock the endpoint fallback (ticks between
  runs, the dashboard's windows without a run). Not done in this milestone; the SDK path
  covers the Fellows.
