import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScenario, type TurnReport } from '../scripts/lib/runner.ts';
import { evaluateTurn, parseScenario } from '../scripts/lib/scenario.ts';
import type { CallToolFn, ConverseFn, ConverseResponse, McpToolLike } from '../src/assistant/types.ts';

const TOOLS: McpToolLike[] = [
  { name: 'report_issue', description: 'Report.', inputSchema: { type: 'object', properties: {} } },
  { name: 'follow_request', description: 'Follow.', inputSchema: { type: 'object', properties: {} } },
];

const say = (text: string): ConverseResponse => ({
  message: { role: 'assistant', content: [{ text }] },
  stopReason: 'end_turn',
  usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
  latencyMs: 300,
});

const use = (name: string, input: Record<string, unknown> = {}): ConverseResponse => ({
  message: { role: 'assistant', content: [{ toolUse: { toolUseId: `id-${name}`, name, input } }] },
  stopReason: 'tool_use',
  usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
  latencyMs: 250,
});

function playback(responses: Array<ConverseResponse | Error>): ConverseFn {
  let index = 0;
  return async () => {
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error('unexpected Converse call');
    if (next instanceof Error) throw next;
    return next;
  };
}

const callTool: CallToolFn = async (name) => ({
  content: [{ type: 'text', text: `${name} ok` }],
  structuredContent: {
    outcome: name === 'report_issue' ? 'possible_duplicate' : 'followed',
    spoken_summary: `${name} ok`,
  },
});

describe('scenario files', () => {
  it('accepts the placeholder scenario that ships with the runner', async () => {
    const file = resolve(import.meta.dirname, '..', 'scripts', 'scenarios', 'example.json');
    const scenario = parseScenario(JSON.parse(await readFile(file, 'utf8')));
    expect(scenario.turns.length).toBeGreaterThan(0);
    expect(scenario.turns[0]?.expect).toMatchObject({ tool: 'report_issue', outcome: 'possible_duplicate' });
  });

  it('rejects unknown fields and empty scenarios with a pointer to the problem', () => {
    expect(() => parseScenario({ name: 'x', turns: [] })).toThrow('turns');
    expect(() => parseScenario({ name: 'x', turns: [{ user: 'hi', expect: { tools: ['a'] } }] })).toThrow('turns.0.expect');
    expect(() => parseScenario({ turns: [{ user: 'hi' }] })).toThrow('name');
  });
});

describe('evaluateTurn', () => {
  const turn = {
    reply: 'A report already exists. Want to follow it?',
    toolCalls: [
      { name: 'find_nearby_reports', outcome: 'nearby' },
      { name: 'report_issue', outcome: 'possible_duplicate' },
    ],
  };

  it('passes when the expected tool was called and returned the expected outcome', () => {
    expect(evaluateTurn({ tool: 'report_issue', outcome: 'possible_duplicate' }, turn).map((item) => item.pass)).toEqual([true, true]);
  });

  it('ties the outcome to the expected tool', () => {
    const results = evaluateTurn({ tool: 'report_issue', outcome: 'nearby' }, turn);
    expect(results).toMatchObject([
      { check: 'tool', pass: true },
      { check: 'outcome', expected: 'nearby', actual: 'possible_duplicate', pass: false },
    ]);
    // Without an expected tool, any call in the turn may supply the outcome.
    expect(evaluateTurn({ outcome: 'nearby' }, turn)[0]?.pass).toBe(true);
  });

  it('checks several tools, no_tools and reply text', () => {
    expect(evaluateTurn({ tool: ['report_issue', 'follow_request'] }, turn).map((item) => item.pass)).toEqual([true, false]);
    expect(evaluateTurn({ no_tools: true }, turn)[0]).toMatchObject({ pass: false, actual: 'find_nearby_reports, report_issue' });
    expect(evaluateTurn({ no_tools: true }, { reply: 'Hi.', toolCalls: [] })[0]?.pass).toBe(true);
    expect(
      evaluateTurn({ reply_includes: ['ALREADY EXISTS'], reply_excludes: ['uuid', 'follow'] }, turn).map((item) => item.pass),
    ).toEqual([true, true, false]);
    expect(evaluateTurn(undefined, turn)).toEqual([]);
  });
});

