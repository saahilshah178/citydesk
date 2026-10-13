import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { build as esbuild } from 'esbuild';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const root = import.meta.dirname;
/** `.env` lives at the repo root and is shared with the MCP server and the scripts. */
const envDir = resolve(root, '..', '..');

/**
 * Builds `sandbox.html`, the MCP Apps sandbox proxy, as one self-contained file.
 *
 * The proxy script is bundled separately and inlined, never emitted as an asset: when the proxy
 * shares a host with the client it runs with an opaque origin, and an opaque-origin document
 * cannot load a module script from its own host unless that host answers with CORS headers.
 * An inline classic script has no such dependency, so the file works from any static host.
 */
function sandboxProxy(allowedEmbedders: string[]): Plugin {
  const render = async (minify: boolean): Promise<string> => {
    const [template, bundle] = await Promise.all([
      readFile(resolve(root, 'src/sandbox/sandbox.html'), 'utf8'),
      esbuild({
        entryPoints: [resolve(root, 'src/sandbox/proxy.ts')],
        bundle: true,
        format: 'iife',
        target: 'es2022',
        minify,
        write: false,
        define: { __SANDBOX_ALLOWED_EMBEDDERS__: JSON.stringify(allowedEmbedders) },
      }),
    ]);
    const script = bundle.outputFiles[0]?.text ?? '';
    // A literal "</script" inside the bundle would end the inline script element early.
    const inline = `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`;
    return template.replace('<!-- sandbox-proxy-script -->', () => inline);
  };

  return {
    name: 'citydesk-sandbox-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sandbox.html') return next();
        render(false).then(
          (html) => {
            res.setHeader('content-type', 'text/html; charset=utf-8');
            res.setHeader('cache-control', 'no-store');
            res.end(html);
          },
          (error: unknown) => next(error),
        );
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sandbox.html', source: await render(true) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_');
  const allowedEmbedders = (env['VITE_SANDBOX_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    root,
    envDir,
    plugins: [react(), sandboxProxy(allowedEmbedders)],
    server: {
      port: 5173,
      // The MCP server allows this exact origin (MCP_ALLOWED_ORIGINS), so do not drift to 5174.
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${process.env['API_PORT'] ?? 8788}`, changeOrigin: false } },
    },
    preview: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${process.env['API_PORT'] ?? 8788}`, changeOrigin: false } },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // One chunk of about 600 kB: React, the MCP client SDK, the MCP Apps bridge and zod.
      chunkSizeWarningLimit: 800,
    },
  };
});
