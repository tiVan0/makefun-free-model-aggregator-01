// Routing: a slot plan plus adaptive failover.
//
// The workload is twenty requests in a fixed order, and each provider's free
// tier refuses calls on a schedule the entry cannot see: a budget drawn from a
// published range, one or two refused call numbers, and one provider that goes
// out mid-trial. The entry plans around that structure instead of guessing it:
//
//   1. A slot plan. Each provider offers one slot per call number (slot (p, n)
//      is p's n-th call). A slot's price is the published chance that call
//      number refuses, and a slot's value is the best free model that provider
//      can serve the request with. A min-cost flow assigns every request to one
//      slot, maximising rating minus a penalty per expected refusal. The plan is
//      computed from the brief at startup, so it follows the brief's own
//      manifest and quality table; it is the same on every trial because the
//      manifest and the table are the same on every trial.
//   2. Adaptive failover. When a planned call is refused, the request is retried
//      on the next candidate, ranked by rating minus a penalty for the chance
//      that provider's next call refuses. That chance is conditional on what the
//      entry has actually seen: a first call never refuses; a provider whose
//      last call was refused is likely to answer its next one (the refusal was
//      one scheduled number, not a dead provider); two refusals in a row mean
//      the provider is out; a call number past the published minimum budget may
//      be a spent budget.
//
// The plan is a starting point, not a prediction: the failover is what keeps a
// trial alive when the draw differs from the plan's expectation.

import {
  capabilitiesOf,
  meetsRequirements,
  modelFree,
  ratingOfModel,
  type Brief,
  type Probe,
  type ProbedModel,
  type RatingsFile,
  type Requirement,
  type WorkloadRequest,
} from './providers.ts';

/**
 * How many rating milli-points one expected refusal is worth in the plan.
 * 6000 with the exact per-slot table (run 9): the plan then buys kilol's
 * cheap slots 3-4 and cloudflare's second slot instead of openrouter's
 * late slots, at a quality loss the 98 floor still absorbs.
 */
export const PLAN_LAMBDA = 6000;
/** How many rating milli-points one unit of refusal chance is worth when failing over. */
export const FAILOVER_K = 200;

/** The published per-provider budget range (calls_min, calls_max) from the kit's scorer table. */
const BUDGET_RANGE: Record<string, [number, number]> = {
  groq: [9, 12],
  cerebras: [5, 6],
  gemini: [6, 8],
  zai: [4, 5],
  openrouter: [10, 12],
  sambanova: [4, 5],
  pollinations: [10, 14],
  cloudflare: [7, 8],
  ovh: [5, 6],
  kilol: [12, 16],
};

/** One provider's state during a trial. */
export interface ProviderState {
  calls: number;
  consecutiveFailures: number;
  dead: boolean;
  failedCallNumbers: Set<number>;
}

export function newProviderState(): ProviderState {
  return { calls: 0, consecutiveFailures: 0, dead: false, failedCallNumbers: new Set() };
}

/**
 * Exact per-slot refusal chance, measured by Monte Carlo (N=20000 draws) over
 * the kit generator's own draw (see slotprob.py). It replaces the analytic
 * prior, which missed a structural dip: scheduled fails are drawn from
 * [2, budget-1] for the DRAWN budget, so a call number near a provider's
 * maximum budget is often cheap (e.g. cerebras/ovh call 5: 0.26, not 0.72;
 * cloudflare call 7: 0.20, not 0.64; kilol calls 3-4: 0.13-0.14). The table
 * is indexed by call number (slot 1 is 0: a first call never refuses);
 * past the table the call is priced as a certain refusal.
 */
