/**
 * Everything the tools need, built once per process: clients for each Open311 endpoint, the
 * geocoder, the address directory, per-user memory, and short-lived caches of upstream data.
 */
import {
  BOSTON,
  Open311Client,
  Open311Error,
  RateLimiter,
  createSandbox,
  sandboxEndpoint,
  type CityConfig,
  type EndpointKind,
  type Open311ClientOptions,
  type Open311Sandbox,
  type SandboxStore,
  type Service,
  type ServiceRequest,
} from 'open311-mcp';
import { BostonAddressDirectory, type AddressDirectory } from './addresses.ts';
import type { IssueType, RequestSource, StaticMapInput } from './contract.ts';
import { BOSTON_OBSERVED_SERVICES } from './data/bostonServices.ts';
import { BostonAddressGeocoder, GeocoderChain } from './geocode/bostonAddresses.ts';
import type { Geocoder } from './geocode/types.ts';
import { ISSUE_TYPE_SPECS, matchServices, type NamedService } from './issueTypes.ts';
import { MemoryStore } from './store/memory.ts';
import type { UserStore } from './store/types.ts';

export interface CityDeskConfig {
  /** Default duplicate radius in meters. */
  dedupeRadiusMeters: number;
  /** How far back an open request still counts as a duplicate. */
  dedupeWindowDays: number;
  /** Sandbox lifecycle simulation; false keeps sandbox requests open forever. */
  sandboxLifecycle: { assignAfterMs: number; closeAfterMs: number } | false;
  /** Most reports one household may file per hour. */
  maxFilingsPerUserPerHour: number;
  /** Most reports one network address may file per hour, whatever households it claims to be. */
  maxFilingsPerCallerPerHour: number;
  /** Most reports all households together may file per hour: a ceiling on abuse of a public demo. */
  maxFilingsPerHour: number;
}

export const DEFAULT_CONFIG: CityDeskConfig = {
  dedupeRadiusMeters: 50,
  dedupeWindowDays: 30,
  sandboxLifecycle: { assignAfterMs: 2 * 60_000, closeAfterMs: 20 * 3_600_000 },
  maxFilingsPerUserPerHour: 10,
  maxFilingsPerCallerPerHour: 20,
  maxFilingsPerHour: 100,
};

/** One Open311 endpoint as the tools see it. */
export interface EndpointRuntime {
  id: string;
  kind: EndpointKind;
  /** Production requests are read-only; sandbox requests were filed through CityDesk. */
  source: RequestSource;
  client: Open311Client;
  /**
   * Client for looking up requests by ID. On the live endpoint it has its own, smaller share of the
   * per-minute budget, so a flood of status lookups cannot stop duplicate checks from working.
   */
  lookups: Open311Client;
  /** What a request ID on this endpoint looks like. Anything else is rejected without an upstream call. */
  idPattern?: RegExp;
  /** Shown to residents, e.g. "CityDesk sandbox". */
  label: string;
}

export type StaticMapProvider = (input: StaticMapInput) => Promise<{ data: string; mimeType: string }>;

export interface RuntimeOptions {
  config?: Partial<CityDeskConfig>;
  env?: Record<string, string | undefined>;
  city?: CityConfig;
  store?: UserStore;
  sandboxStore?: SandboxStore;
  geocoder?: Geocoder;
  directory?: AddressDirectory;
  staticMap?: StaticMapProvider;
  /** Replaces the network for every Open311 and open-data call (tests). */
  fetch?: typeof fetch;
  /** Rate limiter registry and sleep for the Open311 clients (tests). */
  limiters?: Open311ClientOptions['limiters'];
  sleep?: Open311ClientOptions['sleep'];
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Seed catalog of readable request types for the production endpoint. */
  observedServices?: readonly NamedService[];
  /**
   * Also try the city's own test endpoint for new reports, before the built-in sandbox. Off by
   * default: Boston's does not resolve today, and a sandbox that comes back unannounced should be
   * looked at before a public demo starts sending it residents' text.
   */
  useCityTestEndpoint?: boolean;
}

const OPEN_LIST_TTL_MS = 120_000;
const SERVICES_TTL_MS = 3_600_000;
const DOWN_TTL_MS = 600_000;
const DAY_MS = 86_400_000;

interface Cached<T> {
  at: number;
  value: T;
}

export class CityDeskRuntime {
  readonly config: CityDeskConfig;
  readonly city: CityConfig;
  readonly store: UserStore;
  readonly geocoder: Geocoder;
  readonly directory: AddressDirectory;
  readonly sandbox: Open311Sandbox;
  readonly staticMap?: StaticMapProvider;
  readonly now: () => number;
  readonly log: (event: string, data?: Record<string, unknown>) => void;
  /** The live system: reads only. */
  readonly read: EndpointRuntime;
  /** Sandboxes to file into, in order of preference. */
  readonly writeTargets: EndpointRuntime[];
  private readonly endpoints = new Map<string, EndpointRuntime>();
  /** Filing-ceiling keys known to be exhausted, mapped to the clock hour they were seen in. */
  readonly overCeiling = new Map<string, number>();

