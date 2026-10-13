import type { CityConfig, EndpointConfig } from './cities.ts';
import { Open311Error } from './errors.ts';
import { haversineMeters, inBoundingBox } from './geo.ts';
import { assertWriteAllowed, type Env } from './guard.ts';
import { RateLimiter } from './rateLimiter.ts';
import type {
  CreateRequestInput,
  CreateRequestResult,
  SearchRequestsOptions,
  Service,
  ServiceAttribute,
  ServiceDefinition,
  ServiceRequest,
} from './types.ts';

export type EndpointKind = 'production' | 'test';

export interface Open311ClientOptions {
  /** Defaults to the global fetch. An endpoint's own `fetch` wins over this. */
  fetch?: typeof fetch;
  /** Where API keys and ALLOW_PRODUCTION_WRITES are read from. Defaults to process.env. */
  env?: Env;
  userAgent?: string;
  /** Retries after the first attempt for retryable failures. Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 20 seconds. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Share limiters between clients. Defaults to one process-wide registry keyed by endpoint id. */
  limiters?: Map<string, RateLimiter>;
}

const DEFAULT_USER_AGENT = 'open311-mcp/0.1 (+https://github.com/saahilshah178/citydesk)';
const sharedLimiters = new Map<string, RateLimiter>();
const DAY_MS = 86_400_000;

/** A typed Open311 GeoReport v2 client for one city, with rate limiting, retries, and a write guard. */
export class Open311Client {
  readonly city: CityConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly env: Env;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiters: Map<string, RateLimiter>;

  constructor(city: CityConfig, opts: Open311ClientOptions = {}) {
    this.city = city;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.env = opts.env ?? process.env;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiters = opts.limiters ?? sharedLimiters;
  }

  /** The configured endpoint of the given kind, or a `not_configured` error. */
  endpoint(kind: EndpointKind): EndpointConfig {
    const endpoint = kind === 'production' ? this.city.production : this.city.test;
    if (!endpoint) {
      throw new Open311Error('not_configured', `${this.city.name} has no ${kind} Open311 endpoint configured.`, {
        retryable: false,
        details: { city: this.city.id, kind },
      });
    }
    return endpoint;
  }

  /** GET /services: the request types that can be filed through this endpoint. */
  async listServices(
    kind: EndpointKind = 'production',
    point?: { lat: number; long: number },
  ): Promise<Service[]> {
    const endpoint = this.endpoint(kind);
    const query = new URLSearchParams();
    this.addPoint(query, endpoint, point);
    const body = await this.call(endpoint, 'GET', '/services.json', query);
    return asArray(body).map(normalizeService).filter((s): s is Service => s !== undefined);
  }

  /** GET /services/{code}: the attributes a service asks for. Undefined when the server has none. */
  async getServiceDefinition(
    serviceCode: string,
    kind: EndpointKind = 'production',
  ): Promise<ServiceDefinition | undefined> {
    const endpoint = this.endpoint(kind);
    try {
      const body = await this.call(
        endpoint,
        'GET',
        `/services/${encodeURIComponent(serviceCode)}.json`,
        new URLSearchParams(),
      );
      const raw = Array.isArray(body) ? body[0] : body;
      if (!isRecord(raw)) return undefined;
      return {
        service_code: String(raw.service_code ?? serviceCode),
        attributes: asArray(raw.attributes)
          .map(normalizeAttribute)
          .filter((a): a is ServiceAttribute => a !== undefined)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      };
    } catch (err) {
      if (err instanceof Open311Error && err.code === 'not_found') return undefined;
      throw err;
    }
  }

