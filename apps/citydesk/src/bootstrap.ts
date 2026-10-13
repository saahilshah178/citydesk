/**
 * Chooses the concrete pieces of the runtime from the environment: which store, which geocoder,
 * whether map images are available. Shared by the local server and the Lambda handler.
 *
 *   CITYDESK_STORE=dynamodb   DynamoDB (table CITYDESK_TABLE); anything else: in-memory
 *   LOCATION_PLACE_INDEX      Amazon Location place index for geocoding; unset: Boston address points only
 *   CITYDESK_STATIC_MAPS      "off" disables Amazon Location map images for the issue card
 *   CITYDESK_ADDRESS_INDEX    path of the local address index built by `pnpm sync:addresses`
 */
import { createStaticMapProvider, MapBudgetError } from './aws/staticMap.ts';
import { IndexedAddressDirectory } from './addressIndex.ts';
import { BostonAddressDirectory, type AddressDirectory } from './addresses.ts';
import { cardHooks } from './cardsHook.ts';
import { AmazonLocationGeocoder } from './geocode/amazonLocation.ts';
import { BostonAddressGeocoder, GeocoderChain, withCache, withCooldown, withDailyBudget } from './geocode/bostonAddresses.ts';
import type { Geocoder } from './geocode/types.ts';
import { CityDeskRuntime, type RuntimeOptions } from './runtime.ts';
import type { CityDeskServerHooks } from './server.ts';
import { DynamoStore } from './store/dynamo.ts';
import { MemoryStore } from './store/memory.ts';

export interface BootstrapOptions {
  env: Record<string, string | undefined>;
  /** Where the in-memory store persists itself. Omit to keep it in memory only. */
  memoryFile?: string;
  /** Candidate paths of the local address index (see addressIndex.ts); the first that loads is used. */
  addressIndexPaths?: string[];
  log?: RuntimeOptions['log'];
}

export interface Bootstrapped {
  runtime: CityDeskRuntime;
  hooks: CityDeskServerHooks;
  /** Human-readable lines describing what was wired up. */
  summary: string[];
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function buildRuntime(options: BootstrapOptions): Promise<Bootstrapped> {
  const { env } = options;
  const log = options.log ?? (() => undefined);
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';
  const summary: string[] = [];

  // Memory.
  let store: RuntimeOptions['store'];
  let sandboxStore: RuntimeOptions['sandboxStore'];
  if (env.CITYDESK_STORE === 'dynamodb') {
    const tableName = env.CITYDESK_TABLE ?? 'citydesk-user-requests';
    const dynamo = new DynamoStore({ tableName, region });
    store = dynamo;
    sandboxStore = dynamo.sandboxStore();
    summary.push(`store: DynamoDB table ${tableName} in ${region}`);
  } else {
    const memory = new MemoryStore(options.memoryFile);
    store = memory;
    sandboxStore = memory.sandboxStore();
    summary.push(`store: memory${options.memoryFile ? ` (persisted to ${options.memoryFile})` : ''}`);
  }

  // Geocoding: Amazon Location first, the city's own address points as the fallback.
  let directory: AddressDirectory | undefined;
  for (const path of [env.CITYDESK_ADDRESS_INDEX, ...(options.addressIndexPaths ?? [])]) {
    if (path && (directory = IndexedAddressDirectory.load(path))) break;
  }
  directory ??= new BostonAddressDirectory();
  summary.push(`addresses: ${directory.source}`);
  const geocoders: Geocoder[] = [];
  const placeIndex = env.LOCATION_PLACE_INDEX;
  if (placeIndex) {
    // Cached, capped per day (the cap is shared through the store), and paused for a while after a failure.
    const perDay = positiveNumber(env.CITYDESK_MAX_GEOCODES_PER_DAY, 1000);
    const amazon = new AmazonLocationGeocoder({ indexName: placeIndex, region });
    geocoders.push(withCache(withCooldown(withDailyBudget(amazon, store, perDay))));
    summary.push(`geocoder: Amazon Location place index ${placeIndex} in ${region} (at most ${perDay} requests a day), then Boston address points`);
  } else {
    summary.push('geocoder: Boston address points only (set LOCATION_PLACE_INDEX for landmarks and intersections)');
  }
  geocoders.push(new BostonAddressGeocoder(directory));
  const geocoder = new GeocoderChain(geocoders, (name, error) =>
    log('geocoder_failed', { geocoder: name, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
  );

  // Map images for the issue card.
  const mapsOn = placeIndex !== undefined && placeIndex !== '' && env.CITYDESK_STATIC_MAPS !== 'off';
  // Only requests that reach Amazon Location count toward the day's allowance; cached images are free.
  const mapsPerDay = positiveNumber(env.CITYDESK_MAX_STATIC_MAPS_PER_DAY, 2000);
  let mapsRefusedOn: string | undefined;
  const staticMap = mapsOn
    ? createStaticMapProvider({
        region,
        beforeRequest: async () => {
          const day = new Date().toISOString().slice(0, 10);
          if (mapsRefusedOn === day) throw new MapBudgetError(mapsPerDay);
          if ((await store.increment(`static_maps#${day}`, 2 * 86_400)) > mapsPerDay) {
            mapsRefusedOn = day;
            throw new MapBudgetError(mapsPerDay);
          }
        },
      })
    : undefined;
  summary.push(`map images: ${mapsOn ? `Amazon Location static maps in ${region}` : 'off'}`);

  const runtime = new CityDeskRuntime({
    env,
    log,
    store,
    sandboxStore,
    directory,
    geocoder,
    staticMap,
    useCityTestEndpoint: env.CITYDESK_USE_CITY_TEST_ENDPOINT === 'true',
    config: {
      dedupeRadiusMeters: positiveNumber(env.CITYDESK_DEDUPE_RADIUS_M, 50),
      dedupeWindowDays: positiveNumber(env.CITYDESK_DEDUPE_WINDOW_DAYS, 30),
      maxFilingsPerUserPerHour: positiveNumber(env.CITYDESK_MAX_FILINGS_PER_USER_PER_HOUR, 10),
      maxFilingsPerCallerPerHour: positiveNumber(env.CITYDESK_MAX_FILINGS_PER_CALLER_PER_HOUR, 20),
      maxFilingsPerHour: positiveNumber(env.CITYDESK_MAX_FILINGS_PER_HOUR, 100),

    },
  });
  summary.push('cards: issue card and schedule card (MCP Apps)');
  return { runtime, hooks: cardHooks(), summary };
}
