# Submission kit

Everything to paste into the Devpost form for "Build, Ship, Shape". Square brackets mark the few
things only you can fill in. Numbers come from the files under [`results/`](../results); run
`pnpm check:claims` after any new run to confirm this page and the README still match them.

> **Before submitting:** the Bedrock assistant, Polly, Amazon Location, DynamoDB and the deployment
> have not been run against AWS yet (the build machine had no credentials). After `make deploy`, run
> `pnpm smoke` and `pnpm demo:conversation`, then update the lines marked **[after deploy]**.

- **Primary track:** Alexa+
- **Mini-challenges:** AWS Builder, Open Source
- **Repository:** https://github.com/saahilshah178/citydesk (public, MIT license)
- **Live demo:** [client URL from `results/deploy-outputs.json` after `make deploy`]
- **MCP endpoint:** [MCP URL from `results/deploy-outputs.json`], Streamable HTTP, spec 2025-11-25
- **Video:** [YouTube or Vimeo link, public, under 3 minutes]
- **Built with:** Model Context Protocol (TypeScript SDK 2.3), MCP Apps (ext-apps 2.0), Amazon Bedrock,
  AWS Lambda, Amazon DynamoDB, Amazon Location Service, Amazon Polly, Amazon CloudFront, Amazon S3,
  AWS Systems Manager Parameter Store, AWS CDK, TypeScript, React, Open311 GeoReport v2

---

## Project description

### One line

CityDesk lets a resident report a city problem by voice, hear that a neighbor already reported it and
follow that report instead, check on their requests days later, and ask when trash goes out.

### What it does

Cities get the same pothole reported five times, and residents never hear what happened to theirs.
CityDesk puts 311 on Alexa+:

- **"There's a big pothole in front of 617 East Third Street."** CityDesk finds the spot and checks
  Boston's live requests. Someone reported that pothole yesterday, 4 meters away, and it is still
  open, so nothing new is filed: "Do you want to follow that report instead?"
- **"Yes, follow it."** The request is saved to the household's list.
- **"There's a problem with the streetlight outside 1 City Hall Plaza."** No existing report, so
  CityDesk asks the one thing the city's form requires ("completely out, flickering, or on during the
  day?") and files it.
- **"What's happening with my requests?"** A new day, a new session: CityDesk remembers both
  requests, checks them with the city, and says what changed.
- **"When does the trash go out at 700 Boylston Street?"** "Trash and recycling are both picked up
  on Mondays and Thursdays. The next pickup is this Thursday, October 15th."

On an Echo Show, each answer comes with a card: a map pin, a status timeline and the photo for a
request; the next two weeks of pickups for an address. Every spoken reply stands on its own without
the card.

It is built on Open311 GeoReport v2, the API many US cities already publish, so adding a city is a
config entry, not a new integration.

### How it works

- **A self-hosted MCP server** (Streamable HTTP, MCP spec 2025-11-25, also serving 2026-07-28
  clients) with one tool per customer intent: `report_issue`, `find_nearby_reports`,
  `follow_request`, `my_requests`, `request_status`, `collection_schedule`. The tools follow Amazon's
  Alexa+ tool design guidance: each description says when to call the tool, why, and what it
  returns; schemas declare only what is honored; every result carries stable IDs and dates; failures
  are structured errors.
- **Duplicate detection before filing.** `report_issue` geocodes the spoken place with Amazon
  Location Service inside the city's bounding box, then looks for open requests of the same type
  within 50 meters from the last 30 days. Replaying 23,017 real Boston requests from 2026-09-13 to
  2026-10-12, 26.7% of fixed-infrastructure reports (potholes, streetlights, sidewalks, signals) were
  filed while a request of the same type was already open within 50 m; for potholes alone it was
  23.6%.
- **Memory across sessions** in DynamoDB: what each household filed and follows, the last status it
  heard, and its home address, so "any updates?" works tomorrow.
- **MCP Apps cards** (`ui://` resources) linked from the tools, rendered in a sandboxed iframe.
- **Writes never touch a city's production system.** One guard refuses any endpoint that is not a
  sandbox. Duplicates are checked against live data; new reports go to a sandbox.
- **Our own Echo Show style client**, because Alexa+ developer tooling is partner-only: a web page
  that is a real MCP client (initialize, tools/list, tools/call over Streamable HTTP), with a Bedrock
  model deciding which tools to call through the Converse API, push-to-talk input, and replies spoken
  by Amazon Polly. A developer drawer shows the live MCP traffic.
- **Deployed with AWS CDK:** two Lambda functions behind Function URLs, DynamoDB, an Amazon Location
  place index, S3 and CloudFront, secrets in Parameter Store, and daily ceilings so a public demo
  cannot run up a bill.

### What is real and what is simulated

