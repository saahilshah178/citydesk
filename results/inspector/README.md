# Manual pass with the MCP Inspector

Run on 2026-10-13 with `@modelcontextprotocol/inspector@2.10.1` in CLI mode against servers running
locally over Streamable HTTP. Each JSON file here is the Inspector's unedited output for one call.

```bash
# generic Open311 server (packages/open311-mcp)
MCP_BEARER_TOKENS=inspector-token PORT=8791 node packages/open311-mcp/dist/bin.js --http --sandbox
npx @modelcontextprotocol/inspector --cli http://localhost:8791/mcp --transport http \
  --header "Authorization: Bearer inspector-token" --method tools/list

# CityDesk server (apps/citydesk), live Boston data
pnpm dev:server
npx @modelcontextprotocol/inspector --cli http://localhost:8787/mcp --transport http \
  --header "Authorization: Bearer dev-local-token" "X-CityDesk-Device: inspector-pass-01" \
  --method tools/call --tool-name report_issue \
  --tool-arg issue_type=pothole "description=There is a huge pothole in the road" "location=1079 Commonwealth Avenue"
```

| File | Call | What it shows |
| --- | --- | --- |
| `open311-tools-list.json` | `tools/list` | the six generic Open311 tools |
| `open311-call-list_services.json` | `list_services city=boston` | live read from Boston |
| `open311-call-create_request.json` | `create_request city=sandbox-city` | a write that lands in the built-in sandbox |
| `citydesk-tools-list.json` | `tools/list` | the six CityDesk tools with input and output schemas |
| `citydesk-1-report-pothole.json` | `report_issue` | a real open pothole 36 m away is returned instead of filing |
| `citydesk-2-follow.json` | `follow_request` | the resident now follows that Boston request |
| `citydesk-3-report-streetlight.json` | `report_issue` | one follow-up question from the service definition |
| `citydesk-4-report-streetlight-answer.json` | `report_issue` with `details` | filed in the sandbox |
| `citydesk-5-my-requests.json` | `my_requests` | both requests, one production and one sandbox |
| `citydesk-6-collection-schedule.json` | `collection_schedule` | trash and recycling days from data.boston.gov |
| `citydesk-7-status-unknown.json` | `request_status` with an unknown ID | a structured error with `isError: true` |

A wrong bearer token makes the Inspector stop with `auth_required` before any tool call.
The first attempt at this pass failed and led to a fix: see friction log entry 8.
