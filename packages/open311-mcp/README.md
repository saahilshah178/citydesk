# open311-mcp

An [MCP](https://modelcontextprotocol.io) server and typed client for
[Open311 GeoReport v2](http://wiki.open311.org/GeoReport_v2), the API many US cities use for 311
service requests (potholes, streetlights, graffiti, missed trash).

Point it at any city that speaks GeoReport v2 and an AI assistant can list request types, search
existing requests by place and date, check a request's status, and file new requests into a sandbox.
It never writes to a city's production system unless you explicitly allow it.

- **City-agnostic.** A city is a config entry: base URL, test URL, API key variable, rate limit,
  bounding box. Boston and New Haven (SeeClickFix) are built in.
- **Safe by default.** `create_request` only reaches endpoints declared as test endpoints. The guard
  runs before any request is built.
- **Polite.** Per-endpoint rate limiting, retries with backoff for reads, and no blind retry of
  writes, so a report is never filed twice.
- **Runs anywhere.** stdio for desktop clients, Streamable HTTP as one web-standard
  `(Request) => Response` function, with adapters for `node:http` and AWS Lambda Function URLs.
- **Comes with a sandbox.** A small in-process GeoReport v2 server for development and tests, because
  real city sandboxes come and go.

Built on the official MCP TypeScript SDK (`@modelcontextprotocol/server` 2.x). Node.js 22 or newer.

## Quick start

```bash
npm install -g open311-mcp

# stdio, for desktop MCP clients
open311-mcp

# Streamable HTTP at http://localhost:8080/mcp, with a sandbox city you can file into
MCP_BEARER_TOKENS=change-me open311-mcp --http --sandbox
```

For a desktop client that launches stdio servers:

```json
{
  "mcpServers": {
    "open311": { "command": "npx", "args": ["-y", "open311-mcp", "--sandbox"] }
  }
}
```

Try it with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:8080/mcp --transport http \
  --header "Authorization: Bearer change-me" \
  --method tools/call --tool-name search_requests \
  --tool-arg city=boston status=open 'near={"lat":42.3525,"long":-71.125,"radius_meters":100}'
```

## Tools

| Tool | When the assistant calls it | Returns |
| --- | --- | --- |
| `list_cities` | First, to learn which cities are covered | City keys, bounding boxes, endpoints and whether each accepts writes |
| `list_services` | To find the request types a city accepts | Service codes, names, groups, and whether a service has extra questions |
| `get_service_definition` | Before filing a request whose service has `metadata: true` | The questions in order, which are required, and allowed values |
| `search_requests` | To find existing requests by type, status, date, bounding box, or distance from a point | Matching requests with IDs, status, address, coordinates, and dates |
| `get_request` | To check one request by ID | The request with its status, latest notes, and dates |
| `create_request` | To file a new request, after checking for duplicates | The new request ID (or token), the endpoint it went to, and the time |

Every result has a text summary for the model and `structuredContent` with IDs and ISO 8601 dates.
Every failure is `isError: true` with `structuredContent.error = { code, message, retryable }`.

## Configuring cities

Pass `--cities cities.json` (or set `OPEN311_CITIES_FILE`). This two-city file ships with the
package as [`examples.cities.json`](examples.cities.json): Boston on its own Open311 server, and New
Haven on SeeClickFix.

```json
[
  {
    "id": "boston",
    "name": "Boston",
    "timeZone": "America/New_York",
    "bbox": [-71.1912, 42.2279, -70.986, 42.3995],
    "production": {
      "id": "boston",
      "kind": "production",
      "baseUrl": "https://311.boston.gov/open311/v2",
      "apiKeyEnv": "BOSTON_OPEN311_API_KEY",
      "rateLimitPerMinute": 10,
      "maxDateSpanDays": 90,
      "pageParam": "page",
      "pageSizeParam": "per_page",
      "pageSize": 300,
      "spatial": "none",
      "textSearch": true,
      "extensions": true
    },
    "test": {
      "id": "boston-test",
      "kind": "test",
      "baseUrl": "https://boston2-test.spotmobile.net/open311/v2",
      "apiKeyEnv": "BOSTON_OPEN311_API_KEY",
      "rateLimitPerMinute": 10,
      "pageParam": "page",
      "pageSizeParam": "per_page",
      "pageSize": 300,
      "spatial": "none"
    }
  },
  {
    "id": "new-haven",
    "name": "New Haven",
    "timeZone": "America/New_York",
    "bbox": [-72.998, 41.246, -72.861, 41.351],
    "production": {
      "id": "new-haven",
      "kind": "production",
      "baseUrl": "https://seeclickfix.com/open311/v2",
      "apiKeyEnv": "SEECLICKFIX_API_KEY",
      "rateLimitPerMinute": 20,
      "pageParam": "page",
      "spatial": "point",
      "referencePoint": { "lat": 41.3083, "long": -72.9279 }
    },
    "test": {
      "id": "seeclickfix-test",
      "kind": "test",
      "baseUrl": "https://test.seeclickfix.com/open311/v2",
      "apiKeyEnv": "SEECLICKFIX_API_KEY",
      "rateLimitPerMinute": 20,
      "pageParam": "page",
      "spatial": "point",
      "referencePoint": { "lat": 41.3083, "long": -72.9279 }
    }
  }
]
```

| Field | Meaning |
| --- | --- |
| `id`, `name`, `timeZone` | City key used in tool calls, display name, IANA time zone |
| `bbox` | `[minLongitude, minLatitude, maxLongitude, maxLatitude]` of the service area |
| `production`, `test` | The city's live endpoint and its sandbox. A city needs at least one |
| `baseUrl` | GeoReport v2 base URL, no trailing slash |
| `apiKeyEnv` | Name of the environment variable holding the API key. Keys are never in the file |
| `rateLimitPerMinute` | Requests per minute the client allows itself against this endpoint |
| `maxDateSpanDays` | Longest date range the server accepts (default 90). Longer searches are split |
| `pageParam`, `pageSizeParam`, `pageSize` | Paging parameter names and the page size to ask for |
| `spatial` | `"point"` if the server narrows by `lat` and `long`; `"none"` if it ignores them |
| `referencePoint` | Sent as `lat`/`long` when the caller gives no location (SeeClickFix scopes by point) |
| `textSearch`, `extensions` | Whether the server supports `q` and `extensions=true` |
| `jurisdictionId` | Sent as `jurisdiction_id`, for multi-tenant servers |

Bounding-box and radius filters are always applied in the client as well, because some servers
accept spatial parameters and silently ignore them.

## How writes stay in sandboxes

`create_request` and `Open311Client.createRequest` go through one guard (`src/guard.ts`):

1. The target endpoint must be declared `"kind": "test"`.
2. A test endpoint that points at the same server as the city's production endpoint is refused, which
   catches a copy-paste mistake in config. Config validation rejects it too.
3. Production writes are possible only when `ALLOW_PRODUCTION_WRITES` is exactly the string `true`.

The guard throws before any request body is built or sent. A failed POST is never retried after a
network error or a 5xx, because the server may have accepted it.

## The built-in sandbox

`--sandbox` adds `sandbox-city`, backed by an in-process GeoReport v2 server (`createSandbox()`):
services, service definitions with required attributes, create, read, list with the standard
filters, and `[{ code, description }]` errors. Over HTTP it is also mounted at `/open311/v2`. An
optional lifecycle moves a request from received to assigned to closed as it ages, and every
simulated note says it is simulated. Nothing filed there is forwarded anywhere.

## Using it as a library

```ts
import { BOSTON, Open311Client } from 'open311-mcp';

const boston = new Open311Client(BOSTON);

// Open potholes within 50 m of a point, nearest first.
const nearby = await boston.searchRequests({
  serviceCode: '9aaa7721-e212-4d16-a77e-d8f8d2f4ba28',
  status: 'open',
  startDate: new Date(Date.now() - 30 * 86_400_000),
  near: { lat: 42.3525, long: -71.125, radiusMeters: 50 },
});
```

Serve the tools over Streamable HTTP, anywhere that has `fetch`-style handlers:

```ts
import { createServer } from 'node:http';
import { createMcpHttpHandler, createOpen311Server, toNodeListener, toFunctionUrlHandler } from 'open311-mcp';

const handler = createMcpHttpHandler({
  factory: () => createOpen311Server(),
  bearerTokens: [process.env.MCP_TOKEN!],
  allowedOrigins: ['https://app.example.com'],
});

createServer(toNodeListener(handler)).listen(8080); // Node
export const lambdaHandler = toFunctionUrlHandler(handler); // AWS Lambda Function URL
```

`createMcpHttpHandler` implements the Streamable HTTP transport for MCP spec 2025-11-25 and also
serves 2026-07-28 clients from the same endpoint: Origin validation (403), bearer tokens (401 with a
`WWW-Authenticate` challenge), `MCP-Protocol-Version` checks (400), JSON responses, 405 on GET when
no SSE stream is offered, and optional in-memory sessions (`sessions: 'memory'`). It works with any
MCP server factory, not only the Open311 one.

## Environment variables

| Variable | Used for |
| --- | --- |
| `MCP_BEARER_TOKENS` | Comma-separated tokens accepted by `--http`. Empty means no authentication |
| `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call `--http` (default localhost) |
| `PORT` | Port for `--http` (default 8080) |
| `OPEN311_CITIES_FILE` | Path to your city config |
| `ALLOW_PRODUCTION_WRITES` | Set to `true` to let `create_request` reach production endpoints |
| `BOSTON_OPEN311_API_KEY`, `SEECLICKFIX_API_KEY`, ... | Whatever your configs name in `apiKeyEnv` |

## What we learned about real endpoints

Recorded on 2026-10-13. Details are in the project's
[friction log](https://github.com/saahilshah178/citydesk/blob/main/FRICTION_LOG.md).

- **Boston** lists 6 fileable services, but requests of about 60 types are readable.
  `Open311Client.observedServices()` builds the read catalog from recent requests. Spatial parameters
  are ignored, page size tops out at 300, and comma-separated `service_request_id` lookups work.
  The test endpoint named in Boston's discovery file did not resolve.
- **SeeClickFix** scopes services and requests by coordinates, returns numeric IDs (normalized to
  strings here), and pages with `page`. Reads against `test.seeclickfix.com` are covered by recorded
  fixtures. Creating requests there was not verified: unauthenticated `POST /open311/v2/requests.json`
  returned 404 and the native API requires an account token.

## Limitations

- JSON only (no XML endpoints).
- Rate limiting is per process. Behind several instances, each one has its own budget.
- `create_request` has been exercised end to end against the built-in sandbox only.
- No media upload: `media_url` is passed through as a URL.

## Development

```bash
pnpm install
pnpm --filter open311-mcp test        # replays recorded fixtures; no network
pnpm --filter open311-mcp build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a city.

## License

MIT
