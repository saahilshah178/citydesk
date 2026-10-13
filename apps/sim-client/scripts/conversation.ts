/**
 * Scripted conversation runner: plays a scenario of user turns through the same loop the browser
 * uses, headlessly. The model is called directly on Amazon Bedrock (no backend in between) and
 * the tools are called on a real MCP server over Streamable HTTP.
 *
 *   pnpm --filter @citydesk/sim-client conversation \
 *     --scenario apps/sim-client/scripts/scenarios/example.json --out results/sim-client/example.json
 *
 * Exit code 0 when every turn passed, 1 when any failed, 2 for a setup problem.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDirectConverse } from '../server/bedrock.ts';
import { loadConfig } from '../server/config.ts';
import { buildSystemPrompt } from '../server/prompt.ts';
import { isModelVisible } from '../src/assistant/tools.ts';
import { McpSession } from '../src/mcp/session.ts';
import { runScenario, type TurnReport } from './lib/runner.ts';
import { parseScenario } from './lib/scenario.ts';

const HELP = `Usage: tsx scripts/conversation.ts [options]

  --scenario <file>        Scenario JSON (default: the placeholder in scripts/scenarios/example.json)
  --out <file>             Where to save the JSON record (not saved when omitted)
                           Both paths are relative to the directory the command was run from.
  --mcp-url <url>          MCP server (default: MCP_URL, then VITE_MCP_URL, then http://localhost:8787/mcp)
  --token <token>          Bearer token (default: MCP_CLIENT_TOKEN, then the first of MCP_BEARER_TOKENS)
  --device <uuid>          X-CityDesk-Device value (default: a new UUID per run, so memory starts empty)
  --model <id>             Bedrock model or inference profile ID (default: BEDROCK_MODEL_ID)
  --region <region>        AWS region (default: AWS_REGION, then us-east-1)
  --max-tool-rounds <n>    Tool rounds allowed per turn (default: 4)
  --structured-as <kind>   Feed structuredContent back as "json" or "text" (default: json)
  --help

AWS credentials come from the usual SDK chain (environment, shared config, SSO).`;

class SetupError extends Error {}

function describe(turn: TurnReport): string {
  const lines: string[] = [];
  if (turn.waited_seconds > 0) lines.push(`\n    (waited ${turn.waited_seconds} s)`);
  if (turn.new_session) lines.push('\n    --- new session: history cleared, MCP client reconnected, same device ---');
  lines.push(`\n[${turn.index}] Resident: ${turn.user}`);
  for (const call of turn.tool_calls) {
    const verdict = call.error ?? call.outcome ?? (call.is_error ? 'error' : 'ok');
    lines.push(`    tool  ${call.name} ${JSON.stringify(call.arguments)} -> ${verdict} (${call.duration_ms} ms)`);
  }
  if (turn.ending === 'skipped') lines.push('    skipped: an earlier turn failed');
  else if (turn.reply === null) lines.push(`    FAILED: ${turn.error ?? 'unknown error'}`);
  else {
    lines.push(`    CityDesk: ${turn.reply}`);
    if (turn.ending !== 'reply') lines.push(`    note  the turn ended as "${turn.ending}"${turn.error ? `: ${turn.error}` : ''}`);
    if (turn.guard_truncated) lines.push(`    note  the model wrote ${turn.model_sentence_count} sentences; the guard cut the reply`);
    if (turn.guard_removed_ids) lines.push('    note  the guard removed a long ID from the reply');
  }
  for (const check of turn.expectations) {
    lines.push(`    ${check.pass ? 'PASS' : 'FAIL'}  ${check.check} = ${check.expected}${check.pass ? '' : ` (got: ${check.actual})`}`);
  }
  const { total, converse, tools } = turn.timings_ms;
  if (turn.ending !== 'skipped') lines.push(`    time  ${total} ms total, ${converse} ms model, ${tools} ms tools`);
  return lines.join('\n');
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string' },
      out: { type: 'string' },
      'mcp-url': { type: 'string' },
      token: { type: 'string' },
      device: { type: 'string' },
      model: { type: 'string' },
      region: { type: 'string' },
      'max-tool-rounds': { type: 'string' },
      'structured-as': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  // Same rule as the dev server: the repo-root .env fills in what the environment does not set.
  const envFile = resolve(import.meta.dirname, '..', '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = await loadConfig();

  const modelId = values.model ?? config.modelId;
  if (!modelId) throw new SetupError('No model: set BEDROCK_MODEL_ID or pass --model.');
  const region = values.region ?? config.region;
  const mcpUrl = values['mcp-url'] ?? config.mcpUrl;
  const token = values.token ?? config.mcpToken;
  const deviceId = values.device ?? randomUUID();
  const structuredFormat = values['structured-as'] ?? config.toolResultFormat;
  if (structuredFormat !== 'json' && structuredFormat !== 'text') {
    throw new SetupError('--structured-as must be "json" or "text".');
  }
  const maxToolRounds = values['max-tool-rounds'] === undefined ? undefined : Number(values['max-tool-rounds']);
  if (maxToolRounds !== undefined && (!Number.isInteger(maxToolRounds) || maxToolRounds < 0)) {
    throw new SetupError('--max-tool-rounds must be a whole number.');
  }

  // pnpm runs scripts from the package directory; paths on the command line are meant relative to
  // where the command was typed, which pnpm records in INIT_CWD.
  const invokedFrom = process.env['INIT_CWD'] ?? process.cwd();
  const scenarioPath = values.scenario
    ? resolve(invokedFrom, values.scenario)
    : resolve(import.meta.dirname, 'scenarios', 'example.json');
  let scenario;
  try {
    scenario = parseScenario(JSON.parse(await readFile(scenarioPath, 'utf8')));
  } catch (error) {
    throw new SetupError(`Could not load ${scenarioPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let session: McpSession;
  let sessionsOpened = 1;
  try {
    session = await McpSession.connect({ url: mcpUrl, token, deviceId });
  } catch (error) {
    throw new SetupError(`Could not connect to the MCP server at ${mcpUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const server = session.serverInfo;
    const visible = session.tools.filter(isModelVisible).map((tool) => tool.name);
    const hidden = session.tools.filter((tool) => !isModelVisible(tool)).map((tool) => tool.name);
    console.log(`Scenario  ${scenario.name} (${scenario.turns.length} turns)`);
    console.log(`MCP       ${mcpUrl} (${server ? `${server.name} ${server.version}` : 'unidentified server'}, protocol ${session.protocolVersion ?? 'unknown'})`);
    console.log(`Tools     ${visible.join(', ') || 'none'}${hidden.length > 0 ? `; hidden from the model: ${hidden.join(', ')}` : ''}`);
    console.log(`Model     ${modelId} in ${region}`);
    console.log(`Device    ${deviceId}`);

    const client = new BedrockRuntimeClient({ region });
    const report = await runScenario({
      scenario,
      tools: session.tools,
      converse: createDirectConverse(client, () => ({
        modelId,
        // Built per call, like the backend does, so a run across midnight still knows the date.
        system: buildSystemPrompt({ cityName: config.cityName, timeZone: config.timeZone }),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      })),
      callTool: (name, args, options) => session.callTool(name, args, { origin: 'assistant', signal: options?.signal }),
      structuredFormat,
      ...(maxToolRounds === undefined ? {} : { maxToolRounds }),
      // "The next day": a brand new MCP connection (initialize, tools/list) from the same device.
      onNewSession: async () => {
        await session.close().catch(() => undefined);
        session = await McpSession.connect({ url: mcpUrl, token, deviceId });
        sessionsOpened++;
        return session.tools;
      },
      onTurn: (turn) => console.log(describe(turn)),
    });

    const { summary } = report;
    console.log(
      `\n${report.pass ? 'PASS' : 'FAIL'}  ${summary.turns_passed}/${scenario.turns.length} turns, ` +
        `${summary.expectations_passed}/${summary.expectations} expectations, ${summary.tool_calls} tool calls, ` +
        `${summary.converse_calls} model calls, ${summary.usage.totalTokens} tokens, ${report.duration_ms} ms`,
    );

    if (values.out) {
      const outPath = resolve(invokedFrom, values.out);
      const record = {
        ...report,
        run: {
          scenario_file: scenarioPath,
          mcp_url: mcpUrl,
          mcp_server: server ?? null,
          mcp_protocol_version: session.protocolVersion ?? null,
          model_tools: visible,
          hidden_tools: hidden,
          device_id: deviceId,
          mcp_sessions_opened: sessionsOpened,
          model_id: modelId,
          region,
          max_tokens: config.maxTokens,
          city: config.cityName,
          structured_format: structuredFormat,
        },
      };
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`);
      console.log(`Record saved to ${outPath}`);
    } else {
      console.log('No record saved (pass --out <file> to keep one).');
    }
    return report.pass ? 0 : 1;
  } finally {
    await session.close().catch(() => undefined);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof SetupError ? error.message : error);
    process.exitCode = 2;
  },
);
