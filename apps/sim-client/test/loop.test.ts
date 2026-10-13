import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_REPLY,
  runAssistantTurn,
  toToolResultBlock,
  trimHistory,
  type LoopEvent,
} from '../src/assistant/loop.ts';
import {
  isToolResultBlock,
  isToolUseBlock,
  type CallToolFn,
  type ContentBlock,
  type ConverseFn,
  type ConverseRequest,
  type ConverseResponse,
  type McpToolLike,
  type Message,
} from '../src/assistant/types.ts';

const TOOLS: McpToolLike[] = [
  {
    name: 'report_issue',
    description: 'Report a city issue.',
    inputSchema: { type: 'object', properties: { issue_type: { type: 'string' } }, required: ['issue_type'] },
    _meta: { ui: { resourceUri: 'ui://citydesk/issue-card.html' } },
  },
  { name: 'follow_request', description: 'Follow a request.', inputSchema: { type: 'object', properties: {} } },
  {
    name: 'static_map',
    description: 'Map image for cards.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { visibility: ['app'] } },
  },
];

const text = (value: string, stopReason = 'end_turn'): ConverseResponse => ({
  message: { role: 'assistant', content: [{ text: value }] },
  stopReason,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  latencyMs: 100,
});

const toolUse = (
  calls: Array<{ id: string; name: string; input?: Record<string, unknown> }>,
  stopReason = 'tool_use',
  preamble?: string,
): ConverseResponse => ({
  message: {
    role: 'assistant',
    content: [
      ...(preamble ? [{ text: preamble }] : []),
      ...calls.map(({ id, name, input }) => ({ toolUse: { toolUseId: id, name, input: input ?? {} } })),
    ],
  },
  stopReason,
  usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  latencyMs: 200,
});

/** A `converse` that plays back a script and keeps a deep copy of each request it was given. */
function scripted(responses: Array<ConverseResponse | Error>): { converse: ConverseFn; requests: ConverseRequest[] } {
  const requests: ConverseRequest[] = [];
  let index = 0;
  const converse: ConverseFn = async (request) => {
    requests.push(structuredClone(request));
    const next = responses[index];
    index += 1;
    if (next === undefined) throw new Error('converse called more often than scripted');
    if (next instanceof Error) throw next;
    return next;
  };
  return { converse, requests };
}

const duplicate = {
  content: [{ type: 'text', text: 'A pothole was already reported there on Sunday.' }],
  structuredContent: {
    outcome: 'possible_duplicate',
    spoken_summary: 'A pothole was already reported there on Sunday.',
    requests: [{ request_id: 'boston/101005123456' }],
  },
};

/** Every tool use in the history must be answered by a tool result in the very next message. */
function expectValidHistory(messages: Message[]): void {
  expect(messages[0]?.role).toBe('user');
  messages.forEach((message, index) => {
    if (index > 0) expect(message.role).not.toBe(messages[index - 1]?.role);
    const uses = message.content.filter(isToolUseBlock).map((block) => block.toolUse.toolUseId);
    if (uses.length === 0) return;
    const answers = (messages[index + 1]?.content ?? [])
      .filter(isToolResultBlock)
      .map((block) => block.toolResult.toolUseId);
    expect(answers).toEqual(uses);
  });
}

