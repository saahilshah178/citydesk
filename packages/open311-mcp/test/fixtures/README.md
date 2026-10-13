# Recorded fixtures

Real responses recorded on 2026-10-13 from the public, keyless read APIs. Tests replay them through
a fake `fetch`; no test makes a network call.

| File | Recorded from |
| --- | --- |
| `boston/discovery.json` | `GET https://311.boston.gov/open311/discovery.json` |
| `boston/services.json` | `GET https://311.boston.gov/open311/v2/services.json` |
| `boston/service_definition.json` | `GET .../services/8638e79a-2a0a-4d3a-9624-792ec40b0691.json` |
| `boston/requests_page1.json`, `requests_page2.json` | `GET .../requests.json?per_page=8` and `&page=2` |
| `boston/request_single.json` | first row of page 1, in the shape `GET .../requests/{id}.json` returns |
| `boston/potholes_open.json` | `GET .../requests.json?service_code=9aaa7721-...&status=open&per_page=40` |
| `boston/error_invalid_service.json` | `GET .../services/{unlisted code}.json` (HTTP 404) |
| `boston/not_found.html` | trimmed copy of the HTML 404 page for a service code containing a dot |
| `seeclickfix/services.json` | `GET https://test.seeclickfix.com/open311/v2/services.json?lat=41.3083&long=-72.9279` (9 of 118 kept) |
| `seeclickfix/requests.json` | `GET .../requests.json?lat=41.3083&long=-72.9279` (first 8) |
| `seeclickfix/service_definition.json` | `GET .../services/10044.json` |

Sanitized before committing: every resident-written `description` is replaced with a placeholder,
every `media_url` points at a placeholder path on the same host, and `extended_attributes` is
dropped. IDs, codes, timestamps, addresses and coordinates are as recorded (they are public records).
