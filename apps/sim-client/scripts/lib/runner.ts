/**
 * Drives a scenario through the same conversation loop the browser uses and builds the record
 * that gets saved. Everything external (Converse, the MCP tools, the clock) is passed in, so this
 * file runs unchanged in tests with fakes and in `scripts/conversation.ts` with the real thing.
 */

import { runAssistantTurn, type StructuredFormat, type ToolCallRecord, type TurnEnding } from '../../src/assistant/loop.ts';
import type { CallToolFn, ConverseFn, McpToolLike, Message, TokenUsage } from '../../src/assistant/types.ts';
import { evaluateTurn, type ExpectationResult, type Scenario } from './scenario.ts';

export interface ToolCallReport {
  name: string;
  arguments: Record<string, unknown>;
  round: number;
  outcome: string | null;
  is_error: boolean;
  error: string | null;
  duration_ms: number;
}

export interface TurnReport {
  index: number;
  user: string;
  /** What the resident would hear: the guarded reply. `null` when the turn failed. */
  reply: string | null;
  /** The model's text before the two-sentence guard. */
  raw_reply: string | null;
  ending: TurnEnding | 'failed' | 'skipped';
  /** Sentences the model wrote before the guard, and whether the guard had to cut or clean. */
  model_sentence_count: number | null;
  guard_truncated: boolean | null;
  guard_removed_ids: boolean | null;
  tool_calls: ToolCallReport[];
  tool_rounds: number;
  converse_calls: number;
  stop_reason: string | null;
  usage: TokenUsage | null;
  timings_ms: { total: number; converse: number; tools: number };
  expectations: ExpectationResult[];
  pass: boolean;
  error: string | null;
}

export interface ScenarioReport {
  scenario: { name: string; description: string | null; turns: number };
  started_at: string;
  finished_at: string;
  duration_ms: number;
  turns: TurnReport[];
  summary: {
    turns_passed: number;
    turns_failed: number;
    turns_skipped: number;
    expectations: number;
    expectations_passed: number;
    tool_calls: number;
    converse_calls: number;
    usage: TokenUsage;
  };
  pass: boolean;
}

export interface RunScenarioOptions {
  scenario: Scenario;
  converse: ConverseFn;
  callTool: CallToolFn;
  tools: readonly McpToolLike[];
  maxToolRounds?: number;
  structuredFormat?: StructuredFormat;
  now?: () => number;
  /** Called as each turn finishes, so the CLI can print the transcript as it happens. */
  onTurn?: (turn: TurnReport) => void;
}

function toToolCallReport(call: ToolCallRecord): ToolCallReport {
  return {
    name: call.name,
    arguments: call.arguments,
    round: call.round,
    outcome: call.outcome ?? null,
    is_error: call.isError,
    error: call.error ?? null,
    duration_ms: call.durationMs,
  };
}

function emptyTurn(index: number, user: string, ending: 'failed' | 'skipped', error: string | null): TurnReport {
  return {
    index,
    user,
    reply: null,
    raw_reply: null,
    ending,
    model_sentence_count: null,
    guard_truncated: null,
    guard_removed_ids: null,
    tool_calls: [],
    tool_rounds: 0,
    converse_calls: 0,
    stop_reason: null,
    usage: null,
    timings_ms: { total: 0, converse: 0, tools: 0 },
    expectations: [],
    pass: false,
    error,
  };
}

export async function runScenario(options: RunScenarioOptions): Promise<ScenarioReport> {
  const { scenario, converse, callTool, tools, onTurn } = options;
  const now = options.now ?? Date.now;
  const started = now();
  const turns: TurnReport[] = [];
  let history: Message[] = [];
  let broken = false;

  for (const [position, turn] of scenario.turns.entries()) {
    const index = position + 1;
    if (broken) {
      // A failed turn leaves the conversation in an unknown state; later turns would test nothing.
      const skipped = emptyTurn(index, turn.user, 'skipped', 'An earlier turn failed.');
      turns.push(skipped);
      onTurn?.(skipped);
      continue;
    }

    const turnStarted = now();
    let report: TurnReport;
    try {
      const result = await runAssistantTurn({
        converse,
        callTool,
        tools,
        history,
        userText: turn.user,
        ...(options.maxToolRounds === undefined ? {} : { maxToolRounds: options.maxToolRounds }),
        ...(options.structuredFormat === undefined ? {} : { structuredFormat: options.structuredFormat }),
      });
      history = result.messages;
      const expectations = evaluateTurn(turn.expect, result);
      report = {
        index,
        user: turn.user,
        reply: result.reply,
        raw_reply: result.rawReply,
        ending: result.ending,
        model_sentence_count: result.guard.sentenceCount,
        guard_truncated: result.guard.truncated,
        guard_removed_ids: result.guard.idsRemoved,
        tool_calls: result.toolCalls.map(toToolCallReport),
        tool_rounds: result.toolRounds,
        converse_calls: result.converseCalls,
        stop_reason: result.stopReason,
        usage: result.usage,
        timings_ms: {
          total: now() - turnStarted,
          converse: result.converseLatencyMs,
          tools: result.toolCalls.reduce((sum, call) => sum + call.durationMs, 0),
        },
        expectations,
        // A turn that ended on the round cap, a lost Converse call or an empty reply is not a pass,
        // whatever its expectations say: the resident heard a fallback, not the model's answer.
        pass: expectations.every((item) => item.pass) && result.ending === 'reply',
        error: result.error ?? null,
      };
    } catch (error) {
      broken = true;
      report = emptyTurn(index, turn.user, 'failed', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      report.timings_ms.total = now() - turnStarted;
    }
    turns.push(report);
    onTurn?.(report);
  }

  const finished = now();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const turn of turns) {
    usage.inputTokens += turn.usage?.inputTokens ?? 0;
    usage.outputTokens += turn.usage?.outputTokens ?? 0;
    usage.totalTokens += turn.usage?.totalTokens ?? 0;
  }
  const expectations = turns.flatMap((turn) => turn.expectations);
  const skipped = turns.filter((turn) => turn.ending === 'skipped').length;
  const passed = turns.filter((turn) => turn.pass).length;

  return {
    scenario: { name: scenario.name, description: scenario.description ?? null, turns: scenario.turns.length },
    started_at: new Date(started).toISOString(),
    finished_at: new Date(finished).toISOString(),
    duration_ms: finished - started,
    turns,
    summary: {
      turns_passed: passed,
      turns_failed: turns.length - passed - skipped,
      turns_skipped: skipped,
      expectations: expectations.length,
      expectations_passed: expectations.filter((item) => item.pass).length,
      tool_calls: turns.reduce((sum, turn) => sum + turn.tool_calls.length, 0),
      converse_calls: turns.reduce((sum, turn) => sum + turn.converse_calls, 0),
      usage,
    },
    pass: turns.every((turn) => turn.pass),
  };
}
