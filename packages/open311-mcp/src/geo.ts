import type { BoundingBox } from './types.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in meters between two WGS84 points. */
export function haversineMeters(aLat: number, aLong: number, bLat: number, bLong: number): number {
  const dLat = toRad(bLat - aLat);
  const dLong = toRad(bLong - aLong);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLong / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function inBoundingBox(lat: number, long: number, bbox: BoundingBox): boolean {
  const [minLong, minLat, maxLong, maxLat] = bbox;
  return long >= minLong && long <= maxLong && lat >= minLat && lat <= maxLat;
}

/** The smallest box that contains every point within radiusMeters of the center. */
export function boundingBoxAround(lat: number, long: number, radiusMeters: number): BoundingBox {
  const dLat = (radiusMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLong = dLat / Math.max(0.01, Math.cos(toRad(lat)));
  return [long - dLong, lat - dLat, long + dLong, lat + dLat];
}