  /**
   * GET /requests with paging and date windows handled for you.
   *
   * Service code, status and dates are filtered by the server. `bbox` and `near` are always applied
   * here as well, because some servers (Boston) accept spatial parameters and silently ignore them.
   * Results are newest first, or nearest first when `near` is given.
   */
  async searchRequests(
    opts: SearchRequestsOptions = {},
    kind: EndpointKind = 'production',
  ): Promise<ServiceRequest[]> {
    const endpoint = this.endpoint(kind);
    const limit = opts.limit ?? 300;
    const maxPages = opts.maxPages ?? 10;
    const pageSize = endpoint.pageSize ?? 100;
    const found = new Map<string, ServiceRequest>();

    for (const window of this.dateWindows(endpoint, opts.startDate, opts.endDate)) {
      for (let page = 1; page <= maxPages && found.size < limit; page++) {
        const query = new URLSearchParams();
        if (opts.serviceCode) query.set('service_code', opts.serviceCode);
        if (opts.status) query.set('status', opts.status);
        if (window.start) query.set('start_date', toW3c(window.start));
        if (window.end) query.set('end_date', toW3c(window.end));
        if (opts.query && endpoint.textSearch) query.set('q', opts.query);
        if (opts.extensions && endpoint.extensions) query.set('extensions', 'true');
        this.addPoint(query, endpoint, opts.near);
        if (endpoint.pageSizeParam) query.set(endpoint.pageSizeParam, String(pageSize));
        if (endpoint.pageParam && page > 1) query.set(endpoint.pageParam, String(page));

        const rows = asArray(await this.call(endpoint, 'GET', '/requests.json', query));
        let fresh = 0;
        for (const row of rows) {
          const request = normalizeRequest(row);
          if (!request || found.has(request.service_request_id)) continue;
          fresh++;
          if (this.matches(request, opts)) found.set(request.service_request_id, request);
        }
        // Stop when the server has no more rows, cannot page, or keeps repeating itself.
        if (rows.length === 0 || fresh === 0 || !endpoint.pageParam) break;
        if (endpoint.pageSizeParam && rows.length < pageSize) break;
      }
      if (found.size >= limit) break;
    }

    const results = [...found.values()];
    if (opts.near) {
      const { lat, long } = opts.near;
      results.sort((a, b) => distanceTo(a, lat, long) - distanceTo(b, lat, long));
    } else {
      results.sort((a, b) => b.requested_datetime.localeCompare(a.requested_datetime));
    }
    return results.slice(0, limit);
  }

  /** GET /requests/{id}. Undefined when the server does not know the ID. */
  async getRequest(serviceRequestId: string, kind: EndpointKind = 'production'): Promise<ServiceRequest | undefined> {
    const endpoint = this.endpoint(kind);
    try {
      const body = await this.call(
        endpoint,
        'GET',
        `/requests/${encodeURIComponent(serviceRequestId)}.json`,
        new URLSearchParams(),
      );
      return asArray(body).map(normalizeRequest).find((r) => r !== undefined);
    } catch (err) {
      if (err instanceof Open311Error && err.code === 'not_found') return undefined;
      throw err;
    }
  }