describe('runAssistantTurn', () => {
  it('answers directly when the model calls no tool', async () => {
    const { converse, requests } = scripted([text('I can help with city services in Boston.')]);
    const callTool = vi.fn<CallToolFn>();

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: '  Hello  ' });

    expect(result.reply).toBe('I can help with city services in Boston.');
    expect(result.ending).toBe('reply');
    expect(result.converseCalls).toBe(1);
    expect(result.toolRounds).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
    expect(requests[0]?.messages).toEqual([{ role: 'user', content: [{ text: 'Hello' }] }]);
    expect(result.messages).toEqual([
      { role: 'user', content: [{ text: 'Hello' }] },
      { role: 'assistant', content: [{ text: 'I can help with city services in Boston.' }] },
    ]);
  });

  it('runs a single tool call and feeds back the text plus the structured content as JSON', async () => {
    const { converse, requests } = scripted([
      toolUse([{ id: 't1', name: 'report_issue', input: { issue_type: 'pothole' } }]),
      text('A report already exists for that pothole. Would you like to follow it instead?'),
    ]);
    const callTool = vi.fn<CallToolFn>().mockResolvedValue(duplicate);
    const events: LoopEvent[] = [];

    const result = await runAssistantTurn({
      converse,
      callTool,
      tools: TOOLS,
      history: [],
      userText: 'There is a pothole on Boylston Street',
      onEvent: (event) => events.push(event),
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]?.slice(0, 2)).toEqual(['report_issue', { issue_type: 'pothole' }]);
    expect(result.reply).toBe('A report already exists for that pothole. Would you like to follow it instead?');
    expect(result.toolCalls).toMatchObject([
      { name: 'report_issue', round: 1, isError: false, outcome: 'possible_duplicate', toolUseId: 't1' },
    ]);
    expect(result.toolRounds).toBe(1);
    expect(result.converseCalls).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 13, totalTokens: 43 });
    expect(result.converseLatencyMs).toBe(300);

    // The second Converse call carries the tool result: text first, then the structured content.
    const followUp = requests[1]?.messages.at(-1);
    expect(followUp).toEqual({
      role: 'user',
      content: [
        {
          toolResult: {
            toolUseId: 't1',
            content: [{ text: 'A pothole was already reported there on Sunday.' }, { json: duplicate.structuredContent }],
          },
        },
      ],
    });
    expectValidHistory(result.messages);
    expect(events.map((event) => event.type)).toEqual([
      'converse-start',
      'converse-end',
      'tool-start',
      'tool-end',
      'converse-start',
      'converse-end',
    ]);
  });

  it('chains tool calls across rounds and runs several calls in one round in order', async () => {
    const { converse, requests } = scripted([
      toolUse([{ id: 'a', name: 'report_issue', input: { issue_type: 'pothole' } }]),
      toolUse([
        { id: 'b', name: 'follow_request', input: { request_id: 'boston/101005123456' } },
        { id: 'c', name: 'report_issue', input: { issue_type: 'streetlight' } },
      ]),
      text('You are now following the pothole report.'),
    ]);
    const order: string[] = [];
    const callTool: CallToolFn = async (name, args) => {
      order.push(`${name}:${JSON.stringify(args)}`);
      return { content: [{ type: 'text', text: `${name} done` }], structuredContent: { outcome: 'followed' } };
    };

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Follow it' });

    expect(order).toEqual([
      'report_issue:{"issue_type":"pothole"}',
      'follow_request:{"request_id":"boston/101005123456"}',
      'report_issue:{"issue_type":"streetlight"}',
    ]);
    expect(result.toolCalls.map((call) => [call.name, call.round])).toEqual([
      ['report_issue', 1],
      ['follow_request', 2],
      ['report_issue', 2],
    ]);
    expect(result.toolRounds).toBe(2);
    expect(result.converseCalls).toBe(3);
    // Both results of round two go back in one user message, in the order the model asked.
    const lastRequest = requests[2]?.messages.at(-1);
    expect(lastRequest?.content.filter(isToolResultBlock).map((block) => block.toolResult.toolUseId)).toEqual(['b', 'c']);
    expectValidHistory(result.messages);
  });

  it('stops at the round cap and falls back to the last tool summary', async () => {
    const forever = toolUse([{ id: 'x', name: 'report_issue', input: { issue_type: 'pothole' } }]);
    const { converse, requests } = scripted([forever, forever, forever, forever]);
    const callTool = vi.fn<CallToolFn>().mockResolvedValue(duplicate);

    const result = await runAssistantTurn({
      converse,
      callTool,
      tools: TOOLS,
      history: [],
      userText: 'Report a pothole',
      maxToolRounds: 2,
    });

    expect(result.ending).toBe('round_cap');
    expect(callTool).toHaveBeenCalledTimes(2);
    // Two tool rounds, plus the one call that was supposed to produce the reply. No fourth call.
    expect(requests).toHaveLength(3);
    expect(result.toolRounds).toBe(2);
    expect(result.reply).toBe('A pothole was already reported there on Sunday.');
    // The model's third, unanswered tool request is not left dangling in the history.
    expectValidHistory(result.messages);
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ text: 'A pothole was already reported there on Sunday.' }],
    });
  });

  it('says a fixed fallback when the cap is hit and no tool offered a summary', async () => {
    const forever = toolUse([{ id: 'x', name: 'follow_request' }]);
    const { converse } = scripted([forever, forever]);
    const callTool: CallToolFn = async () => ({ content: [] });

    const result = await runAssistantTurn({
      converse,
      callTool,
      tools: TOOLS,
      history: [],
      userText: 'Follow it',
      maxToolRounds: 1,
    });

    expect(result.ending).toBe('round_cap');
    expect(result.reply).toBe(FALLBACK_REPLY);
  });

  it('with a cap of zero never executes a tool', async () => {
    const { converse } = scripted([toolUse([{ id: 'x', name: 'report_issue' }])]);
    const callTool = vi.fn<CallToolFn>();

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Hi', maxToolRounds: 0 });

    expect(callTool).not.toHaveBeenCalled();
    expect(result.ending).toBe('round_cap');
  });

  it('reports a tool error result to the model with status "error"', async () => {
    const { converse, requests } = scripted([
      toolUse([{ id: 'e1', name: 'report_issue', input: { issue_type: 'pothole' } }]),
      text('I could not reach the city just now. Please try again in a minute.'),
    ]);
    const failure = {
      isError: true,
      content: [{ type: 'text', text: 'The city service is not answering.' }],
      structuredContent: { outcome: 'error', spoken_summary: 'The city service is not answering.', error: { code: 'upstream_unavailable' } },
    };
    const callTool: CallToolFn = async () => failure;

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Report a pothole' });

    const block = requests[1]?.messages.at(-1)?.content[0] as Extract<ContentBlock, { toolResult: unknown }>;
    expect(block.toolResult.status).toBe('error');
    expect(block.toolResult.content[0]).toEqual({ text: 'The city service is not answering.' });
    expect(result.toolCalls[0]).toMatchObject({ isError: true, outcome: 'error' });
    expect(result.reply).toBe('I could not reach the city just now. Please try again in a minute.');
    expect(result.ending).toBe('reply');
  });

  it('turns a thrown tool call into an error result and lets the model respond', async () => {
    const { converse, requests } = scripted([
      toolUse([{ id: 'e2', name: 'report_issue' }]),
      text('Something went wrong while filing that.'),
    ]);
    const callTool: CallToolFn = async () => {
      throw new Error('Request timed out');
    };

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Report a pothole' });

    expect(requests[1]?.messages.at(-1)?.content[0]).toEqual({
      toolResult: { toolUseId: 'e2', content: [{ text: 'The tool call failed: Request timed out' }], status: 'error' },
    });
    expect(result.toolCalls[0]).toMatchObject({ isError: true, error: 'Request timed out' });
    expect(result.reply).toBe('Something went wrong while filing that.');
    expectValidHistory(result.messages);
  });

  it('never calls an app-only tool or an unknown tool, even when the model names one', async () => {
    const { converse, requests } = scripted([
      toolUse([
        { id: 'h1', name: 'static_map', input: { lat: 1, long: 2 } },
        { id: 'h2', name: 'drop_database' },
      ]),
      text('I cannot do that.'),
    ]);
    const callTool = vi.fn<CallToolFn>();

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Show me a map' });

    expect(callTool).not.toHaveBeenCalled();
    expect(requests[0]?.toolConfig?.tools.map((tool) => tool.toolSpec.name)).toEqual(['report_issue', 'follow_request']);
    const results = requests[1]?.messages.at(-1)?.content.filter(isToolResultBlock) ?? [];
    expect(results.map((block) => block.toolResult.status)).toEqual(['error', 'error']);
    expect(result.toolCalls.map((call) => call.error)).toEqual(['not available to the assistant', 'not available to the assistant']);
  });

  it('does not execute a tool call that was cut off by max_tokens', async () => {
    const { converse } = scripted([
      toolUse([{ id: 'm1', name: 'report_issue', input: { issue_type: 'pot' } }], 'max_tokens', 'Let me file that.'),
    ]);
    const callTool = vi.fn<CallToolFn>();

    const result = await runAssistantTurn({ converse, callTool, tools: TOOLS, history: [], userText: 'Report a pothole' });

    expect(callTool).not.toHaveBeenCalled();
    expect(result.ending).toBe('no_text');
    expect(result.reply).toBe(FALLBACK_REPLY);
    expectValidHistory(result.messages);
  });

  it('keeps only finished sentences when the reply ran out of tokens', async () => {
    const { converse } = scripted([text('Trash goes out on Monday. Recycling goes out every other', 'max_tokens')]);

    const result = await runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: 'Trash?' });

    expect(result.reply).toBe('Trash goes out on Monday.');
  });

  it('applies the two-sentence guard and stores what was actually said', async () => {
    const { converse } = scripted([text('One. Two. Three. Four.')]);

    const result = await runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: 'Go' });

    expect(result.reply).toBe('One. Two.');
    expect(result.rawReply).toBe('One. Two. Three. Four.');
    expect(result.guard).toMatchObject({ sentenceCount: 4, truncated: true });
    expect(result.messages.at(-1)).toEqual({ role: 'assistant', content: [{ text: 'One. Two.' }] });
  });

  it('falls back to the tool summary when the model returns no text after a tool', async () => {
    const empty: ConverseResponse = { message: { role: 'assistant', content: [] }, stopReason: 'end_turn' };
    const { converse } = scripted([toolUse([{ id: 'n1', name: 'report_issue' }]), empty]);

    const result = await runAssistantTurn({ converse, callTool: async () => duplicate, tools: TOOLS, history: [], userText: 'Go' });

    expect(result.ending).toBe('no_text');
    expect(result.reply).toBe('A pothole was already reported there on Sunday.');
  });

  it('speaks the tool summary when Converse fails after a tool already ran', async () => {
    const { converse } = scripted([toolUse([{ id: 'f1', name: 'report_issue' }]), new Error('ThrottlingException')]);

    const result = await runAssistantTurn({ converse, callTool: async () => duplicate, tools: TOOLS, history: [], userText: 'Go' });

    expect(result.ending).toBe('converse_failed');
    expect(result.error).toBe('ThrottlingException');
    expect(result.reply).toBe('A pothole was already reported there on Sunday.');
    expectValidHistory(result.messages);
  });

  it('throws when Converse fails before anything could be said', async () => {
    const { converse } = scripted([new Error('AccessDeniedException')]);

    await expect(
      runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: 'Go' }),
    ).rejects.toThrow('AccessDeniedException');
  });

  it('carries history into the next turn', async () => {
    const first = scripted([text('Which street is it on?')]);
    const one = await runAssistantTurn({ converse: first.converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: 'Pothole' });
    const second = scripted([text('Thanks.')]);
    await runAssistantTurn({ converse: second.converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: one.messages, userText: 'Boylston' });

    expect(second.requests[0]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('stops when aborted and rejects an empty turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const { converse, requests } = scripted([text('never')]);

    await expect(
      runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: 'Go', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(0);
    await expect(
      runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: TOOLS, history: [], userText: '   ' }),
    ).rejects.toThrow('empty');
  });

  it('omits toolConfig when no tool is visible to the model', async () => {
    const { converse, requests } = scripted([text('Hello.')]);
    await runAssistantTurn({ converse, callTool: vi.fn<CallToolFn>(), tools: [TOOLS[2]!], history: [], userText: 'Hi' });
    expect(requests[0]).not.toHaveProperty('toolConfig');
  });
});

