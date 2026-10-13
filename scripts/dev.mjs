/**
 * Starts everything for local use with one command: `pnpm dev`.
 *
 *   server   CityDesk MCP server            http://localhost:8787/mcp
 *   api      web client backend             http://localhost:8788   (Bedrock and Polly; needs AWS)
 *   client   Echo Show style web client     http://localhost:5173   (add ?dev for the developer drawer)
 *
 * Ctrl+C stops all three.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, 'packages', 'open311-mcp', 'dist', 'index.js'))) {
  console.error('The open311-mcp package is not built yet. Run `pnpm build` once, then `pnpm dev` again.');
  process.exit(1);
}

const processes = [
  { name: 'server', color: 36, cwd: 'apps/citydesk', args: ['exec', 'tsx', 'src/dev.ts'] },
  { name: 'api', color: 35, cwd: 'apps/sim-client', args: ['exec', 'tsx', 'server/dev.ts'] },
  { name: 'client', color: 33, cwd: 'apps/sim-client', args: ['exec', 'vite', '--port', '5173', '--strictPort'] },
];

const children = processes.map(({ name, color, cwd, args }) => {
  const child = spawn('pnpm', args, { cwd: resolve(root, cwd), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\u001b[${color}m${name.padEnd(6)}\u001b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') process.stdout.write(`${tag}${line}\n`);
    });
  }
  child.on('exit', (code) => {
    process.stdout.write(`${tag}stopped${code ? ` (exit ${code})` : ''}\n`);
    // One process going down makes the whole thing useless: stop the rest.
    stop(code ?? 0);
  });
  return child;
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
console.log('CityDesk: open http://localhost:5173/?dev once the three processes are up.\n');