describe('runScenario', () => {
  const scenario = parseScenario({
    name: 'two turns',
    turns: [
      { user: 'There is a pothole on Boylston Street.', expect: { tool: 'report_issue', outcome: 'possible_duplicate' } },
      { user: 'Follow it.', expect: { tool: 'follow_request', outcome: 'followed', reply_includes: ['following'] } },
    ],
  });

  it('plays every turn through the loop and records tools, outcomes, timings and verdicts', async () => {
    let clock = Date.parse('2026-10-13T12:00:00Z');
    const seen: TurnReport[] = [];
    const report = await runScenario({
      scenario,
      tools: TOOLS,
      callTool,
      converse: playback([
        use('report_issue', { issue_type: 'pothole' }),
        say('A report already exists there. Would you like to follow it?'),
        use('follow_request', { request_id: 'boston/1' }),
        say('You are now following that pothole report.'),
      ]),
      now: () => (clock += 100),
      onTurn: (turn) => seen.push(turn),
    });

    expect(report.pass).toBe(true);
    expect(report.scenario).toEqual({ name: 'two turns', description: null, turns: 2 });
    expect(report.started_at).toBe('2026-10-13T12:00:00.100Z');
    expect(report.summary).toMatchObject({
      turns_passed: 2,
      turns_failed: 0,
      turns_skipped: 0,
      expectations: 5,
      expectations_passed: 5,
      tool_calls: 2,
      converse_calls: 4,
      usage: { inputTokens: 180, outputTokens: 44, totalTokens: 224 },
    });
    expect(report.turns[0]).toMatchObject({
      index: 1,
      user: 'There is a pothole on Boylston Street.',
      reply: 'A report already exists there. Would you like to follow it?',
      ending: 'reply',
      model_sentence_count: 2,
      guard_truncated: false,
      tool_calls: [{ name: 'report_issue', arguments: { issue_type: 'pothole' }, outcome: 'possible_duplicate', is_error: false, round: 1 }],
      converse_calls: 2,
      tool_rounds: 1,
      timings_ms: { converse: 550 },
      pass: true,
    });
    expect(report.turns[0]?.timings_ms.total).toBeGreaterThan(0);
    expect(seen.map((turn) => turn.index)).toEqual([1, 2]);
    // The record must survive JSON serialization unchanged: that is what gets saved.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it('fails a turn whose expectation is not met and keeps going', async () => {
    const report = await runScenario({
      scenario,
      tools: TOOLS,
      callTool,
      converse: playback([
        say('Where is the pothole?'),
        use('follow_request'),
        say('You are now following that pothole report.'),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.turns.map((turn) => turn.pass)).toEqual([false, true]);
    expect(report.turns[0]?.expectations).toMatchObject([
      { check: 'tool', expected: 'report_issue', actual: 'none', pass: false },
      { check: 'outcome', expected: 'possible_duplicate', actual: 'none', pass: false },
    ]);
    expect(report.summary).toMatchObject({ turns_passed: 1, turns_failed: 1, expectations: 5, expectations_passed: 3 });
  });

  it('records a failed model call and skips the turns after it', async () => {
    const failure = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' });
    const report = await runScenario({ scenario, tools: TOOLS, callTool, converse: playback([failure]) });

    expect(report.pass).toBe(false);
    expect(report.turns[0]).toMatchObject({
      ending: 'failed',
      reply: null,
      pass: false,
      error: 'CredentialsProviderError: Could not load credentials from any providers',
    });
    expect(report.turns[1]).toMatchObject({ ending: 'skipped', pass: false });
    expect(report.summary).toMatchObject({ turns_passed: 0, turns_failed: 1, turns_skipped: 1 });
  });

  it('does not pass a turn that only ended on the tool round cap', async () => {
    const report = await runScenario({
      scenario: parseScenario({ name: 'cap', turns: [{ user: 'Report a pothole.', expect: { tool: 'report_issue' } }] }),
      tools: TOOLS,
      callTool,
      maxToolRounds: 1,
      converse: playback([use('report_issue'), use('report_issue')]),
    });

    expect(report.turns[0]).toMatchObject({ ending: 'round_cap', pass: false, reply: 'report_issue ok' });
    expect(report.turns[0]?.expectations[0]?.pass).toBe(true);
  });
});

describe('sessions and waits', () => {
  it('starts a new conversation on request: history is cleared and the new connection is used', async () => {
    const scenario = parseScenario({
      name: 'next day',
      turns: [
        { user: 'There is a pothole.' },
        { user: 'What is happening with my requests?', new_session: true, wait_seconds: 130 },
      ],
    });
    const historySizes: number[] = [];
    const toolNames: string[][] = [];
    const converse: ConverseFn = async (request) => {
      historySizes.push(request.messages.length);
      toolNames.push((request.toolConfig?.tools ?? []).map((tool) => tool.toolSpec.name));
      return say('Okay.');
    };
    const slept: number[] = [];
    let reconnects = 0;
    const report = await runScenario({
      scenario,
      tools: TOOLS,
      callTool,
      converse,
      sleep: async (ms) => {
        slept.push(ms);
      },
      onNewSession: async () => {
        reconnects++;
        return [{ name: 'my_requests', description: 'List.', inputSchema: { type: 'object', properties: {} } }];
      },
    });
    expect(report.pass).toBe(true);
    // The second turn starts from scratch: one user message, not the first turn's exchange plus one.
    expect(historySizes).toEqual([1, 1]);
    expect(reconnects).toBe(1);
    expect(slept).toEqual([130_000]);
    expect(toolNames[1]).toEqual(['my_requests']);
    expect(report.turns.map((t) => [t.new_session, t.waited_seconds])).toEqual([
      [false, 0],
      [true, 130],
    ]);
  });

  it('keeps history across ordinary turns', async () => {
    const scenario = parseScenario({ name: 'two turns', turns: [{ user: 'One.' }, { user: 'Two.' }] });
    const historySizes: number[] = [];
    const converse: ConverseFn = async (request) => {
      historySizes.push(request.messages.length);
      return say('Okay.');
    };
    await runScenario({ scenario, tools: TOOLS, callTool, converse });
    expect(historySizes).toEqual([1, 3]);
  });

  it('rejects a wait longer than fifteen minutes', () => {
    expect(() => parseScenario({ name: 'x', turns: [{ user: 'hi', wait_seconds: 5000 }] })).toThrow('wait_seconds');
  });
});