describe('toToolResultBlock', () => {
  it('can feed structured content back as text for models without JSON tool results', () => {
    const block = toToolResultBlock('id', duplicate, 'text');
    expect(block.toolResult.content).toEqual([
      { text: 'A pothole was already reported there on Sunday.' },
      { text: JSON.stringify(duplicate.structuredContent) },
    ]);
  });

  it('names binary content instead of forwarding it, and wraps non-object structured content', () => {
    const block = toToolResultBlock('id', {
      content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'resource_link', uri: 'x://y' }],
      structuredContent: [1, 2],
    });
    expect(block.toolResult.content).toEqual([{ text: '[image omitted]\n[resource link omitted]' }, { json: { value: [1, 2] } }]);
  });

  it('never produces an empty content list', () => {
    expect(toToolResultBlock('id', {}).toolResult.content).toEqual([{ text: 'Done.' }]);
    expect(toToolResultBlock('id', { isError: true }).toolResult).toEqual({
      toolUseId: 'id',
      content: [{ text: 'The tool failed without giving a reason.' }],
      status: 'error',
    });
  });

  it('leaves out structured content that is too large to send', () => {
    const block = toToolResultBlock('id', { structuredContent: { blob: 'x'.repeat(30_000) } });
    expect(block.toolResult.content).toEqual([{ text: '[structured content omitted: too large]' }]);
  });
});

