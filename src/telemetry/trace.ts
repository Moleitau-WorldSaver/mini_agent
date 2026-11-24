import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeEvent } from '../runtime/loop.js';
import { truncateWithMarker } from '../text.js';

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
    await this.append({ ts: new Date().toISOString(), sessionId, ...toRecord(event) });
  }

  async writeRepair(sessionId: string, repaired: number): Promise<void> {
    await this.append({
      ts: new Date().toISOString(),
      sessionId,
      turnId: null,
      step: 0,
      kind: 'repair',
      repaired,
      durationMs: 0,
    });
  }

  private async append(record: Record<string, unknown>): Promise<void> {
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
          content: truncateNullable(event.response.content),
          reasoningContent: truncateNullable(event.response.reasoningContent),
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
        result: truncateNullable(event.result.content),
        isError: event.result.isError,
        durationMs: event.durationMs,
      };
    case 'error':
      return {
        turnId: event.turnId,
        step: event.step,
        kind: 'error',
        durationMs: event.durationMs,
        error: event.error,
      };
    case 'turn_end':
      return {
        turnId: event.turnId,
        step: event.steps,
        kind: 'turn_end',
        steps: event.steps,
        reason: event.reason,
        durationMs: event.durationMs,
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
        durationMs: event.durationMs,
      };
  }
}

function truncateNullable(value: string | null): string | null {
  return value === null ? null : truncateWithMarker(value, CONTENT_LIMIT);
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return truncateWithMarker(raw, CONTENT_LIMIT);
  }
}
