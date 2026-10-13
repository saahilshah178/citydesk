# CityDesk sim client

An Echo Show style web client for CityDesk. Alexa+ developer tooling is partner-only, so this is
our own host: a real MCP client that talks to the CityDesk server over Streamable HTTP, renders its
MCP Apps cards in a sandboxed iframe, and puts an Amazon Bedrock assistant with an Amazon Polly
voice in front of it.

Nothing in the production path is simulated. With no AWS credentials the assistant and the voice
answer with an error; the MCP connection, the cards and the developer drawer keep working.

## Run it

```bash
pnpm install
cp .env.example .env                               # repo root; set BEDROCK_MODEL_ID and AWS credentials

pnpm dev:server                                    # the CityDesk MCP server on :8787
pnpm --filter @citydesk/sim-client dev:api         # this client's backend on :8788
pnpm --filter @citydesk/sim-client dev             # the client on http://localhost:5173
```

Open `http://localhost:5173/?dev` to start with the developer drawer open.

| Command (`pnpm --filter @citydesk/sim-client ...`) | What it does |
| --- | --- |
| `dev` | Vite dev server on 5173, proxying `/api` to the backend |
| `dev:api` / `start:api` | Backend on 8788 (with and without file watching) |
| `build` | Static client into `dist/` (`index.html`, `sandbox.html`, `assets/`) |
| `preview` | Serves `dist/` on 5173 with the same `/api` proxy |
| `typecheck`, `test` | `tsc --noEmit`, `vitest run` |
| `conversation` | The scripted conversation runner (see below) |

### Environment

Everything is read from the repo-root `.env` or the real environment.

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `BEDROCK_MODEL_ID` | backend, runner | none | Model or inference profile ID. Never defaulted: without it `/api/converse` answers 503 |
| `AWS_REGION` | backend, runner | `us-east-1` | Region for Bedrock and Polly |
| `POLLY_VOICE_ID`, `POLLY_ENGINE` | backend | `Joanna`, `neural` | Voice for spoken replies |
| `MCP_URL` | backend, runner | `VITE_MCP_URL`, then `http://localhost:8787/mcp` | MCP server the browser is told to use |
| `MCP_CLIENT_TOKEN` | backend, runner | first entry of `MCP_BEARER_TOKENS` | Bearer token the browser presents to the MCP server |
| `DEMO_DAILY_REQUEST_CAP` | backend | `2000` locally, `600` in the deployed stack | Converse and speak requests per UTC day. `0` closes both routes |
| `DEMO_RATE_LIMIT_PER_MINUTE` | backend | `40` | Requests per minute per IP, all routes |
| `CLIENT_IP_HEADER` | Lambda | none | Trusted header with the visitor address, e.g. `cloudfront-viewer-address` |
| `CITYDESK_CITY_NAME`, `CITYDESK_TIME_ZONE` | backend, runner | `Boston`, `America/New_York` | City and "today" in the system prompt |
| `ASSISTANT_MAX_TOKENS` | backend, runner | `400` | Converse `maxTokens` |
| `ASSISTANT_TEMPERATURE` | backend, runner | not sent | Converse `temperature`, only when set |
| `ASSISTANT_TOOL_RESULT_FORMAT` | backend, runner | `json` | `text` sends structured content as JSON text, for models that reject `json` tool results |
| `API_PORT`, `API_HOST` | `server/dev.ts`, Vite proxy | `8788`, `127.0.0.1` | Where the local backend listens |
| `VITE_MCP_URL` | build | `http://localhost:8787/mcp` | MCP server used only when the backend cannot be reached |
| `VITE_SANDBOX_URL` | build | `/sandbox.html` | Where the card sandbox proxy lives (see "The sandbox origin") |
| `VITE_SANDBOX_ALLOWED_HOSTS` | build | localhost | Origins allowed to embed a sandbox proxy on a dedicated origin |

The browser asks `GET /api/config` for the MCP URL and token, so both can change without a rebuild.
The token is only ever sent to the URL it was configured for; connecting the drawer to another
server sends none.

## How it is built

