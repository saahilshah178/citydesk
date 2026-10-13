/**
 * Fallback geocoder for plain Boston street addresses, backed by the city's own address points.
 * It cannot resolve landmarks or intersections; Amazon Location Service handles those.
 */
import type { CityConfig } from 'open311-mcp';
import type { BostonAddressDirectory } from '../addresses.ts';
import type { GeocodeOutcome, Geocoder, Place } from './types.ts';

const PROVIDER = 'boston-address-points';

export class BostonAddressGeocoder implements Geocoder {
  readonly name = PROVIDER;
  constructor(private readonly directory: BostonAddressDirectory) {}

  async geocode(text: string, city: CityConfig): Promise<GeocodeOutcome> {
    if (city.id !== 'boston') return { status: 'not_found', provider: PROVIDER };
    const { parsed, matches } = await this.directory.search(text);
    const places: Place[] = matches
      .filter((m) => m.lat !== undefined && m.long !== undefined)
      .map((m) => ({
        label: `${m.full_address}, ${m.neighborhood ?? city.name}, MA${m.zip_code ? ` ${m.zip_code}` : ''}`,
        lat: m.lat!,
        long: m.long!,
        kind: 'address' as const,
        neighborhood: m.neighborhood,
      }));
    if (places.length === 0) return { status: 'not_found', provider: PROVIDER };
    if (places.length === 1) return { status: 'ok', place: places[0]!, provider: PROVIDER };
    const options = places.slice(0, 5).map((p) => p.neighborhood ?? p.label);
    return {
      status: 'ambiguous',
      question: `There is a ${parsed.core} in more than one neighborhood. Which one: ${joinOr(options)}?`,
      options,
      candidates: places.slice(0, 5),
      provider: PROVIDER,
    };
  }
}

/** Tries each geocoder in order and returns the first answer that is not "not found". */
export class GeocoderChain implements Geocoder {
  readonly name: string;
  constructor(
    private readonly geocoders: Geocoder[],
    private readonly onFailure?: (geocoder: string, error: unknown) => void,
  ) {
    this.name = geocoders.map((g) => g.name).join(' > ');
  }

  async geocode(text: string, city: CityConfig): Promise<GeocodeOutcome> {
    let answered = false;
    let failure: unknown;
    for (const geocoder of this.geocoders) {
      try {
        const outcome = await geocoder.geocode(text, city);
        answered = true;
        if (outcome.status !== 'not_found') return outcome;
      } catch (err) {
        failure = err;
        this.onFailure?.(geocoder.name, err);
      }
    }
    // A failure only surfaces when no geocoder in the chain could answer at all.
    if (!answered && failure !== undefined) throw failure;
    return { status: 'not_found', provider: this.name };
  }
}

export function joinOr(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
