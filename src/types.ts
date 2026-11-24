export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
  turnId?: string;
  step?: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  reasoningContent?: string | null;
  toolCalls?: ToolCall[];
  turnId?: string;
  step?: number;
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  turnId?: string;
  step?: number;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export type ContextMessage = UserMessage | AssistantMessage | ToolMessage | SystemMessage;

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResult {
  content: string;
  isError: boolean;
}

export interface TodoItem {
  id: string;
  content: string;
  done: boolean;
  createdAt: string;
}

export interface Session {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  thinking: boolean;
  turnSeq: number;
  summary: string | null;
  todos: TodoItem[];
  messages: ContextMessage[];
}

export interface ToolContext {
  session: Session;
}

export interface ToolDefinition extends ToolSchema {
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ModelRequest {
  system: string;
  messages: ContextMessage[];
  tools: ToolSchema[];
  thinking: boolean;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
}

export interface ModelResponse {
  content: string | null;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: ModelUsage;
}
