export interface RecordedFetch {
  url: string;
  init: RequestInit;
  body: unknown;
}

export type FakeFetchResponse = {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  throw?: Error;
};

export function fakeFetch(responses: FakeFetchResponse[]) {
  const calls: RecordedFetch[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, init: init ?? {}, body });
    const next = responses.shift();
    if (!next) {
      throw new Error('fakeFetch: no response left');
    }
    if (next.throw) {
      throw next.throw;
    }
    const status = next.status ?? 200;
    const payload = next.text ?? JSON.stringify(next.json ?? {});
    return new Response(payload, {
      status,
      headers: { 'content-type': 'application/json', ...(next.headers ?? {}) },
    });
  };
  return { impl, calls };
}
