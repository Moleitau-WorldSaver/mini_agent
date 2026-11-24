import { describe, expect, it } from 'vitest';
import { DeepSeekAdapter, ModelError } from '../../src/model/deepseek.js';
import { fakeFetch } from '../fake-fetch.js';

const toolSchema = {
  name: 'weather',
  description: '查询天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

describe('DeepSeekAdapter', () => {
  it('maps the runtime request to the OpenAI-compatible shape and normalizes the response', async () => {
    const { impl, calls } = fakeFetch([
      {
        json: {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                reasoning_content: '需要查天气',
                tool_calls: [
                  {
                    id: 'call_0',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"上海"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 8 },
        },
      },
    ]);
    const adapter = new DeepSeekAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'deepseek-flash',
      fetchImpl: impl,
    });

    const response = await adapter.complete({
      system: '系统提示词',
      messages: [
        { role: 'user', content: '北京天气？', turnId: 'turn-1' },
        {
          role: 'assistant',
          content: null,
          reasoningContent: '先查北京',
          toolCalls: [{ id: 'call_0', name: 'weather', arguments: '{"city":"北京"}' }],
          turnId: 'turn-1',
          step: 1,
        },
        {
          role: 'tool',
          toolCallId: 'call_0',
          name: 'weather',
          content: '{"city":"北京","temperature":26}',
          isError: false,
          turnId: 'turn-1',
          step: 1,
        },
        { role: 'user', content: '那上海呢？', turnId: 'turn-2' },
      ],
      tools: [toolSchema],
      thinking: true,
      maxTokens: 8192,
    });

    expect(response).toEqual({
      content: null,
      reasoningContent: '需要查天气',
      toolCalls: [{ id: 'call_0', name: 'weather', arguments: '{"city":"上海"}' }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 120, completionTokens: 8 },
    });

    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.url).toBe('https://example.test/chat/completions');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });

    const body = request.body as Record<string, unknown>;
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe('low');
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'weather',
          description: '查询天气',
          parameters: toolSchema.parameters,
        },
      },
    ]);

    const messages = body.messages as Record<string, unknown>[];
    expect(messages[0]).toEqual({ role: 'system', content: '系统提示词' });
    expect(messages[1]).toEqual({ role: 'user', content: '北京天气？' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: '先查北京',
      tool_calls: [
        {
          id: 'call_0',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"北京"}' },
        },
      ],
    });
    expect(messages[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_0',
      content: '{"city":"北京","temperature":26}',
    });
    expect(messages[4]).toEqual({ role: 'user', content: '那上海呢？' });
  });

  it('disables thinking and strips reasoning when the session has thinking off', async () => {
    const { impl, calls } = fakeFetch([{ json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '好的' } }] } }]);
    const adapter = new DeepSeekAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://example.test',
      model: 'deepseek-flash',
      fetchImpl: impl,
    });

    await adapter.complete({
      system: 'sys',
      messages: [
        { role: 'assistant', content: '上一轮', reasoningContent: '一些思考', turnId: 'turn-1', step: 1 },
        { role: 'user', content: '继续', turnId: 'turn-2' },
      ],
      tools: [],
      thinking: false,
      maxTokens: 1024,
    });

    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.reasoning_effort).toBeUndefined();
    const messages = body.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({ role: 'assistant', content: '上一轮' });
  });

  it('turns non-retryable HTTP failures into a readable ModelError', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, text: '{"error":{"message":"invalid key"}}' }]);
    const adapter = new DeepSeekAdapter({
      apiKey: 'bad-key',
      baseUrl: 'https://example.test',
      model: 'deepseek-flash',
      fetchImpl: impl,
      sleep: async () => {},
    });

    const error = await adapter
      .complete({ system: 's', messages: [], tools: [], thinking: true, maxTokens: 10 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ status: 401, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('marks 429 retryable and parses Retry-After', async () => {
    const sleeps: number[] = [];
    const { impl, calls } = fakeFetch([
      { status: 429, headers: { 'retry-after': '3' }, text: 'rate limited' },
      { status: 429, headers: { 'retry-after': '3' }, text: 'rate limited' },
      { status: 429, headers: { 'retry-after': '3' }, text: 'rate limited' },
    ]);
    const adapter = new DeepSeekAdapter({
      apiKey: 'k',
      baseUrl: 'https://example.test',
      model: 'deepseek-flash',
      fetchImpl: impl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(
      adapter.complete({ system: 's', messages: [], tools: [], thinking: true, maxTokens: 10 }),
    ).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 3000 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 3000]);
  });
});
