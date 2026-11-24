import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeEvent } from '../runtime/loop.js';

const CONTENT_LIMIT = 4000;

export function traceFilePath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, 'traces', `${sessionId}.jsonl`);
}

export class TraceWriter {
  private readonly filePath: string;
  private readonly onError: (message: string) => void;

  constructor(filePath: string, onError: (message: string) => void = () => {}) {
    this.filePath = filePath;
    this.onError = onError;
  }

  async write(sessionId: string, event: RuntimeEvent): Promise<void> {
    const record = { ts: new Date().toISOString(), sessionId, ...toRecord(event) };
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      this.onError(`Trace 写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function toRecord(event: RuntimeEvent): Record<string, unknown> {
  switch (event.type) {
    case 'llm':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: 'llm',
        request: event.request,
        response: {
          finishReason: event.response.finishReason,
          content: truncate(event.response.content),
          reasoningContent: truncate(event.response.reasoningContent),
          toolCalls: event.response.toolCalls,
        },
        usage: event.response.usage,
        durationMs: event.durationMs,
      };
    case 'tool':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: 'tool',
        tool: event.call.name,
        toolCallId: event.call.id,
        args: parseArguments(event.call.arguments),
        result: truncate(event.result.content),
        isError: event.result.isError,
        durationMs: event.durationMs,
      };
    case 'error':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: 'error',
        error: event.error,
      };
    case 'turn_end':
      return {
        turnId: event.turnId,
        kind: 'turn_end',
        steps: event.steps,
        reason: event.reason,
      };
    case 'compression':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: event.fallback ? 'compression_fallback' : 'compression',
        removedMessages: event.removedMessages,
        keptMessages: event.keptMessages,
        summaryChars: event.summaryChars,
        durationMs: event.durationMs,
        error: event.error,
      };
    case 'cancelled':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: 'cancelled',
      };
  }
}

function truncate(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (value.length <= CONTENT_LIMIT) {
    return value;
  }
  return `${value.slice(0, CONTENT_LIMIT)}…[truncated ${value.length - CONTENT_LIMIT} chars]`;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return truncate(raw);
  }
}
