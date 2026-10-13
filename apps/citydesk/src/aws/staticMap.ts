/**
 * Map images for the issue card, from Amazon Location Service (Maps API, GetStaticMap).
 * The card asks for one through the app-only `static_map` tool, so no map key reaches the browser.
 */
import { GeoMapsClient, GetStaticMapCommand } from '@aws-sdk/client-geo-maps';
import type { StaticMapInput } from '../contract.ts';
import type { StaticMapProvider } from '../runtime.ts';

export interface StaticMapOptions {
  region?: string;
  client?: Pick<GeoMapsClient, 'send'>;
  /** Street-level by default. */
  zoom?: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(n)));

export function createStaticMapProvider(opts: StaticMapOptions = {}): StaticMapProvider {
  const client = opts.client ?? new GeoMapsClient(opts.region ? { region: opts.region } : {});
  const cache = new Map<string, { data: string; mimeType: string }>();
  return async (input: StaticMapInput) => {
    const width = clamp(input.width, 64, 1024);
    const height = clamp(input.height, 64, 1024);
    // Round to about 1 m so repeat views of the same request hit the cache.
    const lat = Number(input.lat.toFixed(5));
    const long = Number(input.long.toFixed(5));
    const key = `${lat},${long},${width}x${height}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const out = await client.send(
      new GetStaticMapCommand({
        FileName: 'map',
        Center: `${long},${lat}`,
        Zoom: opts.zoom ?? 16,
        Width: width,
        Height: height,
        ScaleBarUnit: 'Miles',
      }),
    );
    if (!out.Blob || out.Blob.length === 0) throw new Error('Amazon Location returned an empty map image.');
    const image = { data: Buffer.from(out.Blob).toString('base64'), mimeType: out.ContentType ?? 'image/jpeg' };
    if (cache.size > 200) cache.clear();
    cache.set(key, image);
    return image;
  };
}