  /**
   * POST /requests. Defaults to the city's test endpoint and refuses any endpoint that is not a
   * sandbox unless ALLOW_PRODUCTION_WRITES=true (see guard.ts). The guard runs before anything is sent.
   */
  async createRequest(input: CreateRequestInput, kind: EndpointKind = 'test'): Promise<CreateRequestResult> {
    const endpoint = this.endpoint(kind);
    assertWriteAllowed(this.city, endpoint, this.env);

    if (!input.serviceCode) {
      throw new Open311Error('invalid_request', 'service_code is required to create a request.', { retryable: false });
    }
    const hasPoint = isFiniteNumber(input.lat) && isFiniteNumber(input.long);
    if (!hasPoint && !input.addressString && !input.addressId) {
      throw new Open311Error(
        'invalid_request',
        'A location is required: lat and long, address_string, or address_id.',
        { retryable: false },
      );
    }

    const form = new URLSearchParams();
    form.set('service_code', input.serviceCode);
    if (hasPoint) {
      form.set('lat', String(input.lat));
      form.set('long', String(input.long));
    }
    setIf(form, 'address_string', input.addressString);
    setIf(form, 'address_id', input.addressId);
    setIf(form, 'description', input.description?.slice(0, 4000));
    setIf(form, 'email', input.email);
    setIf(form, 'first_name', input.firstName);
    setIf(form, 'last_name', input.lastName);
    setIf(form, 'phone', input.phone);
    setIf(form, 'media_url', input.mediaUrl);
    setIf(form, 'device_id', input.deviceId);
    for (const [code, value] of Object.entries(input.attributes ?? {})) {
      if (Array.isArray(value)) for (const v of value) form.append(`attribute[${code}][]`, v);
      else form.set(`attribute[${code}]`, value);
    }

    const body = await this.call(endpoint, 'POST', '/requests.json', new URLSearchParams(), form);
    const raw = Array.isArray(body) ? body[0] : body;
    if (!isRecord(raw) || (raw.service_request_id == null && raw.token == null)) {
      throw new Open311Error('bad_response', 'The server accepted the request but returned no ID or token.', {
        retryable: false,
        details: { endpoint: endpoint.id },
      });
    }
    return {
      service_request_id: raw.service_request_id == null ? undefined : String(raw.service_request_id),
      token: raw.token == null ? undefined : String(raw.token),
      service_notice: optionalString(raw.service_notice),
      account_id: raw.account_id == null ? undefined : String(raw.account_id),
    };
  }

  /** GET /tokens/{token}: resolves the request ID for servers that assign IDs after the fact. */
  async getRequestIdFromToken(token: string, kind: EndpointKind = 'test'): Promise<string | undefined> {
    const endpoint = this.endpoint(kind);
    try {
      const body = await this.call(endpoint, 'GET', `/tokens/${encodeURIComponent(token)}.json`, new URLSearchParams());
      const raw = Array.isArray(body) ? body[0] : body;
      return isRecord(raw) && raw.service_request_id != null ? String(raw.service_request_id) : undefined;
    } catch (err) {
      if (err instanceof Open311Error && err.code === 'not_found') return undefined;
      throw err;
    }
  }

  /**
   * The request types actually present in recent requests, with their codes. Some cities (Boston)
   * list only a few fileable services in /services while requests of many more types are readable.
   */
  async observedServices(
    opts: { sinceDays?: number; maxPages?: number } = {},
    kind: EndpointKind = 'production',
  ): Promise<Array<Pick<Service, 'service_code' | 'service_name'> & { count: number }>> {
    const start = new Date(this.now() - (opts.sinceDays ?? 7) * DAY_MS);
    const requests = await this.searchRequests(
      { startDate: start, endDate: new Date(this.now()), limit: 5000, maxPages: opts.maxPages ?? 5 },
      kind,
    );
    const seen = new Map<string, { service_code: string; service_name: string; count: number }>();
    for (const r of requests) {
      if (!r.service_code || !r.service_name) continue;
      const entry = seen.get(r.service_code) ?? { service_code: r.service_code, service_name: r.service_name, count: 0 };
      entry.count++;
      seen.set(r.service_code, entry);
    }
    return [...seen.values()].sort((a, b) => b.count - a.count);
  }

  private matches(request: ServiceRequest, opts: SearchRequestsOptions): boolean {
    if (opts.status && request.status !== opts.status) return false;
    if (opts.serviceCode && request.service_code && request.service_code !== opts.serviceCode) return false;
    if (opts.startDate && request.requested_datetime < opts.startDate.toISOString()) return false;
    if (opts.endDate && request.requested_datetime > opts.endDate.toISOString()) return false;
    if (opts.bbox || opts.near) {
      if (!isFiniteNumber(request.lat) || !isFiniteNumber(request.long)) return false;
      if (opts.bbox && !inBoundingBox(request.lat, request.long, opts.bbox)) return false;
      if (opts.near) {
        const d = haversineMeters(opts.near.lat, opts.near.long, request.lat, request.long);
        if (d > opts.near.radiusMeters) return false;
      }
    }
    return true;
  }

