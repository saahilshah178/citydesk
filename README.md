# CityDesk

City services by voice. CityDesk is an Alexa+ style integration built as a self-hosted
[MCP](https://modelcontextprotocol.io) server: a resident can report a problem, hear whether a
neighbor already reported it and follow that report instead, check on their requests later, and ask
when trash and recycling go out. It speaks [Open311 GeoReport v2](http://wiki.open311.org/GeoReport_v2),
starting with Boston.

> Status: under construction for Amazon's "Build, Ship, Shape" hackathon (Alexa+ track). This README
> is filled in as each stage lands.

## Layout

| Path | What it is |
| --- | --- |
| `packages/open311-mcp` | City-agnostic Open311 client and MCP server (the open-source package) |
| `apps/citydesk` | CityDesk tools, per-user memory, deployment entry points |
| `apps/sim-client` | Echo Show style web client: a real MCP client with a Bedrock assistant |
| `infra` | AWS CDK stack |
| `scripts` | Smoke test and data replays; outputs land in `results/` |

## Quick check

```bash
pnpm install
cp .env.example .env
pnpm smoke        # probes Boston Open311, the SeeClickFix sandbox, trash schedules, and Bedrock
```

## Writes stay in sandboxes

CityDesk never files into a city's production system. Request creation is only allowed against
endpoints marked as sandboxes unless `ALLOW_PRODUCTION_WRITES=true` is set.

## License

MIT. See [LICENSE](LICENSE).