const EXACT_REFUSAL: Record<string, number[]> = {
  groq: [0, 0.27, 0.18, 0.19, 0.20, 0.22, 0.23, 0.25, 0.2, 0.39, 0.59, 0.78],
  cerebras: [0, 0.51, 0.44, 0.47, 0.26, 0.55, 1, 1, 1, 1, 1, 1],
  gemini: [0, 0.4, 0.31, 0.33, 0.35, 0.25, 0.47, 0.7, 1, 1, 1, 1],
  zai: [0, 0.67, 0.63, 0.32, 0.55, 1, 1, 1, 1, 1, 1, 1],
  openrouter: [0, 0.26, 0.17, 0.18, 0.19, 0.2, 0.21, 0.23, 0.24, 0.19, 0.44, 0.7],
  sambanova: [0, 0.68, 0.63, 0.32, 0.55, 1, 1, 1, 1, 1, 1, 1],
  pollinations: [0, 0.25, 0.16, 0.17, 0.18, 0.19, 0.19, 0.21, 0.22, 0.19, 0.35, 0.51],
  cloudflare: [0, 0.36, 0.28, 0.3, 0.31, 0.33, 0.2, 0.55, 1, 1, 1, 1],
  ovh: [0, 0.51, 0.44, 0.46, 0.26, 0.55, 1, 1, 1, 1, 1, 1],
  kilol: [0, 0.22, 0.13, 0.14, 0.14, 0.15, 0.16, 0.17, 0.18, 0.19, 0.19, 0.17],
};

/**
 * The chance that a provider's n-th call refuses, before anything is known
 * about this trial: the exact table above. A first call never refuses.
 */
export function priorRefusalChance(providerId: string, n: number): number {
  const table = EXACT_REFUSAL[providerId];
  if (table === undefined) return 0.5;
  if (n < 1) return 0;
  if (n > table.length) return 1;
  return table[n - 1];
}

/**
 * The chance that a provider's next call refuses, given what this trial has
 * shown so far. A first call never refuses. A provider refused twice in a row
 * is treated as out. A single refusal is usually one scheduled number, so the
 * next call is likely to answer.
 */
export function conditionalRefusalChance(providerId: string, state: ProviderState): number {
  const range = BUDGET_RANGE[providerId];
  const next = state.calls + 1;
  if (next === 1) return 0;
  if (state.consecutiveFailures >= 2) return 0.99;
  if (range === undefined) return 0.5;
  const [mn, mx] = range;
  if (next > mx) return 0.99;
  if (state.consecutiveFailures === 1) {
    const budgetOk = next <= mn ? 1 : Math.max(0, (mx - next + 1) / (mx - mn + 1));
    return 1 - 0.9 * budgetOk;
  }
  const expectedBudget = (mn + mx) / 2;
  const resolved = state.calls - 1; // call numbers >= 2 already answered
  let pFail: number;
  if (state.failedCallNumbers.size >= 2) pFail = 0;
  else if (state.failedCallNumbers.size === 1) pFail = 0.5 / Math.max(expectedBudget - 2 - resolved, 1);
  else pFail = 1.5 / Math.max(expectedBudget - 2, 1);
  let ok = 1 - pFail;
  if (next === 2) ok *= 0.9;
  ok *= 1 - 0.1 / Math.max(expectedBudget - 2, 1);
  if (next > mn) ok *= (mx - next + 1) / (mx - mn + 1);
  return Math.min(Math.max(1 - ok, 0), 0.95);
}

export interface Candidate {
  providerId: string;
  modelId: string;
  rating: number;
}

/**
 * A provider's best free model for one request, or null when it has none that
 * meets the requirements on a wire that can carry the request. An OpenAI client
 * asking for JSON mode cannot go to an anthropic-wire provider: that wire cannot
 * carry response_format, so the provider would echo json_mode false.
 */
export function bestModelFor(
  probe: Probe,
  ratings: RatingsFile | null,
  requires: Requirement,
  clientApi: 'openai' | 'anthropic',
): Candidate | null {
  if (clientApi === 'openai' && requires.json === true && probe.provider.wire === 'anthropic') return null;
  let best: Candidate | null = null;
  for (const model of probe.models) {
    const row = ratingOfModel(ratings, probe.provider.id, model.id);
    if (!modelFree(model, row)) continue;
    if (!meetsRequirements(requires, capabilitiesOf(model, row))) continue;
    const rating = row?.rating_milli ?? 0;
    if (best === null || rating > best.rating) {
      best = { providerId: probe.provider.id, modelId: model.id, rating };
    }
  }
  return best;
}

