import type { SearchForTextResult } from '@aws-sdk/client-location';
import { BOSTON } from 'open311-mcp';
import { describe, expect, it } from 'vitest';
import { parseDayCodes, parseSpokenAddress, rankAddresses, type AddressRecord } from '../src/addresses.ts';
import { AmazonLocationGeocoder, interpretPlaces } from '../src/geocode/amazonLocation.ts';
import { GeocoderChain } from '../src/geocode/bostonAddresses.ts';
import type { Geocoder } from '../src/geocode/types.ts';

/** Builds a result in the shape SearchPlaceIndexForText returns (Esri provider). */
function place(over: {
  label: string;
  point: [number, number];
  relevance?: number;
  number?: string;
  street?: string;
  neighborhood?: string;
  categories?: string[];
}): SearchForTextResult {
  return {
    Relevance: over.relevance ?? 1,
    Place: {
      Label: over.label,
      Geometry: { Point: over.point },
      AddressNumber: over.number,
      Street: over.street,
      Neighborhood: over.neighborhood,
      Municipality: 'Boston',
      Region: 'Massachusetts',
      Country: 'USA',
      Categories: over.categories,
    },
  };
}

const LIBRARY: [number, number] = [-71.0782, 42.3493];

describe('interpretPlaces (Amazon Location results)', () => {
  it('accepts a single confident address', () => {
    const out = interpretPlaces(
      [place({ label: '700 Boylston St, Boston, MA, 02116, USA', point: LIBRARY, number: '700', street: 'Boylston St', categories: ['AddressType'] })],
      BOSTON,
    );
    expect(out).toMatchObject({ status: 'ok', provider: 'amazon-location', place: { kind: 'address', lat: 42.3493, long: -71.0782 } });
  });

  it('accepts a landmark and ignores runners-up at the same spot', () => {
    const out = interpretPlaces(
      [
        place({ label: 'Boston Public Library, 700 Boylston St, Boston, MA, 02116, USA', point: LIBRARY, categories: ['PointOfInterestType'], relevance: 1 }),
        place({ label: 'Boston Public Library - Central, Boston, MA', point: [-71.0784, 42.3494], categories: ['PointOfInterestType'], relevance: 0.98 }),
        place({ label: 'Boston Public Library - Jamaica Plain, Boston, MA', point: [-71.1146, 42.309], categories: ['PointOfInterestType'], relevance: 0.7 }),
      ],
      BOSTON,
    );
    expect(out.status).toBe('ok');
  });

  it('asks which one when two equally good matches are far apart', () => {
    const out = interpretPlaces(
      [
        place({ label: '10 Washington St, Boston, MA, 02129, USA', point: [-71.06367, 42.372639], number: '10', street: 'Washington St', neighborhood: 'Charlestown', relevance: 1 }),
        place({ label: '10 Washington St, Boston, MA, 02121, USA', point: [-71.0827, 42.308309], number: '10', street: 'Washington St', neighborhood: 'Dorchester', relevance: 0.99 }),
      ],
      BOSTON,
    );
    expect(out.status).toBe('ambiguous');
    if (out.status !== 'ambiguous') return;
    expect(out.options).toEqual(['10 Washington St in Charlestown', '10 Washington St in Dorchester']);
    expect(out.question).toMatch(/Which one do you mean\?/);
  });

  it('never accepts a bare street: asks where on it', () => {
    const out = interpretPlaces(
      [place({ label: 'Beacon St, Boston, MA, USA', point: [-71.07, 42.356], street: 'Beacon St', categories: ['StreetType'] })],
      BOSTON,
    );
    expect(out.status).toBe('ambiguous');
    if (out.status !== 'ambiguous') return;
    expect(out.question).toBe('Where on Beacon St is it? A house number, cross street or nearby landmark would help.');
    expect(out.options).toEqual([]);
  });

  it('asks for the neighborhood when the same street name exists in several', () => {
    const out = interpretPlaces(
      [
        place({ label: 'Washington St, Boston, MA, USA', point: [-71.13, 42.286], street: 'Washington St', neighborhood: 'Roslindale', categories: ['StreetType'], relevance: 1 }),
        place({ label: 'Washington St, Boston, MA, USA', point: [-71.074, 42.33], street: 'Washington St', neighborhood: 'Roxbury', categories: ['StreetType'], relevance: 0.97 }),
      ],
      BOSTON,
    );
    expect(out.status).toBe('ambiguous');
    if (out.status !== 'ambiguous') return;
    expect(out.options).toEqual(['Washington St in Roslindale', 'Washington St in Roxbury']);
  });

  it('asks for a street when only a neighborhood matched', () => {
    const out = interpretPlaces(
      [place({ label: 'Roslindale, Boston, MA, USA', point: [-71.13, 42.29], categories: ['NeighborhoodType'] })],
      BOSTON,
    );
    expect(out.status).toBe('ambiguous');
  });

  it('drops results outside the city box and reports not_found when nothing is left', () => {
    const cambridge = place({ label: '77 Massachusetts Ave, Cambridge, MA', point: [-71.0935, 42.3592], number: '77', street: 'Massachusetts Ave' });
    const farAway = place({ label: '700 Boylston St, Springfield', point: [-72.59, 42.1], number: '700', street: 'Boylston St' });
    expect(interpretPlaces([farAway], BOSTON)).toEqual({ status: 'not_found', provider: 'amazon-location' });
    expect(interpretPlaces([], BOSTON).status).toBe('not_found');
    // Cambridge sits inside Boston's bounding rectangle; the box is a filter, not a city boundary.
    expect(interpretPlaces([cambridge], BOSTON).status).toBe('ok');
  });
});

