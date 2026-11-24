import { AgentRuntime, type RuntimeEvent } from '../runtime/loop.js';
import { createDefaultTools } from '../tools/index.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Session } from '../types.js';
import type { CliDeps } from './deps.js';

export interface RuntimeHooks {
  onEvent: (event: RuntimeEvent) => Promise<void> | void;
  onSessionUpdated?: (session: Session) => Promise<void> | void;
}

export function createRuntime(
  deps: CliDeps,
  session: Session,
  noCompress: boolean,
  hooks: RuntimeHooks,
  apiKey: string,
): AgentRuntime {
  return new AgentRuntime(deps.createAdapter(session.model, apiKey), {
    system: deps.system,
    maxSteps: deps.config.maxSteps,
    maxTokens: deps.config.maxTokens,
    contextTokens: deps.config.contextTokens,
    keepRecent: deps.config.keepRecent,
    compression: !noCompress,
    tools: new ToolRegistry(createDefaultTools()),
    onEvent: hooks.onEvent,
    onSessionUpdated: hooks.onSessionUpdated,
  });
}