  private readonly known = new Map<string, Map<string, string>>();
  private readonly fileable = new Map<string, Cached<Service[]>>();
  private readonly down = new Map<string, Cached<string>>();
  private readonly openLists = new Map<string, Cached<ServiceRequest[]>>();
  private readonly verified = new Map<string, number>();

  constructor(opts: RuntimeOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.city = opts.city ?? BOSTON;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
    this.staticMap = opts.staticMap;
    const env = opts.env ?? process.env;
    const memory = opts.store ? undefined : new MemoryStore();
    this.store = opts.store ?? memory!;
    this.directory = opts.directory ?? new BostonAddressDirectory({ fetch: opts.fetch });
    this.geocoder =
      opts.geocoder ??
      new GeocoderChain([new BostonAddressGeocoder(this.directory)], (name, error) =>
        this.log('geocoder_failed', { geocoder: name, error: String(error) }),
      );

    this.sandbox = createSandbox({
      basePath: '/sandbox/open311/v2',
      name: 'CityDesk sandbox',
      now: this.now,
      lifecycle: this.config.sandboxLifecycle,
      store: opts.sandboxStore ?? memory?.sandboxStore(),
    });

    // Tools are interactive: when the per-minute budget for the city is spent, fail fast instead of queueing.
    const common = {
      env,
      fetch: opts.fetch,
      now: this.now,
      timeoutMs: 8_000,
      limiters: opts.limiters,
      sleep: opts.sleep,
      maxRateLimitWaitMs: 2_500,
    };
    // The live endpoint's per-minute budget is split: most for the lists duplicate checks need (they
    // are cached, so a few a minute go a long way), the rest for status lookups by ID.
    const live = this.city.production!;
    const perMinute = live.rateLimitPerMinute;
    const lookupShare = Math.max(1, Math.floor(perMinute * 0.4));
    const share = (n: number): CityConfig => ({ ...this.city, production: { ...live, rateLimitPerMinute: n } });
    const mapOf = (): Map<string, RateLimiter> => new Map<string, RateLimiter>();
    this.read = this.add({
      id: live.id,
      kind: 'production',
      source: 'production',
      client: new Open311Client(share(Math.max(1, perMinute - lookupShare)), { ...common, limiters: opts.limiters ?? mapOf(), maxRetries: 1 }),
      lookups: new Open311Client(share(lookupShare), { ...common, limiters: opts.limiters ? new Map() : mapOf(), maxRetries: 1 }),
      // Boston's IDs are UUIDs; other cities use numbers. Either way: short, no slashes, no spaces.
      idPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
      label: this.city.name,
    });

    this.writeTargets = [];
    if (this.city.test && opts.useCityTestEndpoint) {
      // The city's own sandbox, when asked for. Probed without retries so a dead host costs little.
      const cityTest = new Open311Client(this.city, { ...common, maxRetries: 0, timeoutMs: 3_000 });
      this.writeTargets.push(
        this.add({ id: this.city.test.id, kind: 'test', source: 'sandbox', client: cityTest, lookups: cityTest, label: `${this.city.name} test system` }),
      );
    }
    const builtIn = sandboxEndpoint(this.sandbox, 'citydesk-sandbox');
    const sandboxCity: CityConfig = { ...this.city, test: builtIn };
    const sandboxClient = new Open311Client(sandboxCity, { env, now: this.now });
    this.writeTargets.push(
      this.add({
        id: builtIn.id,
        kind: 'test',
        source: 'sandbox',
        client: sandboxClient,
        lookups: sandboxClient,
        idPattern: /^SB-\d{3,10}$/,
        label: 'CityDesk sandbox',
      }),
    );

    const seed = opts.observedServices ?? (this.city.id === 'boston' ? BOSTON_OBSERVED_SERVICES : []);
    this.learn(this.read, seed);
  }