  /** Splits a date range into windows the server accepts, newest first. */
  private dateWindows(
    endpoint: EndpointConfig,
    start?: Date,
    end?: Date,
  ): Array<{ start?: Date; end?: Date }> {
    if (!start) return [{ end }];
    const maxSpanMs = (endpoint.maxDateSpanDays ?? 90) * DAY_MS;
    const finalEnd = end ?? new Date(this.now());
    if (finalEnd.getTime() <= start.getTime()) return [{ start, end: finalEnd }];
    const windows: Array<{ start: Date; end: Date }> = [];
    let cursorEnd = finalEnd.getTime();
    while (cursorEnd > start.getTime()) {
      const cursorStart = Math.max(start.getTime(), cursorEnd - maxSpanMs);
      windows.push({ start: new Date(cursorStart), end: new Date(cursorEnd) });
      cursorEnd = cursorStart;
    }
    return windows;
  }

  private addPoint(query: URLSearchParams, endpoint: EndpointConfig, point?: { lat: number; long: number }): void {
    if (endpoint.spatial !== 'point') return;
    const p = point ?? endpoint.referencePoint;
    if (!p) return;
    query.set('lat', String(p.lat));
    query.set('long', String(p.long));
  }

  private limiter(endpoint: EndpointConfig): RateLimiter {
    let limiter = this.limiters.get(endpoint.id);
    if (!limiter) {
      limiter = new RateLimiter({ limit: endpoint.rateLimitPerMinute, now: this.now, sleep: this.sleep });
      this.limiters.set(endpoint.id, limiter);
    }
    return limiter;
  }

