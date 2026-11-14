// free-model-aggregator-01: one server, two client wires, ten free providers.
//
// The entry reads the trial's brief, probes each provider's catalog route, builds
// one catalog, registers with the env, and answers the twenty requests the
// client's workload sends, in order. Each request is answered with the best free
// model that can serve it: a slot plan (lib/routing.ts) picks the provider, and
// when that provider refuses, the request fails over to the next candidate
// ranked by rating minus the chance its next call refuses. The answer is
// returned in the wire the client used, JSON or server-sent events, with the
// provider's text whole, its usage counts as that wire reports them, and its
// stop reason mapped to the client's wire. `node main.ts --list` prints the
// catalog and exits 0 before any server starts.
//
// The entry is deterministic: every choice is a function of the brief, the
// requests and the providers' answers. No wall clock, no unseeded randomness.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  authHeaders,
  buildCatalog,
  capabilitiesOf,
  isRecord,
  joinBase,
  meetsRequirements,
  modelFree,
  probeProvider,
  ratingOfModel,
  readBrief,
  type CatalogReport,
  type Json,
  type Probe,
  type ProbedModel,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicModelList,
  anthropicStreamToOpenAI,
  anthropicToGemini,
  anthropicToOpenAI,
  anthropicToOpenAIAnswer,
  geminiStreamToAnthropic,
  geminiStreamToOpenAI,
  geminiToAnthropic,
  geminiToOpenAI,
  openAIError,
  openAIModelList,
  openAIStreamToAnthropic,
  openAIToAnthropic,
  openAIToAnthropicRequest,
  openAIToGemini,
  readSseFrames,
  type ServedModel,
} from './lib/wire.ts';
import {
  bestModelFor,
  computePlan,
  conditionalRefusalChance,
  newProviderState,
  rankedFailoverCandidates,
  type Candidate,
  type ProviderState,
} from './lib/routing.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** How long one provider's catalog probe may take, in milliseconds. */
const PROBE_TIMEOUT_MS = 5000;
/** The most bytes of one client request body this entry reads. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';

const brief = readBrief(PROMPT_FILE);
let probes: Probe[] = [];
let catalog: CatalogReport = { providers: [] };
/** The slot plan: one planned candidate per manifest request, in arrival order. */
let plan: (Candidate | null)[] = [];
/** How many client API requests have arrived: the manifest is in arrival order. */
let manifestIndex = 0;
/** Per-provider trial state: calls made, refusals seen, whether it is out. */
const providerStates = new Map<string, ProviderState>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

function stateOf(providerId: string): ProviderState {
  let state = providerStates.get(providerId);
  if (state === undefined) {
    state = newProviderState();
    providerStates.set(providerId, state);
  }
  return state;
}

/** Probe every provider and build the one catalog and the slot plan. */
async function load(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  probes = await Promise.all(brief.directory.providers.map((provider) => probeProvider(ENV_URL, provider, PROBE_TIMEOUT_MS)));
  for (const probe of probes) if (!probe.ok && probe.error !== null) log(probe.error);
  catalog = buildCatalog(ENV_URL, probes, brief.ratings);
  const manifest = brief.workload?.manifest ?? [];
  plan = computePlan(manifest, probes, brief.ratings);
  log(
    `catalog: ${catalog.providers.length} providers, ` +
      `${catalog.providers.reduce((n, p) => n + p.models.filter((m) => m.free).length, 0)} free models; ` +
      `plan: ${plan.map((c) => (c === null ? '?' : c.providerId)).join(',')}`,
  );
}

const byId = (a: ProbedModel, b: ProbedModel): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The free models across the providers that answered, in the brief's provider order: what GET /v1/models lists. */
function servedModels(): ServedModel[] {
  const out: ServedModel[] = [];
  const seen = new Set<string>();
  for (const probe of probes) {
    if (!probe.ok) continue;
    for (const model of [...probe.models].sort(byId)) {
      const row = ratingOfModel(brief.ratings, probe.provider.id, model.id);
      if (!modelFree(model, row)) continue;
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      out.push({ id: model.id, provider: probe.provider.id, display_name: model.display_name });
    }
  }
  return out;
}