describe('trimHistory', () => {
  const user = (value: string): Message => ({ role: 'user', content: [{ text: value }] });
  const assistant = (value: string): Message => ({ role: 'assistant', content: [{ text: value }] });
  const use: Message = { role: 'assistant', content: [{ toolUse: { toolUseId: 'u', name: 'report_issue', input: {} } }] };
  const answer: Message = { role: 'user', content: [{ toolResult: { toolUseId: 'u', content: [{ text: 'ok' }] } }] };

  it('returns short histories untouched', () => {
    const history = [user('a'), assistant('b')];
    expect(trimHistory(history, 10)).toEqual(history);
  });

  it('drops whole turns from the front and never splits a tool use from its result', () => {
    const history = [user('one'), assistant('1'), user('two'), use, answer, assistant('2'), user('three'), assistant('3')];
    const trimmed = trimHistory(history, 5);
    // Keeping five would start at the tool use; the cut moves forward to the next real user turn.
    expect(trimmed).toEqual([user('three'), assistant('3')]);
    expect(trimHistory(history, 6)).toEqual(history.slice(2));
  });

  it('keeps the last turn even when it alone is over the limit', () => {
    const history = [user('one'), assistant('1'), user('two'), use, answer, assistant('2')];
    expect(trimHistory(history, 2)).toEqual(history.slice(2));
  });
});