  private async call(
    endpoint: EndpointConfig,
    method: 'GET' | 'POST',
    path: string,
    query: URLSearchParams,
    form?: URLSearchParams,
  ): Promise<unknown> {
    const apiKey = endpoint.apiKeyEnv ? this.env[endpoint.apiKeyEnv] : undefined;
    const target = method === 'POST' && form ? form : query;
    if (apiKey) target.set('api_key', apiKey);
    if (endpoint.jurisdictionId) target.set('jurisdiction_id', endpoint.jurisdictionId);

    const qs = query.toString();
    const url = `${endpoint.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    const doFetch = endpoint.fetch ?? this.fetchImpl;
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': this.userAgent };
    if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
    const where = `${this.city.name} Open311 (${endpoint.id})`;

    for (let attempt = 0; ; attempt++) {
      await this.limiter(endpoint).acquire();
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers,
          body: form ? form.toString() : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        // A failed POST may still have reached the server, so it is never repeated blindly.
        if (method === 'GET' && attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new Open311Error('upstream_unavailable', `Could not reach ${where}: ${describe(cause)}`, {
          cause,
          details: { endpoint: endpoint.id },
        });
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new Open311Error('bad_response', `${where} returned something that is not JSON.`, {
            status: res.status,
            retryable: false,
            details: { endpoint: endpoint.id, snippet: text.slice(0, 120) },
          });
        }
      }

      const description = await readErrorDescription(res);
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      const canRetry =
        attempt < this.maxRetries && (res.status === 429 || (method === 'GET' && res.status >= 502 && res.status <= 504));
      if (canRetry) {
        await this.sleep(Math.min(10_000, retryAfterMs ?? backoffMs(attempt)));
        continue;
      }
      const details = { endpoint: endpoint.id, description };
      if (res.status === 404) {
        throw new Open311Error('not_found', description ?? `${where} has no such resource.`, {
          status: 404,
          retryable: false,
          details,
        });
      }
      if (res.status === 429) {
        throw new Open311Error('rate_limited', `${where} is rate limiting requests. Try again in a minute.`, {
          status: 429,
          details,
        });
      }
      if (res.status >= 500) {
        throw new Open311Error('upstream_unavailable', `${where} failed with HTTP ${res.status}.`, {
          status: res.status,
          details,
        });
      }
      throw new Open311Error('invalid_request', description ?? `${where} rejected the request (HTTP ${res.status}).`, {
        status: res.status,
        retryable: false,
        details,
      });
    }
  }
}

// --- normalization -------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function optionalString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function optionalNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function optionalDate(v: unknown): string | undefined {
  const s = optionalString(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function setIf(form: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') form.set(key, value);
}

function normalizeService(raw: unknown): Service | undefined {
  if (!isRecord(raw) || raw.service_code == null) return undefined;
  return {
    service_code: String(raw.service_code),
    service_name: optionalString(raw.service_name) ?? String(raw.service_code),
    description: optionalString(raw.description),
    metadata: raw.metadata === true || raw.metadata === 'true',
    type: optionalString(raw.type),
    keywords: optionalString(raw.keywords),
    group: optionalString(raw.group),
    organization: optionalString(raw.organization),
  };
}

function normalizeAttribute(raw: unknown): ServiceAttribute | undefined {
  if (!isRecord(raw) || raw.code == null) return undefined;
  return {
    code: String(raw.code),
    description: optionalString(raw.description) ?? String(raw.code),
    datatype: optionalString(raw.datatype) ?? 'string',
    required: raw.required === true || raw.required === 'true',
    variable: raw.variable !== false && raw.variable !== 'false',
    order: optionalNumber(raw.order),
    datatype_description: optionalString(raw.datatype_description),
    values: asArray(raw.values)
      .filter(isRecord)
      .map((v) => ({ key: String(v.key), name: optionalString(v.name) ?? String(v.key) })),
  };
}

/** Maps one raw GeoReport request onto the normalized shape. Rows without an ID or date are dropped. */
export function normalizeRequest(raw: unknown): ServiceRequest | undefined {
  if (!isRecord(raw) || raw.service_request_id == null) return undefined;
  const requested = optionalDate(raw.requested_datetime);
  if (!requested) return undefined;
  const statusRaw = (optionalString(raw.status) ?? 'open').toLowerCase();
  const status = statusRaw === 'closed' || statusRaw === 'archived' ? 'closed' : 'open';
  return {
    service_request_id: String(raw.service_request_id),
    status,
    status_raw: statusRaw === status ? undefined : statusRaw,
    status_notes: optionalString(raw.status_notes),
    service_name: optionalString(raw.service_name),
    service_code: raw.service_code == null ? undefined : String(raw.service_code),
    description: optionalString(raw.description),
    agency_responsible: optionalString(raw.agency_responsible),
    service_notice: optionalString(raw.service_notice),
    requested_datetime: requested,
    updated_datetime: optionalDate(raw.updated_datetime),
    expected_datetime: optionalDate(raw.expected_datetime),
    address: optionalString(raw.address),
    address_id: raw.address_id == null ? undefined : String(raw.address_id),
    zipcode: optionalString(raw.zipcode),
    lat: optionalNumber(raw.lat),
    long: optionalNumber(raw.long),
    media_url: optionalString(raw.media_url),
    token: optionalString(raw.token),
    extended_attributes: isRecord(raw.extended_attributes) ? raw.extended_attributes : undefined,
  };
}

function distanceTo(r: ServiceRequest, lat: number, long: number): number {
  return isFiniteNumber(r.lat) && isFiniteNumber(r.long) ? haversineMeters(lat, long, r.lat, r.long) : Infinity;
}

/** GeoReport v2 wants W3C datetimes without milliseconds, e.g. 2026-10-13T00:00:00Z. */
function toW3c(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function backoffMs(attempt: number): number {
  return 500 * 3 ** attempt;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Open311 errors are `[{ code, description }]`. Anything else (an HTML 404 page) yields undefined. */
async function readErrorDescription(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = JSON.parse(await res.text());
    const first = Array.isArray(body) ? body[0] : body;
    return isRecord(first) ? optionalString(first.description) : undefined;
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as { cause?: { code?: string } }).cause?.code;
    return code ? `${cause.message} (${code})` : cause.message;
  }
  return String(cause);
}
