/**
 * Scenario files for the scripted conversation runner, and the checks a turn is held to.
 * The format is documented in the README ("Scripted conversations").
 */

import { z } from 'zod';
import type { ToolCallRecord } from '../../src/assistant/loop.ts';

const oneOrMany = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const expectSchema = z.strictObject({
  /** Tool or tools that must be called during the turn. */
  tool: oneOrMany.optional(),
  /** Outcome (`structuredContent.outcome`) that one of the turn's tool calls must return. */
  outcome: z.string().min(1).optional(),
  /** The turn must be answered without calling any tool. */
  no_tools: z.literal(true).optional(),
  /** Text the reply must contain, ignoring case. */
  reply_includes: z.array(z.string().min(1)).optional(),
  /** Text the reply must not contain, ignoring case. */
  reply_excludes: z.array(z.string().min(1)).optional(),
});

const scenarioSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  turns: z
    .array(
      z.strictObject({
        /** What the resident says. */
        user: z.string().trim().min(1),
        /** Free text for humans reading the file; the runner ignores it. */
        note: z.string().optional(),
        /**
         * Start this turn as a new conversation: the assistant's history is cleared and the MCP
         * client reconnects, as when the resident comes back another day. The device stays the same,
         * so anything the server remembers about the household is still there.
         */
        new_session: z.literal(true).optional(),
        /** Wait this long before the turn (for example, to let a sandbox request change status). */
        wait_seconds: z.number().min(0).max(900).optional(),
        expect: expectSchema.optional(),
      }),
    )
    .min(1),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type TurnExpectation = z.infer<typeof expectSchema>;

export function parseScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid scenario: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown problem'}`);
  }
  return parsed.data;
}

export interface ExpectationResult {
  check: 'tool' | 'outcome' | 'no_tools' | 'reply_includes' | 'reply_excludes';
  expected: string;
  /** What the turn actually did, for the report. */
  actual: string;
  pass: boolean;
}

const list = (values: readonly string[]): string => (values.length > 0 ? values.join(', ') : 'none');

/** Checks one finished turn against its expectations. No expectations means nothing to fail. */
export function evaluateTurn(
  expect: TurnExpectation | undefined,
  turn: { reply: string; toolCalls: readonly Pick<ToolCallRecord, 'name' | 'outcome'>[] },
): ExpectationResult[] {
  if (!expect) return [];
  const results: ExpectationResult[] = [];
  const called = turn.toolCalls.map((call) => call.name);
  const expectedTools = expect.tool === undefined ? [] : [expect.tool].flat();

  for (const tool of expectedTools) {
    results.push({ check: 'tool', expected: tool, actual: list(called), pass: called.includes(tool) });
  }

  if (expect.outcome !== undefined) {
    // With an expected tool, the outcome has to come from that tool, not from any call in the turn.
    const relevant = expectedTools.length > 0
      ? turn.toolCalls.filter((call) => expectedTools.includes(call.name))
      : turn.toolCalls;
    const outcomes = relevant.map((call) => call.outcome ?? 'no outcome');
    results.push({
      check: 'outcome',
      expected: expect.outcome,
      actual: list(outcomes),
      pass: outcomes.includes(expect.outcome),
    });
  }

  if (expect.no_tools) {
    results.push({ check: 'no_tools', expected: 'no tool calls', actual: list(called), pass: called.length === 0 });
  }

  const reply = turn.reply.toLowerCase();
  for (const text of expect.reply_includes ?? []) {
    results.push({ check: 'reply_includes', expected: text, actual: turn.reply, pass: reply.includes(text.toLowerCase()) });
  }
  for (const text of expect.reply_excludes ?? []) {
    results.push({ check: 'reply_excludes', expected: text, actual: turn.reply, pass: !reply.includes(text.toLowerCase()) });
  }
  return results;
}
