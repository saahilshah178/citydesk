import type { CityConfig, EndpointConfig } from './cities.ts';
import { WriteBlockedError } from './errors.ts';

export type Env = Record<string, string | undefined>;

/** True only for the exact string "true", so a typo never opens production. */
export function productionWritesAllowed(env: Env = process.env): boolean {
  return env.ALLOW_PRODUCTION_WRITES === 'true';
}

/**
 * The write guard. Throws WriteBlockedError unless the endpoint is a sandbox, or the operator has
 * explicitly set ALLOW_PRODUCTION_WRITES=true. Called before any request body is built or sent.
 *
 * An endpoint counts as a sandbox only when it is declared `kind: 'test'` AND it is not the same
 * server as the city's production endpoint, which protects against a copy-paste mistake in config.
 */
export function assertWriteAllowed(city: CityConfig, endpoint: EndpointConfig, env: Env = process.env): void {
  if (productionWritesAllowed(env)) return;
  if (endpoint.kind !== 'test') {
    throw new WriteBlockedError(
      `Refusing to create a request on ${city.name}'s production Open311 endpoint (${endpoint.baseUrl}). ` +
        'CityDesk writes only to sandboxes. Set ALLOW_PRODUCTION_WRITES=true to override.',
      { city: city.id, endpoint: endpoint.id, baseUrl: endpoint.baseUrl },
    );
  }
  const production = city.production;
  if (production && normalizeBase(production.baseUrl) === normalizeBase(endpoint.baseUrl)) {
    throw new WriteBlockedError(
      `Endpoint "${endpoint.id}" is marked as a test endpoint but points at ${city.name}'s production server. ` +
        'Refusing to write.',
      { city: city.id, endpoint: endpoint.id, baseUrl: endpoint.baseUrl },
    );
  }
}

function normalizeBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
