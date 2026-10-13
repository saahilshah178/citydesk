/**
 * `static_map`: a tool only the cards call, hidden from the assistant. It returns a map image from
 * Amazon Location Service for a point, so the issue card can show where a request is without any
 * map key or external tile URL reaching the browser.
 */
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { STATIC_MAP_TOOL } from './contract.ts';
import type { CityDeskRuntime } from './runtime.ts';

/** `meta` is the `_meta` that marks the tool as app-only for MCP Apps hosts. */
export function registerStaticMapTool(server: McpServer, rt: CityDeskRuntime, meta: Record<string, unknown>): void {
  server.registerTool(
    STATIC_MAP_TOOL,
    {
      title: 'Map image for a card',
      description:
        'Call this from a CityDesk card to draw the map behind a request pin. It is not meant for the assistant. ' +
        'Returns one image content block (base64) centered on the point at street level, or a structured error when maps are unavailable.',
      inputSchema: z.object({
        lat: z.number().min(-90).max(90).describe('Latitude of the map center.'),
        long: z.number().min(-180).max(180).describe('Longitude of the map center.'),
        width: z.number().min(1).max(4096).describe('Image width in pixels. Clamped to 64..1024.'),
        height: z.number().min(1).max(4096).describe('Image height in pixels. Clamped to 64..1024.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: meta,
    },
    async (args): Promise<CallToolResult> => {
      const fail = (code: string, message: string, retryable: boolean): CallToolResult => ({
        isError: true,
        content: [{ type: 'text', text: message }],
        structuredContent: { outcome: 'error', error: { code, message, retryable }, as_of: new Date(rt.now()).toISOString() },
      });
      if (!rt.staticMap) return fail('not_configured', 'Map images are not configured on this server.', false);
      const [minLong, minLat, maxLong, maxLat] = rt.city.bbox;
      // Only draw maps of the service area: this endpoint is not a general-purpose map proxy.
      if (args.long < minLong - 0.05 || args.long > maxLong + 0.05 || args.lat < minLat - 0.05 || args.lat > maxLat + 0.05) {
        return fail('outside_service_area', `That point is outside ${rt.city.name}.`, false);
      }
      try {
        // Map images cost money per request; the daily ceiling is shared through the store.
        const day = new Date(rt.now()).toISOString().slice(0, 10);
        if ((await rt.store.increment(`static_maps#${day}`, 2 * 86_400)) > rt.config.maxStaticMapsPerDay) {
          return fail('rate_limited', 'The daily allowance of map images is used up.', true);
        }
        const image = await rt.staticMap(args);
        return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] };
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        rt.log('static_map_failed', { error: message });
        return fail('upstream_unavailable', 'The map image could not be drawn right now.', true);
      }
    },
  );
}
