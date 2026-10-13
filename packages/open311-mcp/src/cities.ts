import { z } from 'zod';
import type { BoundingBox } from './types.ts';

/** One GeoReport v2 endpoint of a city. */
export interface EndpointConfig {
  /** Stable identifier, unique across all cities. Used in request handles such as "boston/<id>". */
  id: string;
  /** Only `test` endpoints accept writes unless ALLOW_PRODUCTION_WRITES=true. */
  kind: 'production' | 'test';
  /** Base URL without a trailing slash, e.g. https://311.boston.gov/open311/v2 */
  baseUrl: string;
  /** Name of the environment variable holding the API key, if the endpoint takes one. */
  apiKeyEnv?: string;
  jurisdictionId?: string;
  /** Requests per minute this client allows itself against the endpoint. */
  rateLimitPerMinute: number;
  /** Longest start_date..end_date span the server accepts. Default 90. */
  maxDateSpanDays?: number;
  /** Query parameter names for paging, when the server supports paging. */
  pageParam?: string;
  pageSizeParam?: string;
  /** Page size to ask for. Default 100. */
  pageSize?: number;
  /** `point`: the server narrows results by `lat` and `long`. `none`: it ignores spatial parameters. */
  spatial?: 'none' | 'point';
  /** Sent as lat/long on service and request lists when the caller gives no location (SeeClickFix scopes by point). */
  referencePoint?: { lat: number; long: number };
  /** The server supports free-text `q`. */
  textSearch?: boolean;
  /** The server supports `extensions=true`. */
  extensions?: boolean;
  /** Replaces the network for this endpoint (used by the in-process sandbox and by tests). */
  fetch?: typeof fetch;
}

export interface CityConfig {
  id: string;
  name: string;
  /** IANA time zone, e.g. America/New_York. */
  timeZone: string;
  /** [minLongitude, minLatitude, maxLongitude, maxLatitude] of the service area. */
  bbox: BoundingBox;
  production?: EndpointConfig;
  test?: EndpointConfig;
}

/**
 * Boston, MA. Both endpoints are the ones Boston's Open311 discovery document lists
 * (https://311.boston.gov/open311/discovery.json). The same API also answers at
 * https://311.boston.gov/open311/v2, but that hostname sits behind the city's web firewall, which
 * starts answering automated clients with an HTML challenge page (HTTP 200) after a few minutes of
 * steady requests, so the discovery endpoint is the one to use.
 *
 * Reads need no key (about 10 requests a minute); BOSTON_OPEN311_API_KEY raises the limit.
 * The server ignores spatial filters, so area filtering happens in the client.
 */
export const BOSTON: CityConfig = {
  id: 'boston',
  name: 'Boston',
  timeZone: 'America/New_York',
  bbox: [-71.1912, 42.2279, -70.986, 42.3995],
  production: {
    id: 'boston',
    kind: 'production',
    baseUrl: 'https://boston2-production.spotmobile.net/open311/v2',
    apiKeyEnv: 'BOSTON_OPEN311_API_KEY',
    rateLimitPerMinute: 10,
    maxDateSpanDays: 90,
    pageParam: 'page',
    pageSizeParam: 'per_page',
    pageSize: 300,
    spatial: 'none',
    textSearch: true,
    extensions: true,
  },
  test: {
    id: 'boston-test',
    kind: 'test',
    baseUrl: 'https://boston2-test.spotmobile.net/open311/v2',
    apiKeyEnv: 'BOSTON_OPEN311_API_KEY',
    rateLimitPerMinute: 10,
    maxDateSpanDays: 90,
    pageParam: 'page',
    pageSizeParam: 'per_page',
    pageSize: 300,
    spatial: 'none',
    textSearch: true,
    extensions: true,
  },
};

/**
 * New Haven, CT on SeeClickFix. SeeClickFix scopes services and requests by a point, so both
 * endpoints carry a reference point. The test endpoint is SeeClickFix's public sandbox.
 */
