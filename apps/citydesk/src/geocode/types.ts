import type { CityConfig } from 'open311-mcp';

export interface Place {
  /** Human-readable label, e.g. "700 Boylston St, Boston, MA 02116". */
  label: string;
  lat: number;
  long: number;
  /** What kind of thing matched. A bare street has no single point, so it is never accepted as-is. */
  kind: 'address' | 'intersection' | 'poi' | 'street' | 'area' | 'unknown';
  neighborhood?: string;
  /** 0..1 as reported by the provider, when it reports one. */
  relevance?: number;
}

export type GeocodeOutcome =
  | { status: 'ok'; place: Place; provider: string }
  | { status: 'ambiguous'; question: string; options: string[]; candidates: Place[]; provider: string }
  | { status: 'not_found'; provider: string };

export interface Geocoder {
  readonly name: string;
  /** Resolves spoken text to a point inside the city's bounding box. */
  geocode(text: string, city: CityConfig): Promise<GeocodeOutcome>;
}
