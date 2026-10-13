# Friction log

Every time a tool, SDK, API, or doc surprised us while building CityDesk. Each entry has the same six
fields: task, steps taken, expected vs actual, severity, workaround, suggestion.

Severity scale: **blocker** (stopped the work), **high** (forced a redesign), **medium** (cost real
time), **low** (papercut).

---

## 1. Boston Open311: the test endpoint in the discovery file does not resolve

- **Task:** Find a safe write target for Boston so new reports never touch production.
- **Steps taken:** Fetched `https://311.boston.gov/open311/discovery.json`, took the endpoint with
  `"type": "test"` (`https://boston2-test.spotmobile.net/open311/v2`), requested `/services.json`.
  Re-checked DNS against 1.1.1.1 and 8.8.8.8.
- **Expected vs actual:** Expected a working sandbox. Actual: the hostname has no DNS record on either
  resolver (`ENOTFOUND`), while the production host in the same file resolves fine.
- **Severity:** high
- **Workaround:** Boston is read-only in CityDesk. New reports are filed in the SeeClickFix test
  server instead, and `pnpm smoke` reports the Boston test endpoint as degraded on every run.
- **Suggestion:** Remove dead endpoints from the discovery file or restore the host. A `status` field
  per endpoint in discovery would let clients tell "retired" from "temporarily down".

## 2. Boston Open311: the service list covers 6 request types, but requests come in dozens

- **Task:** Let a resident report a pothole or a broken streetlight.
- **Steps taken:** `GET /services.json`, then `GET /requests.json` and compared `service_name` values.
- **Expected vs actual:** Expected the service list to include the common request types. Actual: it
  lists 6 (Street Outreach & Encampments, Other, Illegal Parking, Abandoned Vehicle, Rodent Sighting,
  Abandoned Bicycle). Pothole and Street Light Outage requests are readable through `/requests.json`
  with their own `service_code`, but `GET /services/{that code}.json` answers
  `404 Invalid service code`.
- **Severity:** high
- **Workaround:** The client builds a read catalog from the service codes seen in recent requests and
  keeps it separate from the fileable list.
- **Suggestion:** Document which services are read-only through the API, or add a
  `"fileable": false` flag so the full catalog can be listed.

## 3. Boston Open311: spatial filters are ignored without an error

- **Task:** Search open requests near a point to detect duplicates.
- **Steps taken:** Called `/requests.json` with `lat`/`long`/`radius`, then `bbox=`, then
  `min_lat`/`max_lat`/`min_long`/`max_long`.
- **Expected vs actual:** Expected either a filtered result or a 400. Actual: HTTP 200 with the same
  unfiltered citywide page each time.
- **Severity:** medium
- **Workaround:** Filter by service code, status, and date on the server, then apply the bounding box
  and distance in the client. Page size goes up to 300 (`per_page=500` returns 300).
- **Suggestion:** Reject unknown query parameters with a 400, and list the supported extensions
  (`q`, `per_page`, `page`, `extensions`) in the discovery file.

## 4. Boston Open311: a service code containing a dot cannot be looked up

- **Task:** Fetch the service definition for every service with `metadata: true`.
- **Steps taken:** `GET /services/input.Rodent%20Sighting.json` (the code is `input.Rodent Sighting`).
- **Expected vs actual:** Expected the attribute list. Actual: an HTML 404 page, not the Open311 JSON
  error. Codes with colons and ampersands work when percent-encoded; the dot is read as a format
  extension.
- **Severity:** low
- **Workaround:** Treat a non-JSON 404 as "definition unavailable" and file without attributes.
- **Suggestion:** Use opaque IDs for service codes (most Boston codes already are UUIDs).

## 5. SeeClickFix sandbox: services depend on coordinates, and there are none at Boston

- **Task:** Use `test.seeclickfix.com` as the sandbox for Boston reports.
- **Steps taken:** `GET /open311/v2/services.json?lat=42.3493&long=-71.0782` (Boston) and again with
  New Haven coordinates. Looked for the Open311 docs under `dev.seeclickfix.com`.
- **Expected vs actual:** Expected a usable service list wherever the sandbox is queried. Actual: `[]`
  at Boston, 118 test services around New Haven. `dev.seeclickfix.com/open311/` is a 404; the only
  Open311 page (`seeclickfix.com/open311/v2/docs`) is a few paragraphs with no mention of how the
  sandbox is seeded or what POST requires.
- **Severity:** medium
- **Workaround:** The sandbox city config carries its own reference coordinates for service
  discovery.
- **Suggestion:** Document the sandbox: where services exist, whether an API key is needed to create
  requests, and how long test data lives.

## 6. MCP TypeScript SDK: two package lines, and the version constant does not match the README

- **Task:** Pick the official MCP SDK and target spec 2025-11-25 over Streamable HTTP.
- **Steps taken:** `npm view @modelcontextprotocol/sdk` (1.32.1), then found
  `@modelcontextprotocol/server` and `/client` at 2.3.1. `@modelcontextprotocol/ext-apps@2` lists the
  v2 packages as peers, so v1 is not an option alongside it.
- **Expected vs actual:** Expected one obvious package. Actual: the v2 README says it implements the
  2026-07-28 spec, yet the exported `LATEST_PROTOCOL_VERSION` is `"2025-11-25"`; 2025-era clients are
  served by a separate "legacy" path. The stateless legacy fallback in `createMcpHandler` answers
  with SSE, and there is no option to make it return JSON.
- **Severity:** medium
- **Workaround:** Route with `isLegacyRequest` in front of a `legacy: 'reject'` handler and serve
  2025-era requests through `WebStandardStreamableHTTPServerTransport` with
  `enableJsonResponse: true`.
- **Suggestion:** Rename the constant (or add `LATEST_LEGACY_PROTOCOL_VERSION`), and give
  `createMcpHandler` a JSON option for the legacy leg, since buffered hosts like Lambda need it.

## 7. pnpm 12: a fresh install fails until build scripts are approved

- **Task:** `pnpm install` in a new workspace that depends on `tsx` (which pulls in esbuild).
- **Steps taken:** Ran `pnpm install`.
- **Expected vs actual:** Expected a warning. Actual: exit code 1 with `ERR_PNPM_IGNORED_BUILDS`.
  `pnpm approve-builds esbuild` fixed it and also wrote `minimumReleaseAgeExclude` entries for
  packages published in the last few days.
- **Severity:** low
- **Workaround:** `allowBuilds: { esbuild: true }` is committed in `pnpm-workspace.yaml`.
- **Suggestion:** Name the exact `pnpm approve-builds <pkg>` command in the error text.