/** The requirements of the request now arriving: the manifest's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const manifest = brief.workload?.manifest ?? [];
  const entry = manifest[manifestIndex];
  manifestIndex += 1;
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** Requirements read off a request body, when the manifest has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    vision,
    json: format === 'json_object' || format === 'json_schema',
  };
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message));
  else sendJson(res, status, openAIError(message, type, null));
}

function sendSseHead(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

interface UpstreamCall {
  status: number;
  /** The provider's answer body, when it answered 2xx with JSON. */
  json: Json | null;
  /** The provider's answer stream, when it answered 2xx with SSE. */
  stream: ReadableStream<Uint8Array> | null;
  /** Whether the env counted this call against the provider's budget. */
  counted: boolean;
}

/**
 * One call to a provider on its own wire. A 402, 429 or 5xx is a refusal and
 * counts against the provider's budget; a 400 or 401 is a malformed call and
 * does not. The caller fails over on any non-2xx.
 */
async function callProvider(
  probe: Probe,
  modelId: string,
  clientApi: 'openai' | 'anthropic',
  body: Json,
): Promise<UpstreamCall> {
  const provider = probe.provider;
  const base = joinBase(ENV_URL, provider.base);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...authHeaders(provider.auth, provider.key),
  };
  if (provider.wire === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  const stream = body.stream === true;
  let url: string;
  let upstreamBody: Json;
  if (provider.wire === 'openai') {
    url = `${base}/v1/chat/completions`;
    // An OpenAI client passes through (model replaced); an Anthropic client is
    // rewritten into the OpenAI shape, or the provider echoes no system, no
    // tools and no stops.
    upstreamBody = clientApi === 'anthropic' ? anthropicToOpenAI(body, modelId) : { ...body, model: modelId };
    if (stream) upstreamBody.stream_options = { include_usage: true };
  } else if (provider.wire === 'anthropic') {
    url = `${base}/v1/messages`;
    // An Anthropic client passes through (model replaced); an OpenAI client is
    // rewritten into the Anthropic shape.
    upstreamBody = clientApi === 'openai' ? openAIToAnthropicRequest(body, modelId) : { ...body, model: modelId };
  } else {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    url = `${base}/v1beta/models/${encodeURIComponent(modelId)}:${action}`;
    upstreamBody = clientApi === 'openai'
      ? openAIToGemini(body, isRecord(body.response_format) && (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema'))
      : anthropicToGemini(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(upstreamBody), signal: AbortSignal.timeout(20000) });
  } catch (err) {
    return { status: 0, json: null, stream: null, counted: false };
  }
  const counted = res.status === 402 || res.status === 429 || res.status >= 500 || res.status === 200;
  if (!res.ok) {
    try {
      await res.arrayBuffer();
    } catch {
      // The error body is not needed.
    }
    return { status: res.status, json: null, stream: null, counted };
  }
  if (stream && res.body !== null) return { status: 200, json: null, stream: res.body, counted: true };
  let json: Json | null = null;
  try {
    const value: unknown = await res.json();
    json = isRecord(value) ? value : null;
  } catch {
    json = null;
  }
  return { status: 200, json, stream: null, counted: true };
}

/** Pipe a provider's event stream to the client as it arrives. */
async function pipeStream(stream: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

/**
 * Send one provider's 2xx answer in the client's wire. Same-wire streams pipe
 * through byte for byte; anything else is translated (the provider's answer is
 * small, so cross-wire streams are read whole, then written in the client's
 * event order).
 */
async function answerClient(
  clientApi: 'openai' | 'anthropic',
  providerWire: 'openai' | 'anthropic' | 'gemini',
  modelId: string,
  call: UpstreamCall,
  res: ServerResponse,
): Promise<void> {
  if (call.stream !== null) {
    if (clientApi === 'openai' && providerWire === 'openai') {
      sendSseHead(res);
      await pipeStream(call.stream, res);
      return;
    }
    if (clientApi === 'anthropic' && providerWire === 'anthropic') {
      sendSseHead(res);
      await pipeStream(call.stream, res);
      return;
    }
    const frames = await readSseFrames(call.stream);
    let text: string;
    if (clientApi === 'openai' && providerWire === 'anthropic') text = anthropicStreamToOpenAI(frames, modelId);
    else if (clientApi === 'openai' && providerWire === 'gemini') text = geminiStreamToOpenAI(frames, modelId);
    else if (clientApi === 'anthropic' && providerWire === 'openai') text = openAIStreamToAnthropic(frames, modelId);
    else text = geminiStreamToAnthropic(frames, modelId);
    sendSseHead(res);
    res.end(text);
    return;
  }
  const json = call.json;
  if (json === null) {
    sendError(res, clientApi, 502, clientApi === 'anthropic' ? 'api_error' : 'server_error', 'the provider answered with a body that is not JSON');
    return;
  }
  if (clientApi === 'openai' && providerWire === 'openai') sendJson(res, 200, json);
  else if (clientApi === 'openai' && providerWire === 'anthropic') sendJson(res, 200, anthropicToOpenAIAnswer(json, modelId));
  else if (clientApi === 'openai' && providerWire === 'gemini') sendJson(res, 200, geminiToOpenAI(json, modelId));
  else if (clientApi === 'anthropic' && providerWire === 'openai') sendJson(res, 200, openAIToAnthropic(json, modelId));
  else if (clientApi === 'anthropic' && providerWire === 'anthropic') sendJson(res, 200, json);
  else sendJson(res, 200, geminiToAnthropic(json, modelId));
}

/** One client request: the planned provider first, then failover candidates, until one answers. */
async function serve(clientApi: 'openai' | 'anthropic', body: Json, res: ServerResponse): Promise<void> {
  const requires = requirementsFor(body);
  const manifestPos = manifestIndex - 1;
  // Re-plan the requests still to come from the calls made so far: a failover
  // spends a provider's call, and the next first attempt must price that in
  // instead of walking into the call number the plan assumed was still free.
  // The manifest rows before this one are already answered; re-plan from here.
  const remaining = (brief.workload?.manifest ?? []).slice(manifestPos);
  const startCalls = new Map<string, number>();
  for (const [id, state] of providerStates) startCalls.set(id, state.calls);
  const freshPlan = computePlan(remaining, probes, brief.ratings, startCalls);
  const planned = freshPlan.length > 0 ? freshPlan[0] : null;
  let order = rankedFailoverCandidates(probes, brief.ratings, requires, clientApi, providerStates);
  if (planned !== null) {
    const at = order.findIndex((c) => c.providerId === planned.providerId);
    if (at > 0) {
      const [first] = order.splice(at, 1);
      order.unshift(first);
    }
  }
  for (const candidate of order) {
    const probe = probes.find((p) => p.provider.id === candidate.providerId);
    if (probe === undefined) continue;
    const state = stateOf(candidate.providerId);
    const call = await callProvider(probe, candidate.modelId, clientApi, body);
    if (!call.counted) continue; // malformed call: the env did not count it
    state.calls += 1;
    if (call.status !== 200) {
      state.consecutiveFailures += 1;
      state.failedCallNumbers.add(state.calls);
      if (state.consecutiveFailures >= 2) state.dead = true;
      log(`refused: ${candidate.providerId} call ${state.calls} HTTP ${call.status} for ${body.model ?? ''}`);
      continue;
    }
    state.consecutiveFailures = 0;
    await answerClient(clientApi, probe.provider.wire, candidate.modelId, call, res);
    return;
  }
  sendError(
    res,
    clientApi,
    503,
    clientApi === 'anthropic' ? 'overloaded_error' : 'server_error',
    'no free model on the directory meets this request',
  );
}

/** POST /v1/chat/completions: an OpenAI-shaped client. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'openai', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve('openai', body, res);
}

/** POST /v1/messages: an Anthropic-shaped client. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, 'anthropic', 400, 'invalid_request_error', 'the request body is not one JSON object');
  await serve('anthropic', body, res);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the workload's size. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the workload holds ${reply.requests} requests`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  await load();
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${catalog.providers.length} answered providers and ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