export const NEW_HAVEN: CityConfig = {
  id: 'new-haven',
  name: 'New Haven',
  timeZone: 'America/New_York',
  bbox: [-72.998, 41.246, -72.861, 41.351],
  production: {
    id: 'new-haven',
    kind: 'production',
    baseUrl: 'https://seeclickfix.com/open311/v2',
    apiKeyEnv: 'SEECLICKFIX_API_KEY',
    rateLimitPerMinute: 20,
    pageParam: 'page',
    spatial: 'point',
    referencePoint: { lat: 41.3083, long: -72.9279 },
  },
  test: {
    id: 'seeclickfix-test',
    kind: 'test',
    baseUrl: 'https://test.seeclickfix.com/open311/v2',
    apiKeyEnv: 'SEECLICKFIX_API_KEY',
    rateLimitPerMinute: 20,
    pageParam: 'page',
    spatial: 'point',
    referencePoint: { lat: 41.3083, long: -72.9279 },
  },
};

export const BUILT_IN_CITIES: Readonly<Record<string, CityConfig>> = {
  [BOSTON.id]: BOSTON,
  [NEW_HAVEN.id]: NEW_HAVEN,
};

const pointSchema = z.object({ lat: z.number().min(-90).max(90), long: z.number().min(-180).max(180) });

const endpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes'),
  kind: z.enum(['production', 'test']),
  baseUrl: z.url().refine((u) => !u.endsWith('/'), 'no trailing slash'),
  apiKeyEnv: z.string().optional(),
  jurisdictionId: z.string().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(6000),
  maxDateSpanDays: z.number().int().min(1).optional(),
  pageParam: z.string().optional(),
  pageSizeParam: z.string().optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
  spatial: z.enum(['none', 'point']).optional(),
  referencePoint: pointSchema.optional(),
  textSearch: z.boolean().optional(),
  extensions: z.boolean().optional(),
});

const citySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    timeZone: z.string().min(1),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    production: endpointSchema.optional(),
    test: endpointSchema.optional(),
  })
  .superRefine((city, ctx) => {
    const [minLong, minLat, maxLong, maxLat] = city.bbox;
    if (minLong >= maxLong || minLat >= maxLat) {
      ctx.addIssue({ code: 'custom', message: 'bbox must be [minLong, minLat, maxLong, maxLat]' });
    }
    if (!city.production && !city.test) {
      ctx.addIssue({ code: 'custom', message: 'a city needs at least one endpoint' });
    }
    if (city.production && city.production.kind !== 'production') {
      ctx.addIssue({ code: 'custom', message: 'production.kind must be "production"' });
    }
    if (city.test && city.test.kind !== 'test') {
      ctx.addIssue({ code: 'custom', message: 'test.kind must be "test"' });
    }
    if (city.production && city.test && sameOrigin(city.production.baseUrl, city.test.baseUrl)) {
      ctx.addIssue({
        code: 'custom',
        message: 'test.baseUrl must not be the production server: writes would reach production',
      });
    }
  });

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

/** Validates city configs loaded from JSON (a single city, an array, or a map keyed by city id). */
export function parseCities(input: unknown): Record<string, CityConfig> {
  const list = Array.isArray(input)
    ? input
    : input && typeof input === 'object' && !('id' in input)
      ? Object.values(input as Record<string, unknown>)
      : [input];
  const cities: Record<string, CityConfig> = {};
  const endpointIds = new Set<string>();
  for (const raw of list) {
    const city = citySchema.parse(raw) as CityConfig;
    if (cities[city.id]) throw new Error(`duplicate city id "${city.id}"`);
    for (const endpoint of [city.production, city.test]) {
      if (!endpoint) continue;
      if (endpointIds.has(endpoint.id)) throw new Error(`duplicate endpoint id "${endpoint.id}"`);
      endpointIds.add(endpoint.id);
    }
    cities[city.id] = city;
  }
  return cities;
}