- Real: Boston's live 311 requests (reads), Boston's published trash schedules, the MCP protocol
  exchange, the duplicate logic, the cross-session memory, the cards.
- Sandbox: new reports are filed in CityDesk's own Open311 sandbox. The test endpoint in Boston's
  discovery file does not resolve, and the SeeClickFix test server would not accept a request without
  an account token. The sandbox moves a request to "assigned" after two minutes and labels every such
  note as simulated.
- Not Alexa: the client is ours. The MCP server is what an Alexa+ add-on would call.

### What we learned

- The service list a city publishes is not the list of things residents report: Boston's API lists 6
  fileable request types while about 60 are readable.
- A public demo token means every tool is a cost and abuse surface. Each paid call sits behind a
  counter in DynamoDB.
- For voice, IDs are useless and dates must be relative: "the pothole report at 617 East Third
  Street from yesterday", never a UUID.

---

## AWS Builder

AWS services used, each with a documented integration ([`docs/aws.md`](aws.md) has IAM actions,
Regions, costs, and the file that defines and calls each one):

| Service | How CityDesk uses it | Where |
| --- | --- | --- |
| Amazon Bedrock | The assistant: Converse API with tool use decides which MCP tool to call and writes the two-sentence reply | `apps/sim-client/server/bedrock.ts` |
| AWS Lambda | Runs the stateless MCP server and the client backend behind Function URLs | `apps/citydesk/src/lambda.ts`, `apps/sim-client/server/lambda.ts` |
| Amazon DynamoDB | Per-household memory, sandbox requests, and atomic counters that cap spend | `apps/citydesk/src/store/dynamo.ts`, `apps/sim-client/server/aws.ts` |
| Amazon Location Service | Geocodes spoken addresses and landmarks within the city's bounding box; draws the map on the issue card | `apps/citydesk/src/geocode/amazonLocation.ts`, `apps/citydesk/src/aws/staticMap.ts` |
| Amazon Polly | Speaks every reply | `apps/sim-client/server/app.ts` |
| Amazon S3 and CloudFront | Serve the client and put the API and the MCP endpoint on one origin | `infra/lib/citydesk-stack.ts` |
| AWS Systems Manager Parameter Store | Bearer token, API keys, allowed origins | `apps/citydesk/src/aws/parameters.ts` |
| AWS CDK | The whole stack, with 49 template tests | `infra/` |

**[after deploy]** Add the Region, the model ID you chose, and one sentence each on how Bedrock tool
use, Polly and Amazon Location behaved in the live demo.

---

## Open Source

