/**
 * Geocoding with Amazon Location Service (Places API, SearchPlaceIndexForText), restricted to the
 * city's bounding box. `interpretPlaces` turns the ranked results into a decision: accept one place,
 * or ask the resident one clarifying question.
 */
import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
  type SearchForTextResult,
} from '@aws-sdk/client-location';
import { haversineMeters, type CityConfig } from 'open311-mcp';
import type { GeocodeOutcome, Geocoder, Place } from './types.ts';

const PROVIDER = 'amazon-location';
/** Two results closer than this are the same spot for our purposes. */
const SAME_SPOT_METERS = 60;
/** A runner-up scoring this far below the winner is not a real alternative. */
const CLEAR_LEAD = 0.08;

export interface AmazonLocationGeocoderOptions {
  indexName: string;
  client?: Pick<LocationClient, 'send'>;
  region?: string;
}

export class AmazonLocationGeocoder implements Geocoder {
  readonly name = PROVIDER;
  private readonly client: Pick<LocationClient, 'send'>;
  private readonly indexName: string;

  constructor(opts: AmazonLocationGeocoderOptions) {
    this.indexName = opts.indexName;
    this.client = opts.client ?? new LocationClient(opts.region ? { region: opts.region } : {});
  }

  async geocode(text: string, city: CityConfig): Promise<GeocodeOutcome> {
    const query = /\b(boston|ma|massachusetts)\b/i.test(text) || city.id !== 'boston' ? text : `${text}, ${city.name}`;
    const out = await this.client.send(
      new SearchPlaceIndexForTextCommand({
        IndexName: this.indexName,
        Text: query,
        FilterBBox: [...city.bbox],
        FilterCountries: ['USA'],
        MaxResults: 6,
        Language: 'en',
      }),
    );
    return interpretPlaces(out.Results ?? [], city);
  }
}

function toPlace(result: SearchForTextResult): Place | undefined {
  const p = result.Place;
  const point = p?.Geometry?.Point;
  if (!p || !point || point.length < 2) return undefined;
  const categories = (p.Categories ?? []).map((c) => c.toLowerCase());
  let kind: Place['kind'] = 'unknown';
  if (categories.some((c) => c.includes('intersection'))) kind = 'intersection';
  else if (categories.some((c) => c.includes('pointofinterest'))) kind = 'poi';
  else if (p.AddressNumber || categories.some((c) => c.includes('addresstype'))) kind = 'address';
  else if (categories.some((c) => c.includes('street'))) kind = 'street';
  else if (categories.some((c) => /neighborhood|municipality|postal|region/.test(c))) kind = 'area';
  // Providers do not always send categories: fall back on the fields that are present.
  if (kind === 'unknown') kind = p.AddressNumber ? 'address' : p.Street ? 'street' : 'unknown';
  return {
    label: p.Label ?? [p.AddressNumber, p.Street, p.Municipality].filter(Boolean).join(' '),
    long: point[0]!,
    lat: point[1]!,
    kind,
    neighborhood: p.Neighborhood ?? p.Municipality,
    relevance: result.Relevance,
  };
}

/** Short label for a spoken list of choices: drops the state, ZIP and country. */
function optionLabel(place: Place): string {
  const parts = place.label.split(',').map((s) => s.trim());
  const head = parts[0] ?? place.label;
  const hood = place.neighborhood && !head.includes(place.neighborhood) ? ` in ${place.neighborhood}` : '';
  return `${head}${hood}`;
}

export function interpretPlaces(results: SearchForTextResult[], city: CityConfig): GeocodeOutcome {
  const [minLong, minLat, maxLong, maxLat] = city.bbox;
  const places = results
    .map(toPlace)
    .filter((p): p is Place => p !== undefined)
    .filter((p) => p.long >= minLong && p.long <= maxLong && p.lat >= minLat && p.lat <= maxLat);
  const first = places[0];
  if (!first) return { status: 'not_found', provider: PROVIDER };

  if (first.kind === 'area') {
    return {
      status: 'ambiguous',
      question: `Where in ${optionLabel(first)} is it? A street address or the nearest cross streets would help.`,
      options: [],
      candidates: places.slice(0, 5),
      provider: PROVIDER,
    };
  }

  // Real alternatives: other results nearly as relevant as the winner and somewhere else.
  const lead = first.relevance ?? 1;
  const rivals = places.slice(1).filter((p) => {
    const closeScore = (p.relevance ?? 0) >= lead - CLEAR_LEAD;
    const elsewhere = haversineMeters(first.lat, first.long, p.lat, p.long) > SAME_SPOT_METERS;
    return closeScore && elsewhere;
  });

  if (first.kind === 'street') {
    const streets = [first, ...rivals.filter((p) => p.kind === 'street')];
    const distinct = [...new Map(streets.map((p) => [optionLabel(p), p])).values()].slice(0, 5);
    const name = first.label.split(',')[0]!.trim();
    return distinct.length > 1
      ? {
          status: 'ambiguous',
          question: `There is more than one ${name}. Which neighborhood is it in, and what is the nearest cross street?`,
          options: distinct.map(optionLabel),
          candidates: distinct,
          provider: PROVIDER,
        }
      : {
          status: 'ambiguous',
          question: `Where on ${name} is it? A house number, cross street or nearby landmark would help.`,
          options: [],
          candidates: [first],
          provider: PROVIDER,
        };
  }

  if (rivals.length > 0) {
    const distinct = [...new Map([first, ...rivals].map((p) => [optionLabel(p), p])).values()].slice(0, 5);
    if (distinct.length > 1) {
      return {
        status: 'ambiguous',
        question: 'I found more than one place that matches. Which one do you mean?',
        options: distinct.map(optionLabel),
        candidates: distinct,
        provider: PROVIDER,
      };
    }
  }
  return { status: 'ok', place: first, provider: PROVIDER };
}
