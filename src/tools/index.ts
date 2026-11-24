import type { ToolDefinition } from '../types.js';
import { calculatorTool } from './calculator.js';

export function createDefaultTools(): ToolDefinition[] {
  return [calculatorTool];
}