- **Project repository URL:** https://github.com/saahilshah178/citydesk
- **Contribution URL:** https://github.com/saahilshah178/citydesk/tree/main/packages/open311-mcp
  [and https://www.npmjs.com/package/open311-mcp once published with `npm publish`]
- **GitHub username:** [your GitHub username]
- **License:** MIT

**What we did.** We built `open311-mcp`, a new open-source package: a city-agnostic MCP server and
typed TypeScript client for Open311 GeoReport v2. It was written during the hackathon and is
publishable on its own (`npm publish --dry-run` passes; 60 tests).

**How it works.** A city is a config entry: base URL, test URL, API key variable, rate limit and
bounding box. The server exposes six tools (`list_cities`, `list_services`,
`get_service_definition`, `search_requests`, `get_request`, `create_request`) over stdio or
Streamable HTTP. The client handles what the spec leaves open and real servers do differently:
paging, date windows over 90 days, numeric versus string IDs, servers that silently ignore spatial
filters, and firewalls that answer with an HTML challenge instead of a 429. A write guard refuses any
endpoint that is not a sandbox, and a built-in GeoReport v2 sandbox gives create-request flows a safe
target. The HTTP layer (Origin validation, bearer auth, JSON responses, 405 on GET, optional
sessions) is one web-standard function with adapters for `node:http` and Lambda Function URLs, and
works with any MCP server factory. Boston and a SeeClickFix city (New Haven) ship as examples.

**Why it matters.** Open311 is the one API dozens of cities already share, and none of it was
reachable from an AI assistant. With this package, any MCP client can read and search a city's
service requests today, and a developer can build a 311 assistant for another city by writing a
config file, without the risk of spamming a real city while testing.

> The rules describe the Open Source item as "additional" to the primary project. This package lives
> in the same repository as CityDesk. If you want it to stand unambiguously on its own, publish it
> to npm and, optionally, mirror it to its own repository:
> `git subtree split --prefix=packages/open311-mcp -b open311-mcp-only`, then push that branch to a
> new `open311-mcp` repository and use its URL above.

---

## Product feedback

The form asks five things per tool: what you used it for, what worked well, what needs work, how
onboarding went, and whether you would build with it again. The full answers are in
[`FEEDBACK.md`](../FEEDBACK.md); this is the paste-ready version.

### MCP TypeScript SDK (`@modelcontextprotocol/server`, `/client` 2.3.1)

- **Used for:** The MCP server (tools, resources, Streamable HTTP), the stdio entry, and the MCP
  client in our web client and tests.
- **Worked well:** Web-standard building blocks (`validateOriginHeader`, `requireBearerAuth`,
  `WebStandardStreamableHTTPServerTransport`, `createMcpHandler`, `isLegacyRequest`) compose into one
  `fetch(Request)` function, which is what a Lambda Function URL needs. One endpoint serves
  2025-11-25 and 2026-07-28 clients from a single server factory. `outputSchema` with zod gives
  typed, validated results.
- **Needs work:** Two package lines side by side; `LATEST_PROTOCOL_VERSION` is `2025-11-25` in a
  package whose README says 2026-07-28; the stateless fallback for 2025-era clients answers in SSE
  with no JSON option; a warning prints on every start with `responseMode: 'json'`; type
  declarations are bundled and hard to read; a stateless server's allowed 405 shows as a console
  error in the browser.
- **Onboarding:** About an hour to a passing `initialize` over HTTP, mostly choosing the package line.
- **Build again:** Yes. The same server code runs on stdio, Node and Lambda.

### MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **Used for:** The two cards and the host side of our client.
- **Worked well:** The `App` handshake, tool-result events and auto-resize worked on first load.
  `callServerTool` with `visibility: ["app"]` is a clean way to fetch card-private data. The
  published example servers exercise almost every host feature.
- **Needs work:** `AppBridge` forwards every tool call a card makes regardless of visibility;
  `basic-host` cannot be hosted statically on one origin, calls a tool twice with `?call=true`, and
  has no fixed-size surface; each card carries about 350 kB of SDK and zod; the quickstart uses
  deprecated setters.
- **Onboarding:** A first card in under an hour. Running `basic-host` from the tag took a
  nine-minute install and needs `bun`, which the docs do not mention.
- **Build again:** Yes. Cards that work in any MCP Apps host are the right fit for a screen device.

### MCP Inspector 2.10.1

- **Used for:** The manual pass over both servers.
- **Worked well:** Scriptable CLI mode, JSON arguments, custom headers, stdio and HTTP.
- **Needs work:** It validates error results against `outputSchema` and hides the tool's own error;
  with a wrong token it asks for interactive OAuth instead of showing the 401.
- **Onboarding:** Minutes.
- **Build again:** Yes. It caught a real conformance gap in our error results.

### Amazon Bedrock

- **Used for:** The assistant, through the Converse API with tool use.
- **Worked well:** The Converse tool-use shape maps one-to-one onto MCP tool definitions, so the
  conversion is a few lines (`apps/sim-client/src/assistant/tools.ts`).
- **Needs work:** Scoping IAM to one model takes guesswork when the ID is an inference profile:
  the profile ARN, the model ARN in every destination Region, and a Region-less ARN for global
  profiles. The first call to a Marketplace model needs subscription permissions a least-privilege
  role lacks. The SDK docs say `toolResult.status` is "only supported by" some models without saying
  what the others do.
- **Onboarding / Build again:** **[after deploy]** One or two sentences on model access, latency and
  how reliably the model picked the right tool in `results/conversation.json`.

### AWS Lambda

- **Used for:** The MCP server and the client backend, behind Function URLs.
- **Worked well:** A stateless MCP server fits a Function URL exactly: one request, one JSON
  response. Our bundles load in under 200 ms locally (`results/bundle_check.json`).
- **Needs work:** CloudFront origin access control cannot protect a Function URL for an MCP server,
  because POST callers would have to send a body hash header that MCP clients do not send. The
  runtimes table lists a preview runtime next to GA ones.
- **Onboarding / Build again:** **[after deploy]** Cold start and anything that surprised you.

### Amazon DynamoDB

- **Used for:** Per-household memory, sandbox requests, and atomic counters for cost ceilings, in
  one table.
- **Worked well:** One `ADD` update expression gives an atomic counter shared by every Lambda
  instance, which is all a public demo needs to cap spend. TTL cleans up demo data.
- **Needs work:** `dynamodb:LeadingKeys` conditions are the only way to scope a role to one
  partition, and they are easy to get subtly wrong.
- **Onboarding / Build again:** **[after deploy]** Note whether 5/5 provisioned capacity was enough.

### Amazon Location Service

- **Used for:** Geocoding spoken addresses and landmarks within the city's bounding box, and static
  map images for the issue card.
- **Worked well:** `FilterBBox` on `SearchPlaceIndexForText` is exactly the "stay inside this city"
  control a civic app needs; `GetStaticMap` returns an image the server can hand to a card, so no map
  key reaches the browser.
- **Needs work:** Pricing is hard to read without a real browser, and it is unclear whether stored
  geocodes count toward the free tier. Two API generations (place indexes and the newer Maps API)
  need different IAM service prefixes.
- **Onboarding / Build again:** **[after deploy]** How well it resolved landmarks like "the library on
  Boylston Street", and whether ambiguous places produced a sensible clarifying question.

### Amazon Polly

- **Used for:** Speaking the replies.
- **Worked well:** One call returns MP3 bytes that a Function URL can return directly.
- **Needs work:** The SDK types the byte array so that it is not directly a `BodyInit`; the pricing
  page still describes the neural free tier as "first 12 months".
- **Onboarding / Build again:** **[after deploy]** Voice quality and latency for two-sentence replies.

### AWS CDK

- **Used for:** The whole deployment, with template tests.
- **Worked well:** `cdk synth` needs no credentials, so 49 tests check the template and real esbuild
  bundling on every change. `addFunctionUrl`, `FunctionUrlOrigin` and the S3 origin access control
  make a three-behaviour distribution short.
- **Needs work:** `NodejsFunction` cannot find esbuild in a pnpm workspace unless the CLI is started
  through pnpm; `cdk bootstrap` with an explicit environment still synthesizes the app; least
  privilege needs hand-made roles; no helper for Bedrock inference-profile grants.
- **Onboarding:** Smooth for the stack; the time went into IAM and pricing.
- **Build again:** Yes.

### Boston Open311

- **Used for:** Live reads: duplicate checks, request status, and the 30-day replay.
- **Worked well:** Keyless reads in 0.3 to 0.9 s; paging to 300; status, type, date and text filters;
  multi-ID lookups; coordinates, notes and photos on every request.
- **Needs work:** The test endpoint in the discovery file does not resolve; the service list covers
  6 of about 60 request types; spatial filters are silently ignored; the public hostname answers
  steady API traffic with an HTML challenge page and HTTP 200 instead of a 429.
- **Onboarding:** One `curl` to the first response; an afternoon to learn the undocumented behaviour.
- **Build again:** Yes for reads. Not for writes until a working sandbox exists.

### SeeClickFix (test server)

- **Used for:** The second city in `open311-mcp`; meant to be the write sandbox.
- **Worked well:** Keyless reads, location search, paging, service definitions.
- **Needs work:** Services exist only around New Haven; creating a request needs an account (the
  Open311 POST answers 404, the native API 401) and the docs do not say what a POST requires.
- **Onboarding:** Reads in minutes; writes blocked.
- **Build again:** Yes for reads; for writes we would need a key and clearer docs.

### Boston open data portal (data.boston.gov)

- **Used for:** Trash and recycling schedules by address, and address points.
- **Worked well:** A complete, current dataset with a data dictionary, downloadable as one CSV.
- **Needs work:** Single-address lookups through the datastore API take 2 to 5 seconds and sometimes
  time out, so we index the CSV locally.
- **Onboarding:** Easy.
- **Build again:** Yes, as a bulk source.

---

## Friction log

25 entries, each with the six fields the rules ask for. The full text, with every step, is in
[`FRICTION_LOG.md`](../FRICTION_LOG.md); the table below is generated from it by
`pnpm friction:table`.

<!-- friction:start -->
| # | Tool and problem | Task | Steps taken | Expected vs actual | Severity | Workaround | Suggestion |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Boston Open311: the test endpoint in the discovery file does not resolve | Find a safe write target for Boston so new reports never touch production. | Fetched `https://311.boston.gov/open311/discovery.json`, took the endpoint with `"type": "test"` (`https://boston2-test.spotmobile.net/open311/v2`), requested `/services.json`. Re-checked DNS against 1.1.1.1 and 8.8.8.8. | Expected a working sandbox. Actual: the hostname has no DNS record on either resolver (`ENOTFOUND`), while the production host in the same file resolves fine. | high | Boston is read-only in CityDesk. New reports are filed in the SeeClickFix test server instead, and `pnpm smoke` reports the Boston test endpoint as degraded on every run. | Remove dead endpoints from the discovery file or restore the host. A `status` field per endpoint in discovery would let clients tell "retired" from "temporarily down". |
| 2 | Boston Open311: the service list covers 6 request types, but requests come in dozens | Let a resident report a pothole or a broken streetlight. | `GET /services.json`, then `GET /requests.json` and compared `service_name` values. | Expected the service list to include the common request types. Actual: it lists 6 (Street Outreach & Encampments, Other, Illegal Parking, Abandoned Vehicle, Rodent Sighting, Abandoned Bicycle). Pothole and Street Light Outage requests are readable through `/requests.json` with their own `service_code`, but `GET /services/{that code}.json` answers `404 Invalid service code`. | high | The client builds a read catalog from the service codes seen in recent requests and keeps it separate from the fileable list. | Document which services are read-only through the API, or add a `"fileable": false` flag so the full catalog can be listed. |
| 3 | Boston Open311: spatial filters are ignored without an error | Search open requests near a point to detect duplicates. | Called `/requests.json` with `lat`/`long`/`radius`, then `bbox=`, then `min_lat`/`max_lat`/`min_long`/`max_long`. | Expected either a filtered result or a 400. Actual: HTTP 200 with the same unfiltered citywide page each time. | medium | Filter by service code, status, and date on the server, then apply the bounding box and distance in the client. Page size goes up to 300 (`per_page=500` returns 300). | Reject unknown query parameters with a 400, and list the supported extensions (`q`, `per_page`, `page`, `extensions`) in the discovery file. |
| 4 | Boston Open311: a service code containing a dot cannot be looked up | Fetch the service definition for every service with `metadata: true`. | `GET /services/input.Rodent%20Sighting.json` (the code is `input.Rodent Sighting`). | Expected the attribute list. Actual: an HTML 404 page, not the Open311 JSON error. Codes with colons and ampersands work when percent-encoded; the dot is read as a format extension. | low | Treat a non-JSON 404 as "definition unavailable" and file without attributes. | Use opaque IDs for service codes (most Boston codes already are UUIDs). |
| 5 | SeeClickFix sandbox: services depend on coordinates, and there are none at Boston | Use `test.seeclickfix.com` as the sandbox for Boston reports. | `GET /open311/v2/services.json?lat=42.3493&long=-71.0782` (Boston) and again with New Haven coordinates. Looked for the Open311 docs under `dev.seeclickfix.com`. | Expected a usable service list wherever the sandbox is queried. Actual: `[]` at Boston, 118 test services around New Haven. `dev.seeclickfix.com/open311/` is a 404; the only Open311 page (`seeclickfix.com/open311/v2/docs`) is a few paragraphs with no mention of how the sandbox is seeded or what POST requires. | medium | The sandbox city config carries its own reference coordinates for service discovery. | Document the sandbox: where services exist, whether an API key is needed to create requests, and how long test data lives. |
| 6 | MCP TypeScript SDK: two package lines, and the version constant does not match the README | Pick the official MCP SDK and target spec 2025-11-25 over Streamable HTTP. | `npm view @modelcontextprotocol/sdk` (1.32.1), then found `@modelcontextprotocol/server` and `/client` at 2.3.1. `@modelcontextprotocol/ext-apps@2` lists the v2 packages as peers, so v1 is not an option alongside it. | Expected one obvious package. Actual: the v2 README says it implements the 2026-07-28 spec, yet the exported `LATEST_PROTOCOL_VERSION` is `"2025-11-25"`; 2025-era clients are served by a separate "legacy" path. The stateless legacy fallback in `createMcpHandler` answers with SSE, and there is no option to make it return JSON. | medium | Route with `isLegacyRequest` in front of a `legacy: 'reject'` handler and serve 2025-era requests through `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true`. | Rename the constant (or add `LATEST_LEGACY_PROTOCOL_VERSION`), and give `createMcpHandler` a JSON option for the legacy leg, since buffered hosts like Lambda need it. |
| 7 | pnpm 12: a fresh install fails until build scripts are approved | `pnpm install` in a new workspace that depends on `tsx` (which pulls in esbuild). | Ran `pnpm install`. | Expected a warning. Actual: exit code 1 with `ERR_PNPM_IGNORED_BUILDS`. `pnpm approve-builds esbuild` fixed it and also wrote `minimumReleaseAgeExclude` entries for packages published in the last few days. | low | `allowBuilds: { esbuild: true }` is committed in `pnpm-workspace.yaml`. | Name the exact `pnpm approve-builds <pkg>` command in the error text. |
| 8 | MCP Inspector and the TypeScript client disagree about validating error results | Manual pass over the CityDesk tools with the MCP Inspector CLI. | Declared an `outputSchema` on each tool. Called a tool in a way that fails, so it returned `isError: true` with a structured error object. The SDK client (`Client.callTool`) accepted it in our tests; `inspector --cli --method tools/call` exited with `data must have required property 'requests', data must NOT have additional properties`. | Expected both official tools to treat an error result the same way. Actual: the SDK client skips output validation when `isError` is true, the Inspector validates anyway and hides the real tool error behind a schema error. | medium | Every result now conforms to the declared schema, failures included: the schema has an `error` outcome and an optional `error` object, and issue tools return `requests: []` on failure. | State in the spec whether `outputSchema` applies to `isError` results, and make the Inspector show the tool's own error text when validation fails. |
| 9 | data.boston.gov datastore: address lookups take 2 to 5 seconds and sometimes time out | Look up one address in the "Trash Schedules by Address" dataset for a voice reply. | `datastore_search` with `filters={"full_address": "..."}` (exact match), then with `q={"full_address": "..."}` (full text). Timed several calls. | Expected a keyed lookup to be fast. Actual: the same exact-match query took 0.4 s in one run and 2.4 to 4.9 s minutes later, and one call hit our 10 s timeout. The exact match is case-sensitive, so "700 boylston st" finds nothing. | medium | Normalize the spoken address to the dataset's casing and abbreviations, try the exact match first and fall back to full text, and report a retryable structured error on timeout. | Index `full_address` (or publish a case-insensitive lookup endpoint), since "find my address" is the main use of this dataset. |
| 10 | AWS CDK: `NodejsFunction` cannot find esbuild in a pnpm workspace | Bundle the two Lambda handlers during `cdk synth`, started from the Makefile. | Ran `node_modules/.bin/cdk synth` inside `infra/`. esbuild is a dev dependency of `infra/`; the lockfile is at the repo root. | Expected CDK to use the esbuild it had already detected. Actual: it ran `pnpm exec esbuild` from the lockfile directory, got `Command "esbuild" not found`, then `FailedToBundleAsset`. The same synth passes under `pnpm exec cdk`, only because pnpm then puts `infra/node_modules/.bin` on `PATH`. | high (it would have broken the first `make deploy`) | `bundling.environment.PATH` prepends `infra/node_modules/.bin` (`infra/lib/citydesk-stack.ts`), with a regression test that strips repo paths from `PATH`. | Run the esbuild binary CDK resolved instead of `<package manager> exec` from the lockfile directory. |
| 11 | AWS CDK: `cdk bootstrap aws://account/region` still synthesizes the app | Bootstrap the account and Region only when needed, before the first deploy. | Ran `cdk bootstrap aws://<account>/<region>` inside `infra/` without `BEDROCK_MODEL_ID` set, then again from an empty directory. | Expected no synthesis when the environment is given explicitly. Actual: inside the project the app was synthesized and failed on our own missing setting; from a directory with no `cdk.json` it went straight to the AWS calls. | medium | `infra/scripts/bootstrap.ts` runs the CLI with the OS temp directory as its working directory. | Skip synthesis when environments are passed explicitly, or say in the docs that bootstrap runs the app. |
| 12 | Amazon Bedrock: least-privilege IAM for an inference profile takes guesswork | Scope `bedrock:InvokeModel` to the one model in `BEDROCK_MODEL_ID`, whether it is a foundation model ID or a cross-Region inference profile ID. | Read the inference profile prerequisites, the global cross-Region inference page and the supported profiles page. | Expected one resource ARN per model. Actual: a profile needs its own ARN plus the foundation model ARN in every destination Region, plus a Region-less ARN for `global.` profiles. The destination Regions come only from `GetInferenceProfile`, and the ID prefixes are not listed anywhere as a grammar. | medium | A wildcard Region on the model ARN, narrowed with a `bedrock:InferenceProfileArn` condition (`infra/lib/bedrock.ts`). | Let the profile ARN alone authorize the call, or publish the ID grammar and a managed policy snippet. |
| 13 | Amazon Location Service: prices are hard to read without a real browser | Work out what stored geocoding and static maps cost, to keep the deployment cheap. | Opened the pricing page in a headless browser and clicked the Places and Maps tabs; read the developer guide's pricing pages. | Expected price tables. Actual: the tab panels rendered empty (only the free tier table showed) and the developer guide links back without numbers. The Price List bulk JSON had the prices. It is also unclear whether "Stored" geocoding requests count toward the free tier. | medium | Read `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonLocationService/current/us-east-1/index.json`. | Put the prices in the page HTML, and state per request type whether the free tier applies. |
| 14 | AWS Systems Manager: unclear whether reading a SecureString with the AWS managed key needs `kms:Decrypt` | Let the Lambda functions read `/citydesk/*` SecureString parameters and nothing else. | Read the KMS documentation page on Parameter Store. | Expected an explicit statement for `alias/aws/ssm`. Actual: one sentence says the user needs `kms:Decrypt`, another says you cannot set access policies for the default key, and every example uses a customer managed key. | low | An explicit `kms:Decrypt` statement conditioned on `kms:ViaService` and the parameter's encryption context. | Add an `aws/ssm` example to that page. |
| 15 | AWS Lambda: the runtimes table lists a preview runtime next to GA ones | Pick the newest Node.js runtime for the functions. | Read the Lambda runtimes page and the `Runtime` constants in `aws-cdk-lib` 2.273.0. | Expected one answer. Actual: the supported-runtimes table lists `nodejs26.x` beside generally available runtimes, with a separate note that it is a public preview, while CDK stops at `NODEJS_24_X`. | low | `nodejs24.x`. | Mark preview status in the table row itself. |
| 16 | AWS Free Tier: no single list of what is always free | Classify each service CityDesk uses as always free, trial, or pay per use for `docs/aws.md`. | Read the Free Tier docs, the FAQ, aws.amazon.com/free and each service's pricing page. | Expected a list. Actual: the "over 30 always free services" are not named in readable text; Polly's page still says "first 12 months"; CloudFront's always-free allowance sits on a separate page behind the flat-rate plans. | medium | `docs/aws.md` marks what was confirmed and what was not. | One line on every pricing page: always free, trial, or credits only. |
| 17 | Boston Open311: the public hostname turns into an HTML challenge page under steady use | Download 60 days of requests for the duplicate replay while developing against the same API. | Called `https://311.boston.gov/open311/v2/requests.json` at 8 requests a minute with a descriptive User-Agent, plus a few interactive calls from the dev server. | Expected HTTP 429 with `Retry-After` when over the limit (the documented limit is about 10 a minute). Actual: after about 18 minutes the host answered every request with HTTP 200, `content-type: text/html`, and an Imperva/Incapsula JavaScript challenge page. Our client parsed that as "not JSON", the replay crashed at day 39 of 60, and live tool calls failed. The endpoint named in Boston's own discovery file (`boston2-production.spotmobile.net`) kept answering normally. | high | Use the endpoint the discovery document lists. The client now recognizes an HTML challenge as `rate_limited` (retryable) instead of bad data, and the replay resumes from its cache at a lower rate. | Exempt `/open311/` from the browser challenge or answer API clients with 429 and `Retry-After`, and say in the developer docs which hostname API clients should use. |
| 18 | MCP Apps (ext-apps): `AppBridge` forwards every tool call a card makes, whatever the tool's visibility | Let the cards call the app-only `static_map` tool, and nothing the assistant alone should call. | Read `connect()` in `@modelcontextprotocol/ext-apps/app-bridge` 2.0.3. Built a card that calls a tool declared `visibility: ["model"]` and ran it in a host that passes its MCP client to the bridge, as `basic-host` does. | The MCP Apps spec says the host must reject such calls. Actual: with a client passed in, the bridge forwards any `tools/call` to the server unchecked. | high (a card could file or follow requests on the resident's behalf) | `new AppBridge(null, ...)` with our own `oncalltool` handler that checks visibility before forwarding (`apps/sim-client/src/apps/host.ts`). | Enforce tool visibility inside the bridge, since every host needs it. |
| 19 | MCP Apps: `basic-host` cannot be deployed as static files on one origin | Serve the client, including the card sandbox, from one CloudFront origin. | Ported `examples/basic-host` at v2.0.3. | Expected a pattern that deploys. Actual: the card's CSP is an HTTP header computed by an Express server from a `?csp=` query string, the sandbox page lives on a second port, and the embedder check is hard-coded to localhost. | high | A sandbox page on the same host loaded in an iframe without `allow-same-origin` (the browser gives it an opaque origin), a `<meta>` CSP built per card, and a configurable embedder allowlist (`apps/sim-client/src/sandbox/`, `src/apps/csp.ts`). This departs from the spec's wording that the sandbox "MUST have allow-same-origin"; it works with `App` and `AppBridge` because the transport posts with `"*"`. | Document a static, single-origin host recipe, and let the spec permit opaque-origin sandboxes. |
| 20 | Browser: a sandboxed, opaque-origin page cannot load its own host's module script | Build the sandbox proxy page for entry 19. | Loaded the Vite-built page inside `<iframe sandbox="allow-scripts">`. | Expected the page's own `/assets/*.js` to load. Actual: Chrome blocked it ("from origin 'null' ... by CORS policy"), because module scripts are fetched with CORS and an opaque origin matches nothing. | medium | Bundle the proxy with esbuild and inline it into `sandbox.html`. | Call this out in the ext-apps host docs next to the sandbox section. |
| 21 | MCP Apps: the `App` SDK pulls 450 kB of zod into every card | Bundle each card as one self-contained HTML file. | A nine-line probe importing `App`, bundled with `esbuild --bundle --minify`. | Expected tens of kilobytes for a postMessage client. Actual: 587 kB, of which zod was 454 kB and its locale files 264 kB. | medium | An esbuild plugin stubs every `zod/v4/locales/*.js` except English, which brings a card's script to about 353 kB (`apps/citydesk/cards/build.ts`). | Import zod so locales tree-shake, or ship a slim prebundled `App`. |
| 22 | MCP Apps: `basic-host` calls a tool twice with `?call=true` | Auto-run a tool on page load for repeatable screenshots. | `npm start` in `examples/basic-host`, opened `/?server=...&tool=...&call=true`, read the console. | Expected one call. Actual: `[HOST] Calling tool` is logged twice per load with one panel rendered. The "Call Tool" button logs it once. | medium (harmless for fixtures, but it would file a real report twice) | Use the button for anything with side effects. | Guard the auto-call so it runs once. |
| 23 | MCP Apps: `basic-host` handles `ui/message` but does not advertise it, and has no fixed-size surface | Send a tapped clarification option back as a user message, and check the cards at an Echo Show sized surface. | Read `examples/basic-host/src/implementation.ts`; called `app.sendMessage`; looked for a way to set the container size or display mode. | Host capabilities list `openLinks`, `serverTools`, `serverResources` and `updateModelContext` but not `message`, yet the message arrives and is shown. The host only ever sends `maxHeight: 6000` and never a fixed container, so a card for a fixed screen cannot be exercised in the reference host. | medium | The cards always attempt `sendMessage` and fall back to "say it"; sizes were tested by making the iframe exactly 768 or 1280 pixels wide. | Declare `message` in basic-host, and add size presets and a display-mode toggle. |
| 24 | MCP Apps docs and helpers: small mismatches with the 2.0.3 package | Receive the tool result in a card and declare a photo CSP on its resource. | Followed `docs/quickstart.md` at v2.0.3, then read the type declarations and the `registerAppResource` source. | The quickstart uses `app.ontoolresult = ...`, which the 2.0.3 typings mark deprecated in favour of `addEventListener`. `registerAppResource` copies `_meta.ui` into the resource listing but not onto the content item hosts read first, so the CSP has to be repeated in the read callback. `require.resolve('@modelcontextprotocol/ext-apps/package.json')` fails because the path is not exported. | low | `addEventListener('toolresult', ...)`; `_meta.ui` set in both places (`apps/citydesk/src/cards/index.ts`). | Update the quickstart, mirror `_meta.ui` onto content items, and export a version constant. |
| 25 | MCP client SDK: a stateless server's allowed 405 shows up as a console error on every connect | Connect a browser MCP client to a stateless Streamable HTTP server. | Connected `StreamableHTTPClientTransport` to the CityDesk server and to a `createMcpHandler` server; read the browser console. | The client's standalone GET for a server-to-client stream gets the 405 the spec allows, and Chrome logs "Failed to load resource: 405" each time. Nothing is wrong, but it looks like a failure in a demo. | low | None; the developer drawer shows the connection as healthy. | An option to skip the GET when the server has said it is stateless. |
<!-- friction:end -->