  private add(endpoint: EndpointRuntime): EndpointRuntime {
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  endpoint(id: string): EndpointRuntime | undefined {
    return this.endpoints.get(id);
  }

  /** Remembers name-to-code pairs seen in responses, so the catalog follows the city's data. */
  learn(endpoint: EndpointRuntime, rows: ReadonlyArray<{ service_code?: string; service_name?: string }>): void {
    let map = this.known.get(endpoint.id);
    if (!map) this.known.set(endpoint.id, (map = new Map()));
    for (const row of rows) {
      if (row.service_code && row.service_name) map.set(row.service_code, row.service_name);
    }
  }

  private knownServices(endpoint: EndpointRuntime): NamedService[] {
    return [...(this.known.get(endpoint.id) ?? new Map<string, string>())].map(([service_code, service_name]) => ({
      service_code,
      service_name,
    }));
  }

  /** The services an endpoint lets us file, cached for an hour. A failing endpoint is skipped for ten minutes. */
  async fileableServices(endpoint: EndpointRuntime): Promise<Service[]> {
    const t = this.now();
    const cached = this.fileable.get(endpoint.id);
    if (cached && t - cached.at < SERVICES_TTL_MS) return cached.value;
    const down = this.down.get(endpoint.id);
    if (down && t - down.at < DOWN_TTL_MS) {
      throw new Open311Error('upstream_unavailable', down.value, { details: { endpoint: endpoint.id } });
    }
    try {
      const services = await endpoint.client.listServices(endpoint.kind);
      this.fileable.set(endpoint.id, { at: t, value: services });
      this.learn(endpoint, services);
      return services;
    } catch (err) {
      this.down.set(endpoint.id, { at: t, value: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Picks the sandbox and service a new report of this type goes to. */
  async pickWriteTarget(issueType: IssueType): Promise<{ endpoint: EndpointRuntime; service: Service }> {
    for (const endpoint of this.writeTargets) {
      let services: Service[];
      try {
        services = await this.fileableServices(endpoint);
      } catch (err) {
        this.log('write_target_unavailable', { endpoint: endpoint.id, error: String(err) });
        continue;
      }
      const service = matchServices(issueType, services)[0];
      if (service) return { endpoint, service };
    }
    throw new Open311Error(
      'not_configured',
      `No sandbox accepts ${ISSUE_TYPE_SPECS[issueType].label} reports right now.`,
      { retryable: false, details: { issue_type: issueType } },
    );
  }

  /**
   * Open requests of an issue type across the live system and every sandbox, within the duplicate
   * window. Each endpoint's list is cached briefly so repeated checks cost one upstream call.
   */
  async openRequests(issueType: IssueType): Promise<Array<{ endpoint: EndpointRuntime; request: ServiceRequest }>> {
    const out: Array<{ endpoint: EndpointRuntime; request: ServiceRequest }> = [];
    const sources = [this.read, ...this.writeTargets];
    let liveFailure: unknown;
    for (const endpoint of sources) {
      try {
        for (const request of await this.openForEndpoint(endpoint, issueType)) out.push({ endpoint, request });
      } catch (err) {
        if (endpoint === this.read) liveFailure = err;
        else this.log('open_list_unavailable', { endpoint: endpoint.id, error: String(err) });
      }
    }
    // Duplicates in the live system are the point of the check: if it cannot be read, say so.
    if (liveFailure !== undefined) throw liveFailure;
    return out;
  }

  private async openForEndpoint(endpoint: EndpointRuntime, issueType: IssueType): Promise<ServiceRequest[]> {
    if (endpoint.kind === 'test') await this.fileableServices(endpoint);
    let services = matchServices(issueType, this.knownServices(endpoint));
    const spec = ISSUE_TYPE_SPECS[issueType];
    const canSearchText = endpoint.client.endpoint(endpoint.kind).textSearch === true;

    if (services.length === 0 && canSearchText) {
      await this.searchByText(endpoint, spec.label);
      services = matchServices(issueType, this.knownServices(endpoint));
    }
    const rows: ServiceRequest[] = [];
    for (const service of services) rows.push(...(await this.openByCode(endpoint, service.service_code)));

    // An empty list for a seeded code could mean the city changed its codes. Check once every six hours.
    const verifyKey = `${endpoint.id}|${issueType}`;
    const lastVerified = this.verified.get(verifyKey) ?? 0;
    if (rows.length === 0 && canSearchText && this.now() - lastVerified > 6 * 3_600_000) {
      this.verified.set(verifyKey, this.now());
      const before = new Set(services.map((s) => s.service_code));
      await this.searchByText(endpoint, spec.label);
      const after = matchServices(issueType, this.knownServices(endpoint)).filter((s) => !before.has(s.service_code));
      for (const service of after) rows.push(...(await this.openByCode(endpoint, service.service_code)));
    } else if (rows.length > 0) {
      this.verified.set(verifyKey, this.now());
    }
    return rows;
  }

  private async openByCode(endpoint: EndpointRuntime, serviceCode: string): Promise<ServiceRequest[]> {
    const key = `${endpoint.id}|${serviceCode}`;
    const t = this.now();
    const cached = this.openLists.get(key);
    if (cached && t - cached.at < OPEN_LIST_TTL_MS) return cached.value;
    const rows = await endpoint.client.searchRequests(
      {
        serviceCode,
        status: 'open',
        startDate: new Date(t - this.config.dedupeWindowDays * DAY_MS),
        endDate: new Date(t),
        limit: 1500,
        maxPages: 5,
      },
      endpoint.kind,
    );
    this.learn(endpoint, rows);
    // Sandbox lists are never cached: a report filed a moment ago must show up as a duplicate.
    if (endpoint.kind === 'production') this.openLists.set(key, { at: t, value: rows });
    return rows;
  }

  private async searchByText(endpoint: EndpointRuntime, text: string): Promise<void> {
    const t = this.now();
    const rows = await endpoint.client.searchRequests(
      { query: text, startDate: new Date(t - this.config.dedupeWindowDays * DAY_MS), endDate: new Date(t), limit: 300, maxPages: 1 },
      endpoint.kind,
    );
    this.learn(endpoint, rows);
  }
}