```
src/
  assistant/   loop.ts (the tool-use loop), tools.ts (MCP tools -> Converse toolConfig, visibility),
               guard.ts (two sentences, no long IDs), types.ts (Converse-shaped messages)
  mcp/         session.ts (Client + StreamableHTTPClientTransport), traffic.ts (JSON-RPC log)
  apps/        host.ts (MCP Apps host), csp.ts, sandbox-config.ts, host-styles.ts
  sandbox/     proxy.ts + sandbox.html (the sandbox proxy document)
  voice/       recognition.ts (push-to-talk), speech.ts (Polly playback)
  ui/          EchoFrame, HomeScreen, CardStage, Controls, DevDrawer
  App.tsx      wiring: connection, turns, cards, voice
server/
  app.ts       handleApi(request): /api/converse, /api/speak, /api/config
  bedrock.ts   the one place that calls Bedrock Converse
  config.ts    the one place that reads configuration
  limits.ts    per-IP rate limit and daily cap
  prompt.ts    the system prompt
  dev.ts       Node http server; lambda.ts  Lambda Function URL adapter
scripts/
  conversation.ts, lib/runner.ts, lib/scenario.ts, scenarios/example.json
test/          vitest
```

### The MCP client

`src/mcp/session.ts` uses `@modelcontextprotocol/client` 2.x: `Client.connect` on a
`StreamableHTTPClientTransport` performs `initialize` and `notifications/initialized`, then the
session calls `tools/list` and `resources/list`. Every HTTP request carries
`Authorization: Bearer <token>` (through the transport's `authProvider`) and
`X-CityDesk-Device: <uuid>` (through `requestInit.headers`); the UUID lives in `localStorage`. The
handshake advertises the MCP Apps extension (`io.modelcontextprotocol/ui`).

The transport is wrapped by `TappedTransport`, which reports each JSON-RPC message that is really
sent or received to a `TrafficLog`. The developer drawer renders that log, so it shows protocol
traffic, not UI intentions.

The MCP server must allow this page's origin and, in its CORS preflight response, the request
headers `authorization`, `content-type`, `x-citydesk-device`, `mcp-protocol-version`,
`mcp-session-id` and `last-event-id`.

### Cards (MCP Apps)

When a called tool has `_meta.ui.resourceUri`, the host reads that resource, loads the sandbox
proxy in an iframe, hands it the HTML, waits for the view's `ui/initialize` handshake, and sends
the tool input and the tool result. The view's own requests are answered by the host:

- `tools/call` is proxied to the MCP server (this is how a card calls `static_map`), but only for
  tools whose visibility includes `app`. Anything else is refused without reaching the server.
- `ui/message` becomes a user turn for the assistant (a clarification chip was tapped).
- `ui/open-link` opens http(s) links in a new tab and shows the link in the captions.
- `resources/read`, `resources/list`, log messages, size changes and teardown requests.

Tools whose `_meta.ui.visibility` lacks `model` are left out of the model's tool list, and the loop
refuses them even if the model names one.

**What came from ext-apps.** The host logic is ported from `examples/basic-host` in
[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) at tag `v2.0.3`
(MIT):

| Here | From basic-host | What changed |
| --- | --- | --- |
| `src/apps/host.ts` | `src/implementation.ts` (`getUiResource`, `loadSandboxProxy`, `initializeApp`, `hookInitializedCallback`, `newAppBridge`) | The bridge is built without an MCP client and its handlers are registered by hand, so visibility can be enforced and card traffic logged; message and link handling; one display mode |
| `src/sandbox/proxy.ts`, `src/sandbox/sandbox.html` | `src/sandbox.ts`, `sandbox.html` | Two origin modes; CSP injected into the card instead of sent as a header; embedder allowlist instead of a localhost check |
| `src/apps/csp.ts` | `serve.ts` (`sanitizeCspDomains`, `buildCspHeader`) | `'self'` removed from every directive; `default-src 'none'`; `form-action 'none'` |
| `src/apps/host-styles.ts` | `src/host-styles.ts` | Same keys, this client's dark palette |

#### The sandbox origin

The MCP Apps spec requires a web host to load each view through a sandbox proxy document whose
origin differs from the host's. basic-host does that with a second server on another port. In
production this client is static files behind one CloudFront origin, so there is no second origin
to use and no server that could compute a CSP header per card.

`VITE_SANDBOX_URL` decides, and the mode follows from the URL:

- **Same host (default, `/sandbox.html`).** The iframe that loads the proxy is sandboxed with
  `allow-scripts allow-forms` and no `allow-same-origin`. The browser therefore gives the proxy an
  opaque origin: it is cross-origin to the client even though the same host served it, so it cannot
  touch the client's DOM, `localStorage` (the device ID) or the token in memory. The card inside it
  gets its own, separate opaque origin. This needs no extra infrastructure and behaves the same in
  development and production. Costs: cards have no `localStorage`/IndexedDB, their own network
  requests carry `Origin: null`, and the spec's literal wording (the sandbox "MUST have
  allow-same-origin") is not followed. The CityDesk cards need none of that: they get their data
  through the host.
- **Dedicated origin (`VITE_SANDBOX_URL=https://other-origin/sandbox.html`).** The iframe gets
  `allow-scripts allow-same-origin allow-forms`, as in basic-host and the spec, and cards run with
  that real origin. Use it if a card needs storage or a stable origin for CORS. That origin must
  serve nothing but `sandbox.html` (no client, no `/api`): cards share it and can script the proxy
  document. Set `VITE_SANDBOX_ALLOWED_HOSTS` to the client's origin so the proxy accepts it. For a
  quick local test, run the dev server with
  `VITE_SANDBOX_URL=http://127.0.0.1:5173/sandbox.html` and `--host 0.0.0.0`, then open
  `http://localhost:5173`: `localhost` and `127.0.0.1` are different origins. (That breaks the
  "nothing else on that origin" rule, so keep it to testing.)

The combination that must never happen (proxy on the client's own origin with `allow-same-origin`)
cannot be configured, and the proxy refuses to run if it finds itself in it.

Each card's CSP is built from the resource's `_meta.ui.csp` and injected by the proxy as the first
element of the card's `<head>`. Without declared domains a card can load nothing from the network:
inline code and `data:`/`blob:` URLs only. `sandbox.html` is one self-contained file with its
script inline, because an opaque-origin document cannot load a module script from its own host
unless that host sends CORS headers.

### The assistant

`src/assistant/loop.ts` runs one user turn: Converse, tools, Converse, until the model answers in
text. It takes a `converse` function and a `callTool` function and imports nothing else, so the
browser (through `/api/converse`) and the Node runner (direct Bedrock) run the same code.

- MCP `tools/list` entries become a Converse `toolConfig`; app-only tools are left out.
- A tool result goes back as a `toolResult` block: the text content, then `structuredContent` as a
  `json` block. Binary content is named, not forwarded.
- At most 4 tool rounds per turn (`maxToolRounds`), then one more call for the reply. If the model
  still wants tools, the turn ends with the last tool's `spoken_summary`.
- A tool that fails or throws is reported to the model with `status: "error"`.
- If Converse fails after a tool already ran (a report was filed), the resident hears that tool's
  `spoken_summary` rather than nothing. If it fails before any tool ran, the turn fails visibly.
- `guard.ts` cuts the reply to two sentences and 400 characters, flattens markdown, and removes
  UUIDs, request handles and long case numbers. The same rules are in the system prompt.

The system prompt is built in `server/prompt.ts` with today's date and the city, and never leaves
the backend. A request that carries its own `system` or `modelId` is rejected.

### The backend

`handleApi(request: Request): Promise<Response>` in `server/app.ts`:

| Route | Does |
| --- | --- |
| `POST /api/converse` | Validates `{ messages, toolConfig? }` (256 kB, 80 messages, 32 tools, only text / toolUse / toolResult blocks), calls `ConverseCommand`, returns `{ message, stopReason, usage, latencyMs, modelLatencyMs }` |
| `POST /api/speak` | `{ text }` up to 600 characters to `SynthesizeSpeechCommand` (mp3), returns `audio/mpeg` |
| `GET /api/config` | `{ mcpUrl, mcpToken, modelId, voiceId, region, cityName, timeZone, toolResultFormat }` |

Errors are JSON: `{ "error": { "code", "message" } }`. No CORS headers are sent, and POST bodies
must be `application/json`, so another site cannot call the routes from a browser.

**Limits.** Every route is rate-limited per IP per minute; `/api/converse` and `/api/speak` also
count toward `DEMO_DAILY_REQUEST_CAP`. Both fail closed with 429 or 503 and a `retry-after` header:
when a limit is hit, when a setting is present but not a whole number, and when the counters cannot
be read. The counters sit behind `CounterStore` in `server/limits.ts`. Locally the store is in
memory. In Lambda the daily cap is one atomic counter in DynamoDB (`SharedDayCounter` in
`server/aws.ts`, used when `CITYDESK_TABLE` is set), so it holds across every warm instance; the
per-IP minute counters stay in memory on purpose.

**Configuration.** `server/config.ts` is the only module that reads settings. It reads through a
`ConfigSource` (a function from name to value); the default is the environment. In Lambda,
`server/lambda.ts` puts Parameter Store in front of it when `CITYDESK_SSM_PREFIX` is set
(`ssmConfigSource` in `server/aws.ts`), which is where the MCP bearer token comes from. A relative
`MCP_URL` such as `/mcp` means "this page's own origin", which is how the deployed client reaches
the MCP server through CloudFront.

**Deploying.** `dist/` is plain static hosting. Route `/api/*` to a Lambda Function URL running
`server/lambda.ts` (export `handler`, payload format 2.0; audio is returned base64-encoded). The
function needs `bedrock:InvokeModel` on the model and `polly:SynthesizeSpeech`. Behind CloudFront,
forward `CloudFront-Viewer-Address` to the function and set
`CLIENT_IP_HEADER=cloudfront-viewer-address`; otherwise the per-IP limit sees edge nodes, not
visitors. Serve `sandbox.html` like any other file.

### Voice

Hold the button or the space bar to talk (Web Speech API in `en-US`, where the browser has it); the
typed input is always there. Replies are spoken with Polly audio from `/api/speak`. Starting to talk
stops playback and abandons a turn that is still running.

## Scripted conversations

`scripts/conversation.ts` plays a scenario through the same loop without a browser: the model is
called directly on Bedrock, the tools on a real MCP server.

```bash
pnpm demo:conversation     # from the repo root: writes today's scenario, then runs it

pnpm --filter @citydesk/sim-client conversation \
  --scenario results/conversation.scenario.json \
  --out results/conversation.json
```

`pnpm demo:scenario` (root `scripts/make_scenario.ts`) writes the scenario from live data, because
the duplicate scene needs a pothole that is open today.

Paths are relative to the directory the command is run from. `--help` lists the other flags
(`--mcp-url`, `--token`, `--device`, `--model`, `--region`, `--max-tool-rounds`, `--structured-as`).
Each run uses a new device ID unless `--device` is given, so the server's memory starts empty.
Exit code: 0 all turns passed, 1 a turn failed, 2 setup problem.

A scenario is a list of user turns, each with optional expectations:

```json
{
  "name": "placeholder",
  "description": "optional",
  "turns": [
    {
      "user": "There is a pothole in front of 700 Boylston Street.",
      "note": "optional, for readers",
      "expect": {
        "tool": "report_issue",
        "outcome": "possible_duplicate",
        "reply_includes": ["already"],
        "reply_excludes": ["request_id"]
      }
    },
    { "user": "What is the capital of France?", "expect": { "no_tools": true } }
  ]
}
```

| Expectation | Passes when |
| --- | --- |
| `tool` (string or list) | Each named tool was called during the turn |
| `outcome` | A call returned that `structuredContent.outcome`; with `tool`, it must come from one of those tools |
| `no_tools` | No tool was called |
| `reply_includes`, `reply_excludes` | The spoken reply contains / does not contain each string, ignoring case |

A turn may also set `new_session: true` (clear the assistant's history and reconnect the MCP client
as the same device, as when the resident comes back another day) and `wait_seconds` (pause first,
for example to let a sandbox request change status).

A turn also fails if it did not end with a reply from the model (round cap, lost model call). After
a failed model call the remaining turns are skipped. `scripts/scenarios/example.json` only shows
the format; it has not been run against the CityDesk server.

The record saved by `--out` has `turns[]` (user text, reply, raw reply before the guard, tool calls
with arguments, outcome, error and duration, model and tool timings, token usage, each expectation
with expected, actual and pass), a `summary`, an overall `pass`, and a `run` block (MCP URL and
server, model, region, device ID, tool lists).

## What has not been run

- Bedrock Converse and Polly have never been called from this code: there were no AWS credentials
  on the machine it was written on. Those paths are covered by unit tests with injected fakes and
  by type-checking against AWS SDK v3. The request shapes, the `json` tool result block, error
  names and model behaviour under the system prompt are unverified against the real services.
- The Lambda adapter has only been run in unit tests.
- With the real CityDesk server and cards, the client has been checked through its developer
  drawer (manual tool calls, both cards rendering with live Boston data; screenshots in
  `results/integration/`). A full spoken or typed turn needs Bedrock and has not been run.
- Speech recognition and audio playback were not exercised with a real microphone or speaker.
