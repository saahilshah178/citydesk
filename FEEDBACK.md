# Product feedback

One section per tool, API, or SDK used in CityDesk, answering the five questions the hackathon asks:
what we used it for, what worked well, what needs work, how onboarding went, and whether we would
build with it again. Reproducible problems are written up in full in
[FRICTION_LOG.md](FRICTION_LOG.md); entry numbers are given here.

Where something has not been exercised against the live service yet, this file says so.

---

## MCP TypeScript SDK (`@modelcontextprotocol/server`, `@modelcontextprotocol/client` 2.3.1)

- **Used for:** The MCP server (tools, resources, Streamable HTTP) in `packages/open311-mcp/src/http.ts`
  and `apps/citydesk/src/server.ts`, the stdio entry in `packages/open311-mcp/src/bin.ts`, and the MCP
  client in the web client and in the test suites.
- **Worked well:** The server ships web-standard building blocks (`validateOriginHeader`,
  `requireBearerAuth`, `WebStandardStreamableHTTPServerTransport`, `createMcpHandler`,
  `isLegacyRequest`) that compose into one `fetch(Request)` function, which is exactly what a Lambda
  Function URL needs. One endpoint serves 2025-11-25 clients and 2026-07-28 clients from a single
  server factory; our conformance suite connects the official client both ways. Declaring
  `outputSchema` with zod gave typed, validated results. The type declarations carry enough prose to
  work from without the website.
- **Needs work:** Two package lines exist side by side, and the constant `LATEST_PROTOCOL_VERSION` is
  `2025-11-25` in a package whose README says it implements 2026-07-28 (entry 6). The stateless
  fallback for 2025-era clients answers in SSE with no JSON option, so we wired the transport
  ourselves. A warning is printed on every process start when `responseMode: 'json'` is used.
- **Onboarding:** About an hour from `npm view` to a passing `initialize` over HTTP, most of it spent
  working out which package line to use and reading `.d.mts` files.
- **Build with it again:** Yes. The primitives are right and the same server code runs on stdio, Node
  and Lambda.

## MCP Inspector (`@modelcontextprotocol/inspector` 2.10.1)

- **Used for:** The manual pass over both servers (`results/inspector/`).
- **Worked well:** CLI mode is scriptable: `--method tools/call --tool-arg key=value`, JSON values for
  nested arguments, custom headers for the bearer token, clean JSON on stdout, and stdio or HTTP
  targets with the same flags.
- **Needs work:** It validates error results against `outputSchema` and reports only the schema
  failure, hiding the tool's own error (entry 8). With a wrong token it asks for interactive OAuth
  instead of showing the 401.
- **Onboarding:** Minutes. `npx @modelcontextprotocol/inspector --cli <url> --method tools/list`
  worked the first time.
- **Build with it again:** Yes. It caught a real conformance gap in our error results.

## MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **Used for:** The issue card and schedule card (`ui://` resources) and the app bridge in the web
  client.
- _Filled in at stages 4 and 5._

## Amazon Bedrock

- **Used for:** The assistant model, through the Converse API with tool use
  (`apps/sim-client/server/`).
- _Filled in at stage 5. Not yet called live: this build machine had no AWS credentials._

## AWS Lambda

- **Used for:** Hosting the MCP server (`apps/citydesk/src/lambda.ts`) and the web client's backend
  routes behind Function URLs.
- _Filled in at stage 6. Not yet deployed._

## Amazon DynamoDB

- **Used for:** Each household's filed and followed requests, their saved home address, the sandbox's
  requests, and hourly filing counters, in one table (`apps/citydesk/src/store/dynamo.ts`).
- _Filled in at stage 6. Exercised so far only against an in-memory stand-in for the document client
  (`apps/citydesk/test/fakeDynamo.ts`)._

## Amazon Location Service

- **Used for:** Geocoding spoken addresses and landmarks inside the city's bounding box with
  `SearchPlaceIndexForText` (`apps/citydesk/src/geocode/amazonLocation.ts`), and map images for the
  issue card with `GetStaticMap` (`apps/citydesk/src/aws/staticMap.ts`).
- _Filled in at stage 6. The request shape and the result interpretation are unit-tested; no live
  call has been made yet._

## Amazon Polly

- **Used for:** Speaking the assistant's replies.
- _Filled in at stage 5. Not yet called live._

## AWS CDK (`aws-cdk-lib` 2.273.0)

