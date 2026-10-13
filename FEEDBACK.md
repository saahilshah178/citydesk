# Product feedback

What each tool was used for in CityDesk, what worked, and what did not. Filled in stage by stage.
Friction with a reproducible story lives in [FRICTION_LOG.md](FRICTION_LOG.md).

## MCP TypeScript SDK (`@modelcontextprotocol/server`, `@modelcontextprotocol/client` 2.3.1)

- **Used for:** The MCP server (tools, resources, Streamable HTTP) and the MCP client inside the web
  client.
- **Worked:** The server ships web-standard building blocks (`originValidationResponse`,
  `requireBearerAuth`, `WebStandardStreamableHTTPServerTransport`) that compose into a plain
  `fetch(Request)` handler, which is what a Lambda Function URL needs. The type declarations carry
  enough prose to work from without the website.
- **Worked:** `createMcpHandler` plus `isLegacyRequest` let one endpoint serve 2025-11-25 clients
  and 2026-07-28 clients from a single server factory; our conformance suite connects the official
  client in both modes. Declaring `outputSchema` with zod gave typed, validated results for free.
- **Did not work:** See friction entry 6: two package lines, a confusing version constant, and no
  JSON option on the stateless legacy fallback. A warning line is printed to the console on every
  process start when `responseMode: 'json'` is used, with no way to silence it.

## MCP Inspector (`@modelcontextprotocol/inspector` 2.10.1)

- **Used for:** The manual pass over both servers (`results/inspector/`).
- **Worked:** CLI mode is scriptable: `--method tools/call --tool-arg key=value` with JSON values for
  nested arguments, custom headers for the bearer token, and clean JSON on stdout.
- **Did not work:** It validates error results against `outputSchema` and reports only the schema
  failure (friction entry 8). With a wrong token it asks for interactive OAuth instead of showing
  the 401.

## MCP Apps (`@modelcontextprotocol/ext-apps` 2.0.3)

- **Used for:** The issue and schedule cards (`ui://` resources) and the app bridge in the client.
- _Filled in at stages 4 and 5._

## Amazon Bedrock

- **Used for:** The assistant model, through the Converse API with tool use.
- _Filled in at stage 5._

## AWS Lambda

- **Used for:** Hosting the MCP server and the client's backend routes.
- _Filled in at stage 6._

## Amazon DynamoDB

- **Used for:** Each user's filed and followed requests.
- _Filled in at stage 3._

## Amazon Location Service

- **Used for:** Geocoding spoken addresses and landmarks inside the city's bounding box.
- _Filled in at stage 3._

## Amazon Polly

- **Used for:** Speaking the assistant's replies.
- _Filled in at stage 5._

## AWS CDK

- **Used for:** Deploying everything.
- _Filled in at stage 6._

## Boston Open311

- **Used for:** Reading real service requests (duplicates, status) for Boston.
- **Worked:** Reads need no key and are fast (300 to 900 ms). `q`, `per_page` up to 300, `page`,
  `status`, `service_code`, `start_date`/`end_date`, and `extensions=true` all work. Single request
  lookup by ID works.
- **Did not work:** The test endpoint is gone, the service list is a small subset, and spatial filters
  are silently ignored (friction entries 1 to 4).

## SeeClickFix (test server)

- **Used for:** The sandbox where new reports are filed.
- **Worked:** The Open311 API answers without a key for reads, supports `lat`/`long` search, and
  returns service definitions with attributes.
- **Did not work:** Services exist only around New Haven and the docs are thin (friction entry 5).

## Boston trash schedules (data.boston.gov CKAN)

- **Used for:** Trash and recycling days by address.
- **Worked:** `datastore_search` with an exact `filters` match on `full_address` is fast, and
  `datastore_search_sql` is enabled for prefix matches.
- **Did not work:** Full-text `q` ranks unit numbers above street numbers ("700 Boylston St" returns
  "545 Boylston St 700" first), so it cannot be used directly for address lookup.
