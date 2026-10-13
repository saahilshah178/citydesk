import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { baseAddress, buildAddressIndex, IndexedAddressDirectory } from '../src/addressIndex.ts';
import type { AddressRecord } from '../src/addresses.ts';

const row = (address_id: string, full_address: string, neighborhood: string, zip_code: string, trashday = 'M', recollect = trashday): AddressRecord => ({
  address_id,
  full_address,
  neighborhood,
  zip_code,
  lat: 42.35,
  long: -71.07,
  trashday,
  recollect,
});

// Shapes taken from the real dataset.
const ROWS: AddressRecord[] = [
  row('156199', '700 Boylston St', 'Boston', '02116', 'MTH'),
  row('367708', '545 Boylston St 700', 'Boston', '02116', 'MTH'),
  row('193137', '607 Boylston St Ste 700', 'Boston', '02116', 'MTH'),
  row('900', '1 City Hall Plz 802', 'Boston', '02108', 'MF'),
  row('901', '1 City Hall Plz 803', 'Boston', '02108', 'MF'),
  row('145775', '10 Washington St', 'Charlestown', '02129', 'W', 'W1A'),
  row('145890', '10 Washington St', 'Dorchester', '02121', 'M'),
  row('439224', '10 Washington St', 'Hyde Park', '02136', 'M'),
  row('1', '6-10 A St', 'Hyde Park', '02136', 'T'),
  row('2', '88 E Brookline St', 'Roxbury', '02118', 'TF'),
  row('3', '12 Fenway', 'Boston', '02115', 'TF'),
  row('4', '12 Fenway 4B', 'Boston', '02115', 'TF'),
  row('5', '100 Beacon St', 'Boston', '02116', 'MTH'),
  row('6', '100 Beacon Ave', 'Hyde Park', '02136', 'T'),
];

function directory(): IndexedAddressDirectory {
  return new IndexedAddressDirectory(buildAddressIndex(ROWS, { generatedAt: '2026-10-13T08:00:00.000Z', sourceLastModified: '2026-10-11T23:58:03.032Z' }));
}

describe('baseAddress', () => {
  it.each([
    ['700 Boylston St', '700 Boylston St'],
    ['545 Boylston St 700', '545 Boylston St'],
    ['607 Boylston St Ste 700', '607 Boylston St'],
    ['1 City Hall Plz 802', '1 City Hall Plz'],
    ['1079 Commonwealth Ave 207', '1079 Commonwealth Ave'],
    ['6-10 A St', '6-10 A St'],
    ['88 E Brookline St', '88 E Brookline St'],
    ['10 Park St', '10 Park St'],
    ['12 Fenway 4B', '12 Fenway'],
    ['1 Broadway', '1 Broadway'],
    ['15 Court Sq Apt 3', '15 Court Sq'],
  ])('%s becomes %s', (full, base) => {
    expect(baseAddress(full)).toBe(base);
  });
});

describe('buildAddressIndex', () => {
  it('keeps one row per building and neighborhood, preferring the row without a unit', () => {
    const index = buildAddressIndex(ROWS, { generatedAt: '2026-10-13T08:00:00.000Z' });
    expect(index.source_rows).toBe(ROWS.length);
    const addresses = index.rows.map((r) => `${r[0]} | ${index.neighborhoods[r[1]]}`);
    expect(addresses.filter((a) => a.startsWith('1 City Hall Plz'))).toEqual(['1 City Hall Plz | Boston']);
    expect(addresses.filter((a) => a.startsWith('10 Washington St'))).toHaveLength(3);
    expect(addresses.filter((a) => a.startsWith('12 Fenway'))).toEqual(['12 Fenway | Boston']);
    expect(index.rows.find((r) => r[0] === '12 Fenway')![7]).toBe('3');
    // Unit rows of other buildings do not create a "700 Boylston St" of their own.
    expect(addresses.filter((a) => a.startsWith('700 Boylston St'))).toHaveLength(1);
  });
});

describe('IndexedAddressDirectory', () => {
  it('finds an address however it is spoken', async () => {
    const d = directory();
    for (const spoken of ['700 Boylston Street', '700 boylston st', '700 Boylston Street, Boston, MA 02116']) {
      const { matches } = await d.search(spoken);
      expect(matches.map((m) => m.address_id)).toEqual(['156199']);
    }
    expect((await d.search('88 East Brookline Street')).matches[0]).toMatchObject({ full_address: '88 E Brookline St', trashday: 'TF' });
    expect((await d.search('1 city hall plaza')).matches[0]).toMatchObject({ full_address: '1 City Hall Plz', trashday: 'MF' });
  });

  it('returns every neighborhood for a shared address and narrows by neighborhood or ZIP', async () => {
    const d = directory();
    expect((await d.search('10 Washington Street')).matches.map((m) => m.neighborhood)).toEqual(['Charlestown', 'Dorchester', 'Hyde Park']);
    expect((await d.search('10 Washington Street in Hyde Park')).matches.map((m) => m.address_id)).toEqual(['439224']);
    expect((await d.search('10 Washington Street 02129')).matches.map((m) => m.recollect)).toEqual(['W1A']);
  });

  it('accepts a missing street word only when exactly one street fits', async () => {
    const d = directory();
    expect((await d.search('700 Boylston')).matches.map((m) => m.full_address)).toEqual(['700 Boylston St']);
    // "100 Beacon" could be Beacon St or Beacon Ave: not guessed.
    expect((await d.search('100 Beacon')).matches).toEqual([]);
  });

  it('finds nothing for an unknown address or a bare street', async () => {
    const d = directory();
    expect((await d.search('999 Nowhere Street')).matches).toEqual([]);
    expect((await d.search('Boylston Street')).matches).toEqual([]);
  });

  it('reports when the city last refreshed the data, and round-trips through a gzipped file', async () => {
    const index = buildAddressIndex(ROWS, { generatedAt: '2026-10-13T08:00:00.000Z', sourceLastModified: '2026-10-11T23:58:03.032Z' });
    const file = join(mkdtempSync(join(tmpdir(), 'citydesk-idx-')), 'addresses.json.gz');
    writeFileSync(file, gzipSync(JSON.stringify(index)));
    const loaded = IndexedAddressDirectory.load(file)!;
    expect(loaded.size).toBe(index.rows.length);
    expect(await loaded.datasetLastModified()).toBe('2026-10-11T23:58:03.032Z');
    expect(loaded.source).toMatch(/local index of \d+ buildings/);
    expect(IndexedAddressDirectory.load(join(tmpdir(), 'does-not-exist.json.gz'))).toBeUndefined();
    writeFileSync(file, 'not gzip');
    expect(IndexedAddressDirectory.load(file)).toBeUndefined();
  });
});