- **Used for:** The whole deployment in `infra/`: two Lambda functions with Function URLs, DynamoDB,
  the Location place index, S3 and CloudFront, and a Parameter Store entry.
- **Worked well:** An environment-agnostic `cdk synth` needs no credentials, and template assertions
  plus real esbuild bundling run in about ten seconds, so 49 infrastructure tests run on every change.
  `addFunctionUrl` emits both permissions Lambda has required since October 2025. The S3 origin access
  control, `FunctionUrlOrigin` and managed cache policies gave a three-behaviour distribution in about
  25 lines.
- **Needs work:** esbuild resolution under pnpm would have broken the first deploy (entry 10).
  `cdk bootstrap` with an explicit environment still synthesizes the app (entry 11). Least privilege
  takes hand-made roles: the default role, `BucketDeployment` and `autoDeleteObjects` all use
  `AWSLambdaBasicExecutionRole`. Uploading one folder adds two helper Lambdas, two roles and a 22 MB
  AWS CLI layer. There is no helper for Bedrock inference-profile grants (entry 12).
- **Onboarding:** Smooth for the stack itself; the time went into IAM scoping and reading pricing
  (entries 12 to 16).
- **Build with it again:** Yes, for the testable templates. We would budget time for IAM.

## Boston Open311 (GeoReport v2)

- **Used for:** Reading real service requests: the duplicate check, request status, and the
  30-day replay in `results/dupes.json`.
- **Worked well:** Reads need no key and answer in 0.3 to 0.9 seconds. `per_page` up to 300, `page`,
  `status`, `service_code`, date ranges, free-text `q`, `extensions=true`, and comma-separated
  `service_request_id` lookups all work. Requests carry coordinates, status notes and photos.
- **Needs work:** The test endpoint in the discovery file does not resolve (entry 1). The service list
  covers 6 of about 60 request types (entry 2). Spatial filters are ignored without an error
  (entry 3). A service code containing a dot cannot be looked up (entry 4). The public hostname
  answers steady API traffic with an HTML challenge page and HTTP 200 instead of a 429 (entry 17).
- **Onboarding:** The first useful response took one `curl`. Learning the real behaviour took an
  afternoon of probing, because none of the above is documented.
- **Build with it again:** Yes for reads: it is real, current, citywide data. Not for writes until a
  working sandbox exists.

## SeeClickFix (test server, Open311 API)

- **Used for:** The second city config in `open311-mcp` (New Haven), with reads recorded as test
  fixtures. It was meant to be the write sandbox.
- **Worked well:** Keyless reads, `lat`/`long` search, paging with `page`, and service definitions with
  attributes all work on `test.seeclickfix.com`.
- **Needs work:** Services exist only around New Haven, so nothing can be filed at Boston
  coordinates (entry 5). Creating a request was not possible without an account: the unscoped
  `POST /open311/v2/requests.json` answers 404 and the native API answers 401. The Open311 page says
  nothing about what a POST needs or how the sandbox is seeded.
- **Onboarding:** Reads: minutes. Writes: blocked.
- **Build with it again:** Yes for reads. For writes we would need an API key and clearer docs.

## Boston open data portal (data.boston.gov, CKAN)

- **Used for:** "Trash Schedules by Address": collection days, and address points as a fallback
  geocoder (`apps/citydesk/src/addresses.ts`, `apps/citydesk/src/addressIndex.ts`).
- **Worked well:** The dataset is complete (399,489 address rows), refreshed in the last two days, has
  a data dictionary, and downloads as one CSV in about eight seconds.
- **Needs work:** Single-address lookups through the datastore API take 2 to 5 seconds and sometimes
  time out; the exact-match filter is case-sensitive; full-text search ranks unit numbers above street
  numbers (entry 9). We ended up building a local index from the CSV (`pnpm sync:addresses`).
- **Onboarding:** Easy: the resource ID and one `datastore_search` call.
- **Build with it again:** Yes, as a bulk source. Not as a live lookup API for voice.

## pnpm 12

- **Used for:** The workspace.
- **Worked well:** Fast installs, workspace links, lockfile supply-chain checks.
- **Needs work:** A fresh install exits 1 on an unapproved build script (entry 7), and it writes
  `minimumReleaseAgeExclude` entries into the workspace file on its own.
- **Onboarding:** One surprise, one command to fix it.
- **Build with it again:** Yes.
