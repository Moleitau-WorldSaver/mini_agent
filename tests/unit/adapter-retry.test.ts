import { describe, expect, it } from 'vitest';
import { DeepSeekAdapter } from '../../src/model/deepseek.js';
import { fakeFetch, type FakeFetchResponse } from '../fake-fetch.js';

const OK: FakeFetchResponse = {
  json: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] },
};

const REQUEST = { system: 's', messages: [], tools: [], thinking: true, maxTokens: 10 };

function adapterWith(responses: FakeFetchResponse[]) {
  const sleeps: number[] = [];
  const { impl, calls } = fakeFetch(responses);
  const adapter = new DeepSeekAdapter({
    apiKey: 'k',
    baseUrl: 'https://example.test',
    model: 'deepseek-flash',
    fetchImpl: impl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { adapter, calls, sleeps };
}

describe('DeepSeekAdapter retries', () => {
  it('retries retryable failures with 1s and 2s backoff', async () => {
    const { adapter, calls, sleeps } = adapterWith([
      { status: 429, text: 'busy' },
      { status: 500, text: 'boom' },
      OK,
    ]);

    const response = await adapter.complete(REQUEST);

    expect(response.content).toBe('ok');
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('honours Retry-After over the default backoff', async () => {
    const { adapter, sleeps } = adapterWith([
      { status: 503, headers: { 'retry-after': '3' }, text: 'busy' },
      OK,
    ]);

    await adapter.complete(REQUEST);

    expect(sleeps).toEqual([3000]);
  });

  it('retries network failures', async () => {
    const { adapter, calls, sleeps } = adapterWith([{ throw: new TypeError('network down') }, OK]);

    const response = await adapter.complete(REQUEST);

    expect(response.content).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('does not retry 401', async () => {
    const { adapter, calls, sleeps } = adapterWith([{ status: 401, text: 'invalid key' }]);

    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({ status: 401, retryable: false });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after three attempts', async () => {
    const { adapter, calls, sleeps } = adapterWith([
      { status: 500, text: 'boom' },
      { status: 500, text: 'boom' },
      { status: 500, text: 'boom' },
    ]);

    await expect(adapter.complete(REQUEST)).rejects.toMatchObject({ status: 500, retryable: true });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });
});
