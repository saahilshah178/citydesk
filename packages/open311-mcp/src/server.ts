/**
 * The city-agnostic Open311 MCP server: six tools over any set of GeoReport v2 cities.
 *
 * Tool descriptions follow one pattern: when to call the tool, why, and what it returns. Input
 * schemas declare only parameters that are honored. Every result carries IDs and dates in
 * `structuredContent`, and every failure is a structured error with `isError: true`.
 */
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BUILT_IN_CITIES, type CityConfig } from './cities.ts';
import { Open311Client, type EndpointKind, type Open311ClientOptions } from './client.ts';
import { Open311Error } from './errors.ts';
import { haversineMeters } from './geo.ts';
import { productionWritesAllowed, type Env } from './guard.ts';
import type { ServiceRequest } from './types.ts';

export const SERVER_NAME = 'open311-mcp';
export const SERVER_VERSION = '0.1.0';

export interface Open311ServerOptions {
  /** Cities to serve, keyed by id. Defaults to the built-in ones (Boston and New Haven). */
  cities?: Record<string, CityConfig>;
  env?: Env;
  clientOptions?: Open311ClientOptions;
  name?: string;
  version?: string;
}

/** Turns any thrown value into the structured error every tool returns. */
export function toolError(err: unknown): CallToolResult {
  const e =
    err instanceof Open311Error
      ? { code: err.code, message: err.message, retryable: err.retryable, status: err.status, details: err.details }
      : { code: 'internal', message: err instanceof Error ? err.message : String(err), retryable: false };
  return {
    isError: true,
    content: [{ type: 'text', text: `Error (${e.code}): ${e.message}` }],
    structuredContent: { error: e },
  };
}