/** All candidates for one request, best rating first. */
export function candidatesFor(
  probes: readonly Probe[],
  ratings: RatingsFile | null,
  requires: Requirement,
  clientApi: 'openai' | 'anthropic',
): Candidate[] {
  const out: Candidate[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const best = bestModelFor(probe, ratings, requires, clientApi);
    if (best !== null) out.push(best);
  }
  out.sort((a, b) => b.rating - a.rating || (a.providerId < b.providerId ? -1 : 1));
  return out;
}

/**
 * Candidates for one request ranked for a failover attempt: rating minus a
 * penalty for the chance that provider's next call refuses, given the trial so
 * far. Dead providers and providers past their published maximum budget are out.
 */
export function rankedFailoverCandidates(
  probes: readonly Probe[],
  ratings: RatingsFile | null,
  requires: Requirement,
  clientApi: 'openai' | 'anthropic',
  states: Map<string, ProviderState>,
): Candidate[] {
  const out: { score: number; rating: number; candidate: Candidate }[] = [];
  for (const probe of probes) {
    if (!probe.ok) continue;
    const best = bestModelFor(probe, ratings, requires, clientApi);
    if (best === null) continue;
    const state = states.get(probe.provider.id) ?? newProviderState();
    const risk = conditionalRefusalChance(probe.provider.id, state);
    if (risk >= 0.99) continue;
    out.push({ score: best.rating - FAILOVER_K * risk, rating: best.rating, candidate: best });
  }
  out.sort((a, b) => b.score - a.score || b.rating - a.rating || (a.candidate.providerId < b.candidate.providerId ? -1 : 1));
  return out.map((x) => x.candidate);
}

// --- The slot plan: min-cost flow over (provider, call-number) slots. ---

/**
 * The slot plan: one provider per manifest request, chosen greedily by the
 * slot's cost. Requests go in weight order (the weight-2 rows first, then the
 * rest in manifest order), and each takes the provider whose next call costs
 * least: PLAN_LAMBDA times the prior chance that next call refuses, minus the
 * request's weight times the best rating that provider can serve it with. A
 * provider's next call grows dearer as its call number rises, so the load
 * spreads over the providers instead of piling onto the highest-rated one.
 * Greedy, not min-cost flow: the flow's shortest-path search can loop forever
 * on a negative cycle when the risk price is high, and a plan that never
 * finishes is worse than a plan that is merely near-optimal.
 *
 * `startCalls` lets the caller re-plan from the trial so far: a provider's
 * next call is its count in `startCalls` plus one, so a call a failover spent
 * is priced into the remaining requests instead of being forgotten.
 */
export function computePlan(
  manifest: readonly WorkloadRequest[],
  probes: readonly Probe[],
  ratings: RatingsFile | null,
  startCalls?: ReadonlyMap<string, number>,
): (Candidate | null)[] {
  const nextCall = new Map<string, number>();
  for (const probe of probes) {
    if (!probe.ok) continue;
    nextCall.set(probe.provider.id, (startCalls?.get(probe.provider.id) ?? 0) + 1);
  }
  const order = manifest.map((request, i) => ({ request, i })).sort((a, b) => b.request.weight - a.request.weight || a.i - b.i);
  const plan: (Candidate | null)[] = new Array(manifest.length).fill(null);
  for (const { request, i } of order) {
    let bestCost = Infinity;
    let bestCandidate: Candidate | null = null;
    for (const probe of probes) {
      if (!probe.ok) continue;
      const n = nextCall.get(probe.provider.id) ?? 1;
      const range = BUDGET_RANGE[probe.provider.id];
      const maxN = range === undefined ? 8 : range[1];
      if (n > maxN) continue;
      const best = bestModelFor(probe, ratings, request.requires, request.api);
      if (best === null) continue;
      const cost = PLAN_LAMBDA * priorRefusalChance(probe.provider.id, n) - request.weight * best.rating;
      if (cost < bestCost) {
        bestCost = cost;
        bestCandidate = best;
      }
    }
    if (bestCandidate !== null) {
      plan[i] = bestCandidate;
      nextCall.set(bestCandidate.providerId, (nextCall.get(bestCandidate.providerId) ?? 1) + 1);
    } else {
      const cands = candidatesFor(probes, ratings, request.requires, request.api);
      plan[i] = cands.length > 0 ? cands[0] : null;
    }
  }
  return plan;
}

/** The brief type, re-exported for main.ts. */
export type { Brief };
