# BUILD_NOTES — free-model-aggregator-01

Local scores from `node cli/makefun.mjs grade-local --kit . --bot <entry>
--driver process --instances 3` on the kit's practice trials 0–2. Docker is
not runnable on this VM (`docker ENOENT`), so the process driver is the only
local check; the entry is Node 22 stdlib-only, so it runs the same way in the
server's docker sandbox.

Leaderboard (checked 2026-11-14 11:42 WIB): 502 entries, top 5 all score 99.
#1 quality 99 calls 21; #2 quality 98 calls 21; #3–5 quality 98–99 calls 22.
Tie-break is upstream_calls, lower better. Bar: score 99, quality ≥98,
calls ≤21.

Scoring: `score = round((60·quality + 15·served + 10·wire + 10·failover +
5·catalog)/100)`. Quality 99 needs earned ≥ 37,866 of bound 38,248 (trial 0);
quality 98 + everything else at 100 still scores 99.

## Runs

| # | change | t0 | t1 | t2 | mean calls | mean quality |
|---|--------|----|----|----|-----------|--------------|
| 1 | starter baseline (house) | 38/14 | 44/14 | 38/14 | 14 | 40 |
| 2 | full entry, MCF plan λ=400, failover K=200 | 73/24 | 76/22 | 77/25 | 23.7 | 69.3 |
| 3 | fix: Anthropic client → OpenAI provider now translated (was passthrough; the provider echoed no system, no tools, no stops) | 99/24 | 99/22 | 99/25 | 23.7 | 99 |
| 4 | greedy slot plan λ=3000 (replaces MCF; the MCF's SPFA loops forever on a negative cycle at high λ, confirmed on real edges) | 99/23 | 99/21 | 99/23 | 22.3 | 98.7 |
| 5 | failover K=600 (from 200) | 99/22 | 99/22 | 99/23 | 22.3 | 98.3 |
| 6 | re-plan from current call counts before each request (K=200 again) | 99/23 | 99/21 | 99/23 | 22.3 | 98.7 |
| 7 | greedy λ=10000 | 99/23 | 99/21 | 99/24 | 22.7 | 98.3 |
| 8 | greedy λ=2000 | 99/23 | 99/21 | 99/23 | 22.3 | 98.7 |

Run 8's numbers are identical to run 6's; the plan is insensitive to λ in
2000–3000. **Final entry = run 6/8: greedy λ=3000, failover K=200,
adaptive re-plan.** (λ=3000 kept over λ=2000: same measured result, and
3000 is the value where the risk price first outweighs openrouter's rating
edge in the analysis below.)

Final: score 99 on all three trials; served 100, wire 100, failover 100,
catalog 100 on all three; quality 99/99/98; calls 23/21/23, mean 22.3.

## What the numbers say

- **Everything except calls is at max.** The only gap to the top 5 is the
  call count: 21–23 vs the bar of ≤21. One trial (t1) already hits 21.
- **The failures are the generator's, not the entry's.** The first call to
  any provider never refuses; the risk lives in call 2 (one provider is
  forced to fail there, and each provider draws 1–2 fail calls from
  [2, budget−1]) and in the later calls of the most-used provider. On the
  practice trials the plan's first attempts fail 1–3 times per trial
  (openrouter's call 2 and its calls 8–11 are the repeat offenders), and
  each failure costs exactly one extra call — the failover itself always
  succeeds (failover 100 on every run).
- **Why the plan concentrates on openrouter.** Openrouter's
  `z-ai/glm-5.3-flash:free` (1475) is the best free model for most requests.
  Spreading the load evenly would put the risky call-2s of the small-budget
  providers (zai, sambanova: budget 4–5, call-2 failure chance ~65%) into
  play; concentrating on the large-budget providers' later calls (prior
  failure chance ~20% each) has the lower expected failure count. The greedy
  plan uses openrouter 10 times, gemini twice, every other provider once.
  A min-cost-flow plan was tried and abandoned: its SPFA shortest-path
  search loops forever on a negative cycle when the risk price is high
  (reproduced on real edges in isolation; λ=400 completes, λ=3000 hangs).
  The greedy replacement is provably terminating and measures better
  (22.3 vs 23.7 mean calls).
- **Failover K and re-planning don't move the mean.** K=200 vs K=600 and
  static vs adaptive re-plan all land at mean 22.3 calls; the differences
  are which trial gains or loses one call. The remaining call count is set
  by the trial's own fail draws, which the scored instances (drand round
  33997812, drawn after close) will redraw. On a fresh draw this entry
  should land at 21–23 calls; 21 puts it in the top 5, 22 around rank 6–9.

## Known limits

- Docker driver cannot be run on this VM; only `--driver process` was used.
- The entry cannot re-derive the hidden draw from `MAKEFUN_TRIAL_SEED` (it
  is a u64 decimal string, not the generator seed), so it is purely
  adaptive: it learns from actual refusals, never from a predicted draw.
- `main.ts` was written in three separate write messages (entrypoint rule:
  ≥2 messages touching the entrypoint).
