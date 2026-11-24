import type { ModelAdapter } from './adapter.js';
import type { ContextMessage, ModelRequest, ModelResponse, ModelUsage } from '../types.js';

export type ModelErrorKind = 'http' | 'network' | 'protocol' | 'aborted';

export interface ModelErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  kind?: ModelErrorKind;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ModelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelError';
    this.kind = options.kind ?? (options.status === undefined ? 'protocol' : 'http');
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface DeepSeekOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireResponse {
  choices?: { finish_reason?: string; message?: WireMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class DeepSeekAdapter implements ModelAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body = this.buildBody(req);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (error) {
      if (req.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new ModelError('请求已取消', { kind: 'aborted', retryable: false, cause: error });
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new ModelError(`网络请求失败：${detail}`, { kind: 'network', retryable: true, cause: error });
    }

    if (!response.ok) {
      throw await this.httpError(response);
    }

    let json: WireResponse;
    try {
      json = (await response.json()) as WireResponse;
    } catch (error) {
      throw new ModelError('模型响应不是合法 JSON', { kind: 'protocol', retryable: false, cause: error });
    }

    const choice = json.choices?.[0];
    if (!choice?.message) {
      throw new ModelError('模型响应缺少 choices[0].message', { kind: 'protocol', retryable: false });
    }

    const message = choice.message;
    const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? '',
      arguments:
        typeof call.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call.function?.arguments ?? {}),
    }));

    return {
      content: typeof message.content === 'string' ? message.content : null,
      reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : null,
      toolCalls,
      finishReason: choice.finish_reason ?? 'stop',
      usage: mapUsage(json.usage),
    };
  }

  private buildBody(req: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((message) => this.toWireMessage(message, req.thinking)),
      ],
      max_tokens: req.maxTokens,
      stream: false,
    };

    if (req.tools.length > 0) {
      body.tools = req.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    if (req.thinking) {
      body.reasoning_effort = 'low';
    } else {
      body.thinking = { type: 'disabled' };
    }

    return body;
  }

  private toWireMessage(message: ContextMessage, thinking: boolean): Record<string, unknown> {
    if (message.role === 'system') {
      return { role: 'system', content: message.content };
    }
    if (message.role === 'user') {
      return { role: 'user', content: message.content };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    }

    const wire: Record<string, unknown> = {
      role: 'assistant',
      content: message.content ?? '',
    };
    if (thinking) {
      wire.reasoning_content = message.reasoningContent ?? '';
    }
    if (message.toolCalls && message.toolCalls.length > 0) {
      wire.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    return wire;
  }

  private async httpError(response: Response): Promise<ModelError> {
    const raw = await response.text().catch(() => '');
    const detail = extractErrorMessage(raw);
    const retryable = RETRYABLE_STATUS.has(response.status);
    return new ModelError(
      `HTTP ${response.status}${detail ? `：${detail}` : ''}`,
      {
        kind: 'http',
        status: response.status,
        retryable,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      },
    );
  }
}

function mapUsage(usage: WireResponse['usage']): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  };
}

function extractErrorMessage(raw: string): string {
  if (!raw) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') {
      return truncate(parsed.error, 300);
    }
    if (parsed.error?.message) {
      return truncate(parsed.error.message, 300);
    }
    if (parsed.message) {
      return truncate(parsed.message, 300);
    }
  } catch {
    // fall through to the raw body
  }
  return truncate(raw, 300);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return undefined;
}
