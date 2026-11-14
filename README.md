# Free Model Aggregator — make.fun free-model-aggregator-01

One server that serves the OpenAI Chat Completions API and the Anthropic
Messages API over ten simulated free-tier model providers, in JSON and in
server-sent events, and registers the catalog it read from them. Node 22,
standard library only, no dependencies.

## Run

```
node main.ts
node main.ts --list
```

`--list` prints the catalog the server registered (the same document the
register body carries) and exits 0 before any server starts. Otherwise the
server probes every provider's catalog route, builds one catalog, registers
with the environment, serves `GET /v1/models`, `POST /v1/chat/completions`
and `POST /v1/messages`, and exits 0 when the environment says the workload
is done.

The environment tells the server where to listen through `MAKEFUN_ENV_URL`
and what to read through `MAKEFUN_PROMPT_FILE`; the trial seed and the clock
are given the same way. Nothing else is configured.

## How it answers

Each of the twenty requests is answered with the best free model that can
serve it:

- **Catalog.** The server probes each provider's catalog route on its own
  wire (OpenAI `/v1/models`, Anthropic `/v1/models`, Gemini
  `/v1beta/models`), keeps only the models the ratings table marks free, and
  registers exactly that set. The base URL it registers is the directory
  path `/p/<provider id>`, never the environment's URL joined in.
- **Plan.** A greedy slot plan assigns one provider per request, in weight
  order (the weight-2 rows first). A slot's cost is the risk price times the
  prior chance that call number refuses, minus the request's weight times the
  best rating that provider can serve it with. A provider's next call grows
  dearer as its call number rises, so the load spreads instead of piling
  onto the highest-rated provider. Before each request the plan is remade
  from the calls made so far, so a call a failover spent is priced into the
  requests still to come instead of being forgotten.
- **Failover.** When the planned provider refuses (402, 429 or 5xx), the
  request is retried on the next candidate ranked by rating minus the chance
  its next call refuses, given the trial so far. A provider that refused
  twice in a row is out. The first call to any provider never refuses by
  construction, so the plan's first calls are safe; the risk lives in the
  second and later calls, and the small-budget providers are the riskiest
  there.
- **Wires.** Both client wires are translated to all three provider wires
  and back, echo-faithful: the system prompt, the last user message, the
  tool names in order, the output cap, the stop sequences, the image and the
  JSON mode all survive the round trip, because the client checks each of
  them against what it sent. An Anthropic client going to an OpenAI provider
  is rewritten into the OpenAI shape (and the other way round); a Gemini
  provider is called with the model in the URL path. OpenAI streams get
  `stream_options.include_usage`, without which the provider emits no usage
  chunk and the usage check fails. Same-wire streams pipe through byte for
  byte; cross-wire streams are read whole and re-emitted in the client's
  event order. Usage is reported as the provider reported it, and the stop
  reason is always the family-0 stop of the client's wire.

The server is deterministic: every choice is a function of the brief, the
requests and the providers' answers. No wall clock, no unseeded randomness.

## Files

- `main.ts` — the entrypoint: probe, catalog, plan, register, serve, poll.
- `lib/providers.ts` — the brief (three JSON documents by schema), the
  catalog probe per wire, the catalog builder, the free-model table.
- `lib/wire.ts` — both client wires and all three provider wires: request
  translation, answer translation, stream translation, model lists, errors.
- `lib/routing.ts` — the budget table, the prior and conditional refusal
  chances, the best model per provider, the greedy slot plan, the failover
  ranking.
- `BUILD_NOTES.md` — the measured local scores, run by run.

## Local score (practice trials 0–2, `--driver process`)

| run | score | quality | served | wire | failover | catalog | calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| final (λ=3000, K=200) trial 0 | 99 | 99 | 100 | 100 | 100 | 100 | 23 |
| final trial 1 | 99 | 99 | 100 | 100 | 100 | 100 | 21 |
| final trial 2 | 99 | 98 | 100 | 100 | 100 | 100 | 23 |
| **mean** | **99** | **98.7** | **100** | **100** | **100** | **100** | **22.3** |

The leaderboard bar is score 99 with at most 21 upstream calls. This entry
scores 99 on all three practice trials; its call count is 21–23, mean 22.3.
See `BUILD_NOTES.md` for the full history and why the call count is the
binding constraint.