---

## Video script (2:50)

Record the deployed client in Chrome at 1280x800 or larger. Before recording, run `pnpm demo:places`
against the deployed server and use the pothole address it prints, because it has to be a pothole
that is open today. Keep the developer drawer closed until the last scene.

| Time | On screen | Voice-over or what you say to the device |
| --- | --- | --- |
| 0:00 to 0:12 | Title card over a Boston street photo you own, then the idle Echo Show frame | "Cities get the same pothole reported five times. And you never hear what happened to yours. This is CityDesk: 311 for Alexa+." |
| 0:12 to 0:40 | Hold to talk. The issue card appears: "Already reported", map pin, photo, timeline | To the device: "There's a big pothole in front of [address from demo:places]." Let the reply play. Voice-over: "That is Boston's live data. Someone reported this pothole already, so CityDesk files nothing." |
| 0:40 to 0:52 | Card changes to "Following" | To the device: "Yes, follow that one." |
| 0:52 to 1:22 | Clarification card with three chips, then the "Filed" card with the Sandbox badge | To the device: "There's also a problem with the streetlight outside 1 City Hall Plaza." It asks its one question. Tap or say "It's flickering." Voice-over: "New reports go to a sandbox. CityDesk never writes to a city's production system." |
| 1:22 to 1:50 | Reload the page (a new session). List card with both requests, one marked updated | Voice-over: "The next day." To the device: "What's happening with my requests?" Voice-over: "It remembered both, across sessions, in DynamoDB, and tells me what changed." |
| 1:50 to 2:05 | Schedule card | To the device: "When does the trash go out at 700 Boylston Street?" |
| 2:05 to 2:30 | Open the developer drawer: initialize, tools/list, tools/call entries with timings; then the architecture diagram from the README | "Under the hood this is a self-hosted MCP server on AWS Lambda, speaking Streamable HTTP. This page is a real MCP client. Amazon Bedrock picks the tool, Amazon Location finds the place, Polly speaks, and the cards are MCP Apps." |
| 2:30 to 2:45 | The results table from the README | "We replayed twenty-three thousand real Boston requests. One in four infrastructure reports was filed while the same kind of problem was already open within fifty meters." |
| 2:45 to 2:50 | Repository URL and "open311-mcp on npm" | "It's built on Open311, so the next city is a config file. CityDesk." |

Checks before you upload: under three minutes; no third-party music or logos; the Sandbox badge is
visible when the report is filed; no token or key is on screen (the developer drawer does not show
the token).
