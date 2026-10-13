/**
 * Maps the issue types the assistant can choose onto whatever request types a city actually has.
 * Matching is by service name, so it works across cities without hard-coded service codes.
 */
import type { IssueType } from './contract.ts';

export interface IssueTypeSpec {
  /** How we say it, e.g. "pothole". */
  label: string;
  /** Words residents use for it. Shown to the model in the tool schema. */
  synonyms: string[];
  /** Service-name patterns in priority order. The first pattern that matches any service wins. */
  patterns: RegExp[];
}

export const ISSUE_TYPE_SPECS: Record<IssueType, IssueTypeSpec> = {
  pothole: { label: 'pothole', synonyms: ['hole in the road', 'road damage', 'sinkhole'], patterns: [/^pothole/i, /pothole/i, /street repair/i] },
  streetlight: {
    label: 'streetlight outage',
    synonyms: ['street light out', 'lamp post', 'light flickering', 'dark street'],
    patterns: [/street ?light outage/i, /street ?light/i, /light (bulb|outage)/i],
  },
  traffic_signal: { label: 'traffic signal problem', synonyms: ['traffic light', 'walk signal', 'stoplight'], patterns: [/traffic signal request/i, /traffic signal/i, /signal/i] },
  sidewalk: { label: 'sidewalk damage', synonyms: ['broken sidewalk', 'cracked pavement', 'trip hazard'], patterns: [/sidewalk repair/i, /sidewalks?( and curb)?/i] },
  graffiti: { label: 'graffiti', synonyms: ['tagging', 'spray paint', 'vandalism'], patterns: [/graffiti/i] },
  illegal_dumping: { label: 'illegal dumping', synonyms: ['dumped furniture', 'dumped trash', 'mattress on the street'], patterns: [/illegal dumping/i, /dumping/i] },
  missed_trash: { label: 'missed trash or recycling pickup', synonyms: ['trash not collected', 'recycling not picked up', 'missed pickup'], patterns: [/missed (waste|trash)/i, /missed/i] },
  litter: { label: 'litter', synonyms: ['trash on the street', 'debris', 'overflowing bin'], patterns: [/litter/i, /overflowing trash/i] },
  tree: { label: 'tree problem', synonyms: ['fallen tree', 'broken branch', 'tree down', 'needs pruning'], patterns: [/fallen tree/i, /\btree\b/i, /pruning/i] },
  abandoned_vehicle: { label: 'abandoned vehicle', synonyms: ['abandoned car', 'junk car'], patterns: [/abandoned vehicle/i, /abandoned (car|auto)/i] },
  illegal_parking: { label: 'illegal parking', synonyms: ['blocked driveway', 'parked in the bike lane', 'double parked'], patterns: [/illegal parking/i, /parking enforcement/i] },
  rodent: { label: 'rodent sighting', synonyms: ['rats', 'mice', 'rat sighting'], patterns: [/rodent/i] },
  other: { label: 'general request', synonyms: ['anything else', 'something not listed'], patterns: [/^other$/i, /other/i] },
};

export interface NamedService {
  service_code: string;
  service_name: string;
}

/** The services that correspond to an issue type: every service matching the first pattern that hits. */
export function matchServices<T extends NamedService>(issueType: IssueType, services: readonly T[]): T[] {
  for (const pattern of ISSUE_TYPE_SPECS[issueType].patterns) {
    const hits = services.filter((s) => pattern.test(s.service_name));
    if (hits.length > 0) return hits;
  }
  return [];
}

/** One line for the tool schema, e.g. "pothole (hole in the road, road damage, sinkhole)". */
export function describeIssueTypes(): string {
  return Object.entries(ISSUE_TYPE_SPECS)
    .map(([key, spec]) => `${key} (${spec.synonyms.join(', ')})`)
    .join('; ');
}
