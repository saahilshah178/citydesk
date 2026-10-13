/**
 * A small Open311 GeoReport v2 server you can run in-process or mount on any HTTP server.
 *
 * It exists because real city sandboxes come and go: it gives create-request flows a safe target
 * that speaks the same wire format (form-encoded POST, JSON responses, `[{code, description}]`
 * errors). Requests filed here are never forwarded anywhere.
 *
 * Optional lifecycle simulation moves a request from "received" to "assigned" to "closed" as it
 * ages, so status checks have something to show. Every simulated note says it is simulated.
 */
import type { EndpointConfig } from './cities.ts';
import { haversineMeters } from './geo.ts';
import type { Service, ServiceAttribute } from './types.ts';

export interface SandboxService extends Service {
  /** Agency named in simulated status notes. */
  agency?: string;
  attributes?: ServiceAttribute[];
}

export interface SandboxRequestRecord {
  service_request_id: string;
  token: string;
  service_code: string;
  service_name: string;
  description?: string;
  address?: string;
  address_id?: string;
  lat?: number;
  long?: number;
  media_url?: string;
  /** Epoch milliseconds. */
  requested_at: number;
  attributes?: Record<string, string | string[]>;
  device_id?: string;
}

/** Where the sandbox keeps its requests. The default is in memory; back it with a database to persist. */
export interface SandboxStore {
  put(record: SandboxRequestRecord): Promise<void>;
  get(id: string): Promise<SandboxRequestRecord | undefined>;
  list(): Promise<SandboxRequestRecord[]>;
}

export class MemorySandboxStore implements SandboxStore {
  private readonly records = new Map<string, SandboxRequestRecord>();
  async put(record: SandboxRequestRecord): Promise<void> {
    this.records.set(record.service_request_id, record);
  }
  async get(id: string): Promise<SandboxRequestRecord | undefined> {
    return this.records.get(id);
  }
  async list(): Promise<SandboxRequestRecord[]> {
    return [...this.records.values()];
  }
}

export interface SandboxLifecycle {
  /** Age at which a request shows as assigned to a crew. */
  assignAfterMs: number;
  /** Age at which a request shows as closed. */
  closeAfterMs: number;
}

export interface SandboxOptions {
  /** Path prefix the handler is mounted under. Default "/open311/v2". */
  basePath?: string;
  services?: SandboxService[];
  store?: SandboxStore;
  /** Pass false to keep every request open forever. Default: assigned after 2 minutes, closed after 20 hours. */
  lifecycle?: SandboxLifecycle | false;
  now?: () => number;
  /** Generates the ID for a new request. Default: "SB-" plus five digits. */
  generateId?: () => string;
  /** Name shown in the discovery document and status notes. */
  name?: string;
}

/** A catalog modeled on the request types most US cities expose. */
export const DEFAULT_SANDBOX_SERVICES: SandboxService[] = [
  { service_code: 'sandbox-pothole', service_name: 'Pothole', group: 'Streets', agency: 'Public Works', metadata: false },
  {
    service_code: 'sandbox-streetlight',
    service_name: 'Street Light Outage',
    group: 'Streets',
    agency: 'Street Lighting',
    metadata: true,
    attributes: [
      {
        code: 'light_condition',
        description: 'Is the light completely out, flickering, or on during the day?',
        datatype: 'singlevaluelist',
        required: true,
        variable: true,
        order: 1,
        values: [
          { key: 'out', name: 'Completely out' },
          { key: 'flickering', name: 'Flickering' },
          { key: 'day_burner', name: 'On during the day' },
        ],
      },
    ],
  },
  { service_code: 'sandbox-traffic-signal', service_name: 'Traffic Signal Repair', group: 'Streets', agency: 'Transportation', metadata: false },
  { service_code: 'sandbox-sidewalk', service_name: 'Sidewalk Repair', group: 'Streets', agency: 'Public Works', metadata: false },
  { service_code: 'sandbox-graffiti', service_name: 'Graffiti Removal', group: 'Neighborhood', agency: 'Property Management', metadata: false },
  { service_code: 'sandbox-illegal-dumping', service_name: 'Illegal Dumping', group: 'Sanitation', agency: 'Code Enforcement', metadata: false },
  { service_code: 'sandbox-missed-trash', service_name: 'Missed Trash or Recycling', group: 'Sanitation', agency: 'Public Works', metadata: false },
  { service_code: 'sandbox-litter', service_name: 'Litter and Debris', group: 'Sanitation', agency: 'Public Works', metadata: false },
  { service_code: 'sandbox-tree', service_name: 'Tree Maintenance', group: 'Parks', agency: 'Parks and Recreation', metadata: false },
  { service_code: 'sandbox-abandoned-vehicle', service_name: 'Abandoned Vehicle', group: 'Vehicles', agency: 'Transportation', metadata: false },
  { service_code: 'sandbox-illegal-parking', service_name: 'Illegal Parking', group: 'Vehicles', agency: 'Transportation', metadata: false },
  { service_code: 'sandbox-rodent', service_name: 'Rodent Activity', group: 'Health', agency: 'Inspectional Services', metadata: false },
  { service_code: 'sandbox-other', service_name: 'Other', group: 'General', agency: 'Constituent Services', metadata: false },
];

