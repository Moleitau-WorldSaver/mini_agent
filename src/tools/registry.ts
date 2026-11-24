import type { ToolExecutor } from '../runtime/loop.js';
import type { Session, ToolCall, ToolDefinition, ToolResult, ToolSchema } from '../types.js';
import { truncateWithMarker } from '../text.js';
import { assertSupportedSchema, validateArgs } from './validator.js';

export class ToolRegistry implements ToolExecutor {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[]) {
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(`重复注册工具：${definition.name}`);
      }
      assertSupportedSchema(definition.parameters);
      this.tools.set(definition.name, definition);
    }
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async execute(call: ToolCall, session: Session): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      const available = [...this.tools.keys()].join('、') || '无';
      return errorResult(`未知工具：${call.name}`, `可用工具：${available}`);
    }

    let args: unknown;
    const raw = call.arguments.trim();
    try {
      args = raw === '' ? {} : (JSON.parse(raw) as unknown);
    } catch {
      return errorResult(`工具 ${call.name} 的参数不是合法 JSON`);
    }

    const validation = validateArgs(tool.parameters, args);
    if (!validation.ok) {
      return errorResult(`工具 ${call.name} 的参数不合法：${validation.error}`);
    }

    try {
      const result = await tool.execute(args, { session });
      return { ...result, content: truncateWithMarker(result.content, RESULT_LIMIT) };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return errorResult(`工具 ${call.name} 执行失败：${detail}`);
    }
  }
}

const RESULT_LIMIT = 4000;

function errorResult(message: string, hint?: string): ToolResult {
  const payload: Record<string, string> = { error: message };
  if (hint) {
    payload.hint = hint;
  }
  return { content: JSON.stringify(payload), isError: true };
}
