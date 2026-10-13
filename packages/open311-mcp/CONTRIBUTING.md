# Contributing to open311-mcp

Thanks for helping make city services easier to reach. The most useful contributions are new city
configs and fixes for the ways real GeoReport v2 servers differ from the spec.

## Setup

```bash
git clone https://github.com/saahilshah178/citydesk.git
cd citydesk
pnpm install
pnpm --filter open311-mcp test
```

The package lives in `packages/open311-mcp`. It needs Node.js 22 or newer and pnpm.

## Ground rules

- **Tests never touch the network.** They replay recorded responses through a fake `fetch`
  (`test/helpers.ts`). A test that makes a live call fails, by design.
- **Writes go to sandboxes.** Do not weaken `src/guard.ts`. A change there needs a test for every
  path that could reach a production endpoint.
- **Be polite to cities.** These are public services with small rate limits. When you record
  fixtures, make a handful of requests, not hundreds.
- **No secrets in the repo.** API keys are read from environment variables named by `apiKeyEnv`.

## Adding a city

1. Find the city's GeoReport v2 base URL (many publish a `discovery.json`) and whether it has a test
   endpoint.
2. Add a config. Start in a JSON file and run the server with `--cities your.json`. If the city is
   widely useful, add it to `src/cities.ts` and to `BUILT_IN_CITIES`.
3. Check how the server really behaves, since the spec leaves a lot open:
   - Does `GET /services.json` need a location (`referencePoint`)?
   - Which paging parameters does it honor, and what is the largest page?
   - Does it filter by `lat`/`long`, or ignore them (`spatial`)?
   - Does it support `q` or `extensions=true`?
   - How wide a date range will it accept (`maxDateSpanDays`)?
4. Record fixtures: save a few real responses under `test/fixtures/<city>/`. Before committing,
   replace every resident-written `description` with a placeholder and point `media_url` at a
   placeholder path. Note where each file came from in `test/fixtures/README.md`.
5. Add tests that replay them, including at least one for anything the server does differently.
6. Run `pnpm --filter open311-mcp typecheck` and `pnpm --filter open311-mcp test`.

## Reporting a quirk

If a city's server behaves in a way the client does not handle, open an issue with the request URL
(without your API key), the response status, and the first few hundred characters of the body. A
recorded fixture is even better.

## Code style

TypeScript, strict mode, ES modules, no default exports. Keep comments about why, not what. Every
tool description says when to call the tool, why, and what it returns; every tool result carries IDs
and dates; every failure is a structured error.

## Releasing

Maintainers: bump `version` in `package.json` and `SERVER_VERSION` in `src/server.ts`, then run
`npm publish` from `packages/open311-mcp`. `prepublishOnly` builds and runs the tests.

## License

By contributing you agree that your contribution is licensed under the MIT License.