function ok(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function describeRequest(r: ServiceRequest): string {
  const where = r.address ? ` at ${r.address}` : '';
  return `${r.service_name ?? 'Request'}${where}, ${r.status}, filed ${r.requested_datetime.slice(0, 10)} (ID ${r.service_request_id})`;
}

export function createOpen311Server(options: Open311ServerOptions = {}): McpServer {
  const cities = options.cities ?? BUILT_IN_CITIES;
  const env = options.env ?? process.env;
  const cityIds = Object.keys(cities);
  if (cityIds.length === 0) throw new Error('open311-mcp needs at least one city.');

  const clients = new Map<string, Open311Client>();
  const clientFor = (cityId: string): Open311Client => {
    let client = clients.get(cityId);
    if (!client) {
      client = new Open311Client(cities[cityId]!, { ...options.clientOptions, env });
      clients.set(cityId, client);
    }
    return client;
  };

  const city = z.enum(cityIds as [string, ...string[]]).describe(`City key. One of: ${cityIds.join(', ')}.`);
  const endpoint = z
    .enum(['production', 'test'])
    .default('production')
    .describe('Which endpoint to read: the live "production" system or the "test" sandbox.');
  const nowIso = (): string => new Date().toISOString();

  const server = new McpServer(
    { name: options.name ?? SERVER_NAME, version: options.version ?? SERVER_VERSION },
    {
      instructions:
        'Open311 GeoReport v2 access to city service requests (311). Reads come from each city\'s live system. ' +
        'create_request only ever writes to a sandbox endpoint. Call list_cities first to see what is covered.',
    },
  );

  server.registerTool(
    'list_cities',
    {
      title: 'List cities',
      description:
        'Call this first, when you do not yet know which cities this server covers. It tells you which city keys ' +
        'to pass to the other tools and where new requests can be created. Returns each city\'s key, name, time ' +
        'zone, bounding box, and its endpoints with a flag saying whether each accepts writes.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = Object.values(cities).map((c) => ({
        city: c.id,
        name: c.name,
        time_zone: c.timeZone,
        bbox: { min_long: c.bbox[0], min_lat: c.bbox[1], max_long: c.bbox[2], max_lat: c.bbox[3] },
        endpoints: [c.production, c.test]
          .filter((e) => e !== undefined)
          .map((e) => ({
            id: e.id,
            kind: e.kind,
            base_url: e.baseUrl,
            accepts_writes: e.kind === 'test' || productionWritesAllowed(env),
          })),
      }));
      return ok(`${list.length} cities: ${list.map((c) => `${c.name} (${c.city})`).join(', ')}.`, {
        cities: list,
        as_of: nowIso(),
      });
    },
  );

  server.registerTool(
    'list_services',
    {
      title: 'List request types',
      description:
        'Call this when you need the request types (services) a city accepts, for example to find the service_code ' +
        'for a pothole before searching or creating a request. Returns each service\'s code, name, group, and ' +
        'whether it has extra questions (metadata) that get_service_definition will list.',
      inputSchema: z.object({ city, endpoint }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city: cityId, endpoint: kind }) => {
      try {
        const services = await clientFor(cityId).listServices(kind as EndpointKind);
        return ok(
          `${cities[cityId]!.name} lists ${services.length} request types on its ${kind} endpoint: ` +
            `${services.slice(0, 25).map((s) => s.service_name).join(', ')}${services.length > 25 ? ', ...' : ''}.`,
          { city: cityId, endpoint: kind, count: services.length, services, as_of: nowIso() },
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_service_definition',
    {
      title: 'Get the questions for a request type',
      description:
        'Call this before create_request when list_services shows metadata: true for the service, to learn which ' +
        'extra answers are required. Returns the attributes in order, each with its code, question text, datatype, ' +
        'whether it is required, and the allowed values for list types.',
      inputSchema: z.object({
        city,
        service_code: z.string().min(1).describe('The service_code from list_services.'),
        endpoint,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city: cityId, service_code, endpoint: kind }) => {
      try {
        const definition = await clientFor(cityId).getServiceDefinition(service_code, kind as EndpointKind);
        if (!definition) {
          throw new Open311Error('not_found', `${cities[cityId]!.name} has no definition for service ${service_code}.`, {
            retryable: false,
            details: { city: cityId, service_code },
          });
        }
        const required = definition.attributes.filter((a) => a.required);
        return ok(
          `Service ${service_code} has ${definition.attributes.length} attributes, ${required.length} required` +
            `${required.length > 0 ? `: ${required.map((a) => a.description).join('; ')}` : ''}.`,
          { city: cityId, endpoint: kind, ...definition, as_of: nowIso() },
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'search_requests',
    {
      title: 'Search service requests',
      description:
        'Call this to find existing service requests, for example open potholes near a point or everything filed ' +
        'last week. Use it to check for duplicates before creating a request. Filters combine. Returns matching ' +
        'requests, newest first (nearest first when "near" is given), each with its ID, status, service, address, ' +
        'coordinates, and filed and updated dates.',
      inputSchema: z.object({
        city,
        service_code: z.string().min(1).optional().describe('Only requests of this type.'),
        status: z.enum(['open', 'closed']).optional().describe('Only requests in this state.'),
        start_date: z.iso.datetime({ offset: true }).optional().describe('Earliest filed time, ISO 8601, e.g. 2026-10-01T00:00:00Z.'),
        end_date: z.iso.datetime({ offset: true }).optional().describe('Latest filed time, ISO 8601.'),
        near: z
          .object({
            lat: z.number().min(-90).max(90),
            long: z.number().min(-180).max(180),
            radius_meters: z.number().min(1).max(5000).default(100),
          })
          .optional()
          .describe('Only requests within radius_meters of this point.'),
        bbox: z
          .object({ min_long: z.number(), min_lat: z.number(), max_long: z.number(), max_lat: z.number() })
          .optional()
          .describe('Only requests inside this bounding box.'),
        limit: z.number().int().min(1).max(100).default(20).describe('Most requests to return.'),
        endpoint,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const kind = args.endpoint as EndpointKind;
        const requests = await clientFor(args.city).searchRequests(
          {
            serviceCode: args.service_code,
            status: args.status,
            startDate: args.start_date ? new Date(args.start_date) : undefined,
            endDate: args.end_date ? new Date(args.end_date) : undefined,
            near: args.near
              ? { lat: args.near.lat, long: args.near.long, radiusMeters: args.near.radius_meters }
              : undefined,
            bbox: args.bbox ? [args.bbox.min_long, args.bbox.min_lat, args.bbox.max_long, args.bbox.max_lat] : undefined,
            limit: args.limit,
          },
          kind,
        );
        const rows = requests.map((r) => ({
          ...r,
          ...(args.near && r.lat !== undefined && r.long !== undefined
            ? { distance_m: Math.round(haversineMeters(args.near.lat, args.near.long, r.lat, r.long)) }
            : {}),
        }));
        const head = rows.slice(0, 5).map(describeRequest).join('; ');
        return ok(
          rows.length === 0
            ? `No matching requests in ${cities[args.city]!.name}.`
            : `${rows.length} matching requests in ${cities[args.city]!.name}. ${head}${rows.length > 5 ? '; ...' : ''}`,
          { city: args.city, endpoint: kind, count: rows.length, requests: rows, as_of: nowIso() },
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'get_request',
    {
      title: 'Get one service request',
      description:
        'Call this when you have a service request ID and need its current state. Returns the request with its ' +
        'status, the city\'s latest status notes, service, address, coordinates, and filed, updated and expected dates.',
      inputSchema: z.object({
        city,
        service_request_id: z.string().min(1).describe('The city\'s ID for the request.'),
        endpoint,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ city: cityId, service_request_id, endpoint: kind }) => {
      try {
        const request = await clientFor(cityId).getRequest(service_request_id, kind as EndpointKind);
        if (!request) {
          throw new Open311Error('not_found', `${cities[cityId]!.name} has no request with ID ${service_request_id}.`, {
            retryable: false,
            details: { city: cityId, service_request_id },
          });
        }
        return ok(`${describeRequest(request)}.${request.status_notes ? ` Latest note: ${request.status_notes}` : ''}`, {
          city: cityId,
          endpoint: kind,
          request,
          as_of: nowIso(),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    'create_request',
    {
      title: 'Create a service request (sandbox only)',
      description:
        'Call this to file a new service request after you have checked for duplicates with search_requests. It ' +
        'writes to the city\'s TEST endpoint and refuses to touch production unless the operator set ' +
        'ALLOW_PRODUCTION_WRITES=true. Give a location as lat and long, as an address, or both. Returns the new ' +
        'service_request_id (or a token when the city assigns the ID later), the endpoint it was filed on, and the time.',
      inputSchema: z.object({
        city,
        service_code: z.string().min(1).describe('The service_code from list_services on the test endpoint.'),
        description: z.string().min(1).max(4000).describe('What is wrong, in the reporter\'s words.'),
        lat: z.number().min(-90).max(90).optional(),
        long: z.number().min(-180).max(180).optional(),
        address: z.string().min(1).optional().describe('Street address or intersection.'),
        attributes: z
          .record(z.string(), z.string())
          .optional()
          .describe('Answers to the service definition, keyed by attribute code.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const client = clientFor(args.city);
        const target = client.endpoint('test');
        const created = await client.createRequest(
          {
            serviceCode: args.service_code,
            description: args.description,
            lat: args.lat,
            long: args.long,
            addressString: args.address,
            attributes: args.attributes,
          },
          'test',
        );
        const idText = created.service_request_id ? `ID ${created.service_request_id}` : `token ${created.token}`;
        return ok(`Filed in the ${cities[args.city]!.name} sandbox (${target.id}) with ${idText}.`, {
          city: args.city,
          endpoint: 'test',
          endpoint_id: target.id,
          sandbox: true,
          ...created,
          created_at: nowIso(),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}
