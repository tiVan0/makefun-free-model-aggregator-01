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

## Run 9 — exact per-slot table + λ=6000 (new candidate, NOT yet submitted)

Trio (Groq answered; Kilo + Gemini as fallbacks — CoArena/OpenRouter
returned None, Token Lab 503) proposed probing / posterior / budget ideas.
All were tested in the simulator (policies.py, an entry-faithful harness:
re-plan before each request, conditional-ranked failover; it reproduces
runs 4-8 exactly: 23/21/23, q99/99/98). The measurable winner was none of
the trio's ideas as stated — it was a modelling error the trio's numbers
exposed: the analytic prior MISSED a structural dip. Scheduled fails are
drawn from [2, B-1] for the DRAWN budget, so a call number near a
provider's maximum budget is often cheap (cerebras/ovh call 5: 0.26 not
0.72; cloudflare call 7: 0.20 not 0.64; kilol calls 3-4: 0.13-0.14).
Exact per-slot table by Monte Carlo (N=20000 over the kit generator's own
draw, slotprob.py) + λ=6000 shifts the plan to openrouter 7, kilol 4,
cloudflare 2, gemini 1 (was OR 10, gemini 2): plan expected fails
2.27 -> 2.06, quality loss 339 -> 592. Perfect-execution quality drops
99 -> 98, but score stays 99 (quality 98 still scores 99: 98.8 rounds up).

Sim, 1000 fresh instances, PAIRED (same draws): mean calls 23.17 -> 22.93,
P(score 99 AND calls <= 21) 0.19 -> 0.25 (discordant 95 vs 151, McNemar
p<0.001); P(score 99) 0.91 -> 0.90. Real trials (sim): 22/23/21, q98/98/98.
Grade-local verification (14 Nov, --driver process, --instances 3): trial 0
score 99 q98 calls 22; trial 1 score 99 q98 calls 23; trial 2 score 99 q98
calls 21 — mean 22.0 (was 22.3), worst 23, served/wire/failover/catalog 100
on all three, replay matched on all three. Determinism: trial 0 run twice
independently, state.json hash identical
(eebb64af0159432493ef5b987c1f8872059e622a4e9e71d7fd582340a5754185) and scores
identical. EXACTLY as the sim predicted (22/23/21, q98/98/98).
Staging copy in ~/workspace/makefun/repo-agg/ is byte-identical (diff -r
clean, sha256 match). NOT submitted — awaiting Jo's stage-2 decision.
Caveat for the resubmit call: the win is in P(top5) on a FRESH draw
(0.19 -> 0.25 paired, significant), not in the practice mean alone; the
price is quality 99 -> 98 on the practice trials (score stays 99).

Rejected with measurements: posterior re-plan/failover (same mean 22.98,
mean quality down to 97.7, P(top5) 0.18-0.20); safe-first failover
(mean 23.85 — burning free slots on failovers hurts later first attempts);
spare pollinations (mean 23.63, P(top5) 0.25 on 150 but mean far worse);
exact table at λ=1500/3000 (no gain vs run 8). The trio's own savings
estimates were unvalidated guesses (Groq's EFP put kilol on r07/r08, which
need JSON that kilol cannot serve; its BASA sent r01/r02 to openrouter,
which has no vision model) — everything above is sim-measured, not
model-claimed.

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

## Round 3 — hill-climb polish (15 Nov ~21:30 WIB)

Goal: cut mean upstream calls 22.0 -> 20-21 at quality >= 98 (the only gap to
the top 5: they are 99/98/20, we are 99/98/22, dev rank #225/3000).

What was tried (sim, 3 practice trials + 1000 fresh instances, seed
Random(20261114); baseline = round-2 winner, greedy exact table lambda=6000,
failover K=200, re-plan every request: real 22/23/21 mean 22.00 q98, fresh
mean 22.93, mean_q 97.39, P(score99) 0.90, P(top5) 0.25):

- lambda sweep 4000/5000: real 21.67 (t1 23->22) BUT fresh worse (mean 23.02,
  P(top5) 0.22). Practice-trial noise; rejected.
- lambda 7000-12000: identical to baseline. No gain.
- Failover K 100/400/600/1000/2000/5000: real unchanged (22.00). K>=1000
  fresh mean 22.73, P(top5) 0.27; saturates at K~1000. Marginal only.
- Re-plan static: same as every (fresh 22.88, P(top5) 0.25). The re-plan
  drift hypothesis is false. Re-plan on_refusal only: real 26.00, fresh
  25.96 (quality up to 98.17 but calls explode); rejected decisively — the
  per-request re-plan is essential.
- Posterior failover (exact plan + fail_risk_posterior): real 22.33, fresh
  22.90. Worse; rejected (confirms round 2).
- Local search (greedy + hill-climb, qcap=650): real 22.67, fresh mean
  22.28 BUT P(score99) collapses 0.90 -> 0.73, P(top5) 0.19. The quality
  cap was too loose (plan loss 637 vs q98 budget 764); rejected.
- Local search, quality-guarded (qcap=550 and qcap=592, identical
  results): real 23/22/21 mean 22.00 q98/98/98; fresh (1000) mean 22.43,
  med 22, mean_q 97.77, P(score99) 0.95, P(top5) 0.35, P(<=20) 0.10.
  The win comes from hill-climbing the RE-PLANS, not the initial plan
  (qcap=550's initial plan is identical to greedy, yet the results differ).
  LS + K=1000: no further gain (P(top5) 0.34).

Chosen improvement (this change, lib/routing.ts only): `climbPlan` polishes
the greedy slot plan. The greedy prices slots in assignment (weight) order,
but calls happen in arrival order, so its expectation is optimistic; the
climb re-prices in arrival order (planMetrics) and repeatedly moves the
single request whose move to another provider cuts the expected refusals
most (ties: lowest quality loss), as long as plan quality loss stays within
PLAN_QUALITY_CAP = 592 — the greedy plan's own loss, so the climb never
sacrifices more quality than greedy already does. At most 8 moves,
deterministic (brief order, first strictly-best move wins). Runs inside
computePlan, so every per-request re-plan is polished too.

Verified end-to-end (grade-local, --driver process, --instances 3):
t0 99/98/23, t1 99/98/22, t2 99/98/21 -> mean 22.00, quality 98/98/98,
score 99 on all three; served/wire/failover/catalog 100. Matches the sim
exactly (23/22/21). One bug found and fixed during verification: computePlan
is also called at load time with startCalls undefined; planMetrics iterated
it and crashed (entry exited 1, all scores 0). Fixed by normalising
startCalls to an empty map inside climbPlan.

Caveat for the resubmit decision: the practice-trial mean is 22.00 — the
same as round 2, NOT below 22.0, so the strict "resubmit only if local <
22.0" gate is not met. The improvement is on fresh draws (the scored
trials are fresh draws from drand round 33997812): P(top5) 0.25 -> 0.35,
mean calls 22.93 -> 22.43, P(score99) 0.90 -> 0.95. Submitting replaces the
round-2 entry with one that is equal on practice and better on fresh.
