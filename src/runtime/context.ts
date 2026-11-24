import type { ModelAdapter } from '../model/adapter.js';
import type { ContextMessage, ToolSchema } from '../types.js';
import { truncate } from '../text.js';

const SUMMARY_SYSTEM_PROMPT =
  '你是对话摘要器。把给出的历史对话压缩成简洁、事实性的摘要，保留用户目标、约束、已完成的工具结果与待办状态。不要编造信息，只输出摘要正文。';
const COMPRESSION_MESSAGE_LIMIT = 48;
const SUMMARY_INPUT_LIMIT = 2000;

export function buildSystemPrompt(base: string, summary: string | null): string {
  if (!summary) {
    return base;
  }
  return `${base}\n\n## 早前对话摘要\n${summary}`;
}

export function countContextChars(system: string, messages: ContextMessage[], tools: ToolSchema[]): number {
  let total = system.length + tools.length * 200;
  for (const message of messages) {
    if (message.role === 'tool') {
      total += message.content.length;
    } else if (message.role === 'assistant') {
      total += message.content?.length ?? 0;
      total += message.reasoningContent?.length ?? 0;
      for (const call of message.toolCalls ?? []) {
        total += call.arguments.length;
      }
    } else {
      total += message.content.length;
    }
  }
  return total;
}

export function estimateTokens(system: string, messages: ContextMessage[], tools: ToolSchema[]): number {
  return Math.ceil(countContextChars(system, messages, tools) / 3);
}

export function compressionTriggered(tokens: number, messageCount: number, contextTokens: number): boolean {
  return tokens > contextTokens || messageCount > COMPRESSION_MESSAGE_LIMIT;
}

export function findCompressionCut(messages: ContextMessage[], keepRecent: number): number {
  const candidate = Math.max(0, messages.length - keepRecent);
  if (candidate === 0) {
    return 0;
  }
  for (let index = candidate; index > 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  // A single long turn may have no user boundary before the candidate; keep the
  // current turn intact and cut at its first user message instead.
  for (let index = candidate + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') {
      return index;
    }
  }
  return 0;
}

export interface SummarizeInput {
  adapter: ModelAdapter;
  oldSummary: string | null;
  removed: ContextMessage[];
  signal?: AbortSignal;
}

export async function summarizeMessages(input: SummarizeInput): Promise<string> {
  const transcript = input.removed.map(formatMessage).join('\n');
  const content = input.oldSummary
    ? `已有摘要：\n${input.oldSummary}\n\n需要合并的新对话：\n${transcript}`
    : transcript;

  const response = await input.adapter.complete({
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    tools: [],
    thinking: false,
    maxTokens: 1024,
    signal: input.signal,
  });

  const summary = (response.content ?? '').trim();
  if (!summary) {
    throw new Error('摘要模型返回了空内容');
  }
  return summary;
}

function formatMessage(message: ContextMessage): string {
  switch (message.role) {
    case 'user':
      return `用户：${truncate(message.content, SUMMARY_INPUT_LIMIT)}`;
    case 'assistant': {
      const calls = (message.toolCalls ?? [])
        .map((call) => `[调用工具 ${call.name}(${truncate(call.arguments, SUMMARY_INPUT_LIMIT)})]`)
        .join(' ');
      return `助手：${truncate(message.content ?? '', SUMMARY_INPUT_LIMIT)}${calls ? ` ${calls}` : ''}`;
    }
    case 'tool':
      return `工具 ${message.name} 结果${message.isError ? '（错误）' : ''}：${truncate(message.content, SUMMARY_INPUT_LIMIT)}`;
    case 'system':
      return `系统：${truncate(message.content, SUMMARY_INPUT_LIMIT)}`;
  }
}