const DEFAULT_LIFECYCLE: SandboxLifecycle = { assignAfterMs: 2 * 60_000, closeAfterMs: 20 * 3_600_000 };

export interface Open311Sandbox {
  /** Web-standard handler. Returns a 404 Open311 error for paths outside `basePath`. */
  fetch: (request: Request) => Promise<Response>;
  readonly basePath: string;
  readonly services: readonly SandboxService[];
  readonly store: SandboxStore;
}

export function createSandbox(options: SandboxOptions = {}): Open311Sandbox {
  const basePath = (options.basePath ?? '/open311/v2').replace(/\/+$/, '');
  const services = options.services ?? DEFAULT_SANDBOX_SERVICES;
  const store = options.store ?? new MemorySandboxStore();
  const lifecycle = options.lifecycle === false ? undefined : (options.lifecycle ?? DEFAULT_LIFECYCLE);
  const now = options.now ?? Date.now;
  const name = options.name ?? 'open311-mcp sandbox';
  const generateId =
    options.generateId ?? (() => `SB-${String(Math.floor(Math.random() * 90_000) + 10_000)}`);

  const byCode = new Map(services.map((s) => [s.service_code, s]));

  function view(record: SandboxRequestRecord): Record<string, unknown> {
    const age = now() - record.requested_at;
    const agency = byCode.get(record.service_code)?.agency ?? 'City services';
    let status = 'open';
    let notes = `Received by the ${name}. Nothing was sent to a real city.`;
    let updatedAt = record.requested_at;
    if (lifecycle && age >= lifecycle.closeAfterMs) {
      status = 'closed';
      notes = `Resolved by ${agency}. (Simulated by the ${name}.)`;
      updatedAt = record.requested_at + lifecycle.closeAfterMs;
    } else if (lifecycle && age >= lifecycle.assignAfterMs) {
      notes = `Assigned to a ${agency} crew. (Simulated by the ${name}.)`;
      updatedAt = record.requested_at + lifecycle.assignAfterMs;
    }
    return {
      service_request_id: record.service_request_id,
      status,
      status_notes: notes,
      service_name: record.service_name,
      service_code: record.service_code,
      description: record.description ?? null,
      agency_responsible: agency,
      service_notice: null,
      requested_datetime: new Date(record.requested_at).toISOString(),
      updated_datetime: new Date(updatedAt).toISOString(),
      expected_datetime: lifecycle ? new Date(record.requested_at + lifecycle.closeAfterMs).toISOString() : null,
      address: record.address ?? null,
      address_id: record.address_id ?? null,
      zipcode: null,
      lat: record.lat ?? null,
      long: record.long ?? null,
      media_url: record.media_url ?? null,
      token: record.token,
    };
  }

  async function createRequest(request: Request): Promise<Response> {
    const type = request.headers.get('content-type') ?? '';
    if (!type.includes('application/x-www-form-urlencoded')) {
      return error(400, 'POST /requests expects application/x-www-form-urlencoded.');
    }
    const form = new URLSearchParams(await request.text());
    const serviceCode = form.get('service_code');
    if (!serviceCode) return error(400, 'service_code is required.');
    const service = byCode.get(serviceCode);
    if (!service) return error(404, `Invalid service code ${serviceCode}`);

    const lat = toNumber(form.get('lat'));
    const long = toNumber(form.get('long'));
    const address = form.get('address_string') ?? undefined;
    const addressId = form.get('address_id') ?? undefined;
    const hasPoint = lat !== undefined && long !== undefined;
    if (hasPoint && (Math.abs(lat) > 90 || Math.abs(long) > 180)) return error(400, 'lat or long is out of range.');
    if (!hasPoint && !address && !addressId) {
      return error(400, 'A location is required: lat and long, address_string, or address_id.');
    }

    const attributes: Record<string, string | string[]> = {};
    for (const [key, value] of form.entries()) {
      const m = /^attribute\[([^\]]+)\](\[\])?$/.exec(key);
      if (!m) continue;
      const code = m[1]!;
      if (m[2]) attributes[code] = [...((attributes[code] as string[] | undefined) ?? []), value];
      else attributes[code] = value;
    }
    for (const attr of service.attributes ?? []) {
      if (!attr.required) continue;
      const answer = attributes[attr.code];
      if (answer === undefined || answer === '' || (Array.isArray(answer) && answer.length === 0)) {
        return error(400, `Missing required attribute "${attr.code}": ${attr.description}`);
      }
      if (attr.values.length > 0) {
        const allowed = new Set(attr.values.map((v) => v.key));
        for (const a of Array.isArray(answer) ? answer : [answer]) {
          if (!allowed.has(a)) return error(400, `Invalid value "${a}" for attribute "${attr.code}".`);
        }
      }
    }

    let id = generateId();
    for (let i = 0; i < 5 && (await store.get(id)); i++) id = generateId();
    if (await store.get(id)) return error(503, 'Could not allocate a request ID. Try again.');

    const record: SandboxRequestRecord = {
      service_request_id: id,
      token: crypto.randomUUID(),
      service_code: service.service_code,
      service_name: service.service_name,
      description: form.get('description')?.slice(0, 4000) || undefined,
      address,
      address_id: addressId,
      lat: hasPoint ? lat : undefined,
      long: hasPoint ? long : undefined,
      media_url: form.get('media_url') || undefined,
      requested_at: now(),
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      device_id: form.get('device_id') || undefined,
    };
    await store.put(record);
    return json(201, [
      {
        service_request_id: record.service_request_id,
        token: record.token,
        service_notice: `Filed in the ${name}. Nothing was sent to a real city.`,
        account_id: null,
      },
    ]);
  }

  async function listRequests(url: URL): Promise<Response> {
    const p = url.searchParams;
    const ids = p.get('service_request_id')?.split(',').map((s) => s.trim()).filter(Boolean);
    const codes = p.get('service_code')?.split(',').map((s) => s.trim()).filter(Boolean);
    const status = p.get('status')?.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const start = toTime(p.get('start_date'));
    const end = toTime(p.get('end_date'));
    if (start === null || end === null) return error(400, 'start_date and end_date must be W3C datetimes.');
    if (start !== undefined && end !== undefined && end - start > 90 * 86_400_000) {
      return error(400, 'start_date and end_date may span at most 90 days.');
    }
    const lat = toNumber(p.get('lat'));
    const long = toNumber(p.get('long'));
    const radius = toNumber(p.get('radius')) ?? 1000;
    const perPage = Math.min(300, Math.max(1, Math.floor(toNumber(p.get('per_page')) ?? 50)));
    const page = Math.max(1, Math.floor(toNumber(p.get('page')) ?? 1));

    const rows = (await store.list())
      .filter((r) => !ids || ids.includes(r.service_request_id))
      .filter((r) => !codes || codes.includes(r.service_code))
      .filter((r) => start === undefined || r.requested_at >= start)
      .filter((r) => end === undefined || r.requested_at <= end)
      .filter((r) => {
        if (lat === undefined || long === undefined) return true;
        if (r.lat === undefined || r.long === undefined) return false;
        return haversineMeters(lat, long, r.lat, r.long) <= radius;
      })
      .sort((a, b) => b.requested_at - a.requested_at)
      .map(view)
      .filter((v) => !status || status.includes(String(v.status)));
    return json(200, rows.slice((page - 1) * perPage, page * perPage));
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${basePath}/`) && url.pathname !== basePath) {
      return error(404, 'Not an Open311 path.');
    }
    const rest = url.pathname.slice(basePath.length).replace(/\/+$/, '');
    const method = request.method.toUpperCase();

    if (rest === '/discovery.json' && method === 'GET') {
      return json(200, {
        changeset: '2026-10-13T00:00:00Z',
        contact: `${name}: a local test server, not a city.`,
        key_service: 'No API key is needed.',
        endpoints: [
          {
            specification: 'http://wiki.open311.org/GeoReport_v2',
            url: `${url.origin}${basePath}`,
            changeset: '2026-10-13T00:00:00Z',
            type: 'test',
            formats: ['application/json'],
          },
        ],
      });
    }
    if (rest === '/services.json' && method === 'GET') {
      return json(
        200,
        services.map((s) => ({
          service_code: s.service_code,
          service_name: s.service_name,
          description: s.description ?? null,
          metadata: (s.attributes?.length ?? 0) > 0,
          type: 'realtime',
          keywords: s.keywords ?? null,
          group: s.group ?? null,
        })),
      );
    }
    const serviceMatch = /^\/services\/(.+)\.json$/.exec(rest);
    if (serviceMatch && method === 'GET') {
      const service = byCode.get(decodeURIComponent(serviceMatch[1]!));
      if (!service) return error(404, `Invalid service code ${decodeURIComponent(serviceMatch[1]!)}`);
      return json(200, { service_code: service.service_code, attributes: service.attributes ?? [] });
    }
    if (rest === '/requests.json') {
      if (method === 'GET') return listRequests(url);
      if (method === 'POST') return createRequest(request);
      return error(405, 'Use GET or POST on /requests.');
    }
    const requestMatch = /^\/requests\/(.+)\.json$/.exec(rest);
    if (requestMatch && method === 'GET') {
      const record = await store.get(decodeURIComponent(requestMatch[1]!));
      if (!record) return error(404, `No request with ID ${decodeURIComponent(requestMatch[1]!)}`);
      return json(200, [view(record)]);
    }
    const tokenMatch = /^\/tokens\/(.+)\.json$/.exec(rest);
    if (tokenMatch && method === 'GET') {
      const token = decodeURIComponent(tokenMatch[1]!);
      const record = (await store.list()).find((r) => r.token === token);
      if (!record) return error(404, `No request for token ${token}`);
      return json(200, [{ service_request_id: record.service_request_id, token }]);
    }
    return error(404, `Unknown Open311 resource ${rest || '/'}`);
  }

  return {
    basePath,
    services,
    store,
    fetch: async (request) => {
      try {
        return await handle(request);
      } catch (err) {
        return error(500, `Sandbox failure: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/**
 * An endpoint config that talks to a sandbox in-process (no network), for use as a city's `test`
 * endpoint. Requests still go through real Request/Response objects and the GeoReport wire format.
 */
export function sandboxEndpoint(sandbox: Open311Sandbox, id = 'sandbox'): EndpointConfig {
  const origin = 'http://open311-sandbox.internal';
  const viaSandbox: typeof fetch = (input, init) => sandbox.fetch(new Request(input, init));
  return {
    id,
    kind: 'test',
    baseUrl: `${origin}${sandbox.basePath}`,
    rateLimitPerMinute: 600,
    pageParam: 'page',
    pageSizeParam: 'per_page',
    pageSize: 300,
    spatial: 'none',
    fetch: viaSandbox,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function error(status: number, description: string): Response {
  return json(status, [{ code: status, description }]);
}

function toNumber(v: string | null): number | undefined {
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** undefined: not given. null: given but unparseable. */
function toTime(v: string | null): number | undefined | null {
  if (v === null || v.trim() === '') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