describe('AmazonLocationGeocoder request', () => {
  it('searches the configured place index, restricted to the city bounding box and the USA', async () => {
    const sent: unknown[] = [];
    const geocoder = new AmazonLocationGeocoder({
      indexName: 'citydesk-places',
      client: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        send: async (command: any) => {
          sent.push(command.input);
          return { Results: [place({ label: '700 Boylston St, Boston, MA', point: LIBRARY, number: '700', street: 'Boylston St' })] };
        },
      } as never,
    });
    const out = await geocoder.geocode('the library on Boylston Street', BOSTON);
    expect(out.status).toBe('ok');
    expect(sent[0]).toEqual({
      IndexName: 'citydesk-places',
      Text: 'the library on Boylston Street, Boston',
      FilterBBox: [-71.1912, 42.2279, -70.986, 42.3995],
      FilterCountries: ['USA'],
      MaxResults: 6,
      Language: 'en',
    });
  });
});

describe('GeocoderChain', () => {
  const ok: Geocoder = { name: 'b', geocode: async () => ({ status: 'ok', provider: 'b', place: { label: 'x', lat: 1, long: 2, kind: 'address' } }) };
  const none: Geocoder = { name: 'a', geocode: async () => ({ status: 'not_found', provider: 'a' }) };
  const broken: Geocoder = {
    name: 'broken',
    geocode: async () => {
      throw new Error('no credentials');
    },
  };

  it('falls through "not found" and through failures to the next geocoder', async () => {
    expect((await new GeocoderChain([none, ok]).geocode('x', BOSTON)).status).toBe('ok');
    const failures: string[] = [];
    const chain = new GeocoderChain([broken, ok], (name) => failures.push(name));
    expect((await chain.geocode('x', BOSTON)).status).toBe('ok');
    expect(failures).toEqual(['broken']);
  });

  it('reports not_found when at least one geocoder answered, and throws only when none could', async () => {
    expect((await new GeocoderChain([broken, none]).geocode('x', BOSTON)).status).toBe('not_found');
    await expect(new GeocoderChain([broken]).geocode('x', BOSTON)).rejects.toThrow('no credentials');
  });
});

describe('spoken address parsing', () => {
  it.each([
    ['700 boylston street', '700 Boylston St', ''],
    ['700 Boylston Street, Boston, MA 02116', '700 Boylston St', 'boston ma'],
    ['10 Washington Street in Dorchester', '10 Washington St', 'in dorchester'],
    ['88 East Brookline Street', '88 E Brookline St', ''],
    ['1 city hall plaza', '1 City Hall Plz', ''],
    ['1079 commonwealth avenue', '1079 Commonwealth Ave', ''],
    ['25-27 pratt st.', '25-27 Pratt St', ''],
  ])('%s', (spoken, core, qualifiers) => {
    const parsed = parseSpokenAddress(spoken);
    expect(parsed.core).toBe(core);
    expect(parsed.qualifiers).toBe(qualifiers);
  });

  it('pulls out the ZIP code and the street number', () => {
    expect(parseSpokenAddress('700 Boylston Street 02116')).toMatchObject({ zip: '02116', number: '700' });
    expect(parseSpokenAddress('Boylston Street').number).toBeUndefined();
  });
});

describe('address ranking', () => {
  const row = (full_address: string, neighborhood: string, zip_code: string, address_id: string): AddressRecord => ({
    address_id,
    full_address,
    neighborhood,
    zip_code,
    lat: 42.35,
    long: -71.07,
    trashday: 'M',
    recollect: 'M',
  });

  it('drops rows where the number only matched a unit, and collapses units to the building', () => {
    const parsed = parseSpokenAddress('700 Boylston Street');
    const ranked = rankAddresses(parsed, [
      row('545 Boylston St 700', 'Boston', '02116', '1'),
      row('700 Boylston St 4', 'Boston', '02116', '2'),
      row('700 Boylston St', 'Boston', '02116', '3'),
      row('7000 Boylston St', 'Boston', '02116', '4'),
    ]);
    expect(ranked.map((r) => [r.full_address, r.address_id])).toEqual([['700 Boylston St', '3']]);
  });

  it('keeps one entry per neighborhood, and narrows by a spoken neighborhood or ZIP', () => {
    const rows = [row('10 Washington St', 'Charlestown', '02129', '1'), row('10 Washington St', 'Dorchester', '02121', '2')];
    expect(rankAddresses(parseSpokenAddress('10 Washington Street'), rows)).toHaveLength(2);
    expect(rankAddresses(parseSpokenAddress('10 Washington Street Dorchester'), rows).map((r) => r.neighborhood)).toEqual(['Dorchester']);
    expect(rankAddresses(parseSpokenAddress('10 Washington Street 02129'), rows).map((r) => r.neighborhood)).toEqual(['Charlestown']);
  });

  it('presents a unit-only building without the unit number', () => {
    const ranked = rankAddresses(parseSpokenAddress('1 City Hall Plaza'), [row('1 City Hall Plz 802', 'Boston', '02108', '9')]);
    expect(ranked[0]!.full_address).toBe('1 City Hall Plz');
  });
});

describe('collection day codes', () => {
  it.each([
    ['M', ['Monday']],
    ['TH', ['Thursday']],
    ['MTH', ['Monday', 'Thursday']],
    ['TF', ['Tuesday', 'Friday']],
    ['MF', ['Monday', 'Friday']],
    ['W1A', ['Wednesday']],
    ['TH5', ['Thursday']],
    ['T5', ['Tuesday']],
    ['None', []],
    [undefined, []],
    ['', []],
  ])('%s', (code, days) => {
    expect(parseDayCodes(code)).toEqual(days);
  });
});
