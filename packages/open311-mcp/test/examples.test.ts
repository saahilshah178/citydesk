import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOSTON, NEW_HAVEN, parseCities } from '../src/index.ts';

describe('examples.cities.json (the two-city config shown in the README)', () => {
  const file = resolve(import.meta.dirname, '..', 'examples.cities.json');
  const cities = parseCities(JSON.parse(readFileSync(file, 'utf8')));

  it('is a valid config', () => {
    expect(Object.keys(cities)).toEqual(['boston', 'new-haven']);
  });

  it('matches the built-in Boston and New Haven endpoints', () => {
    expect(cities.boston!.production!.baseUrl).toBe(BOSTON.production!.baseUrl);
    expect(cities.boston!.test!.baseUrl).toBe(BOSTON.test!.baseUrl);
    expect(cities['new-haven']!.production).toEqual(NEW_HAVEN.production);
    expect(cities['new-haven']!.test).toEqual(NEW_HAVEN.test);
    expect(cities.boston!.bbox).toEqual([...BOSTON.bbox]);
  });
});
