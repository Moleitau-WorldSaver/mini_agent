import type { ToolDefinition } from '../types.js';
import { calculatorTool } from './calculator.js';
import { searchTool } from './search.js';
import { todoTool } from './todo.js';
import { weatherTool } from './weather.js';

export function createDefaultTools(): ToolDefinition[] {
  return [calculatorTool, searchTool, weatherTool, todoTool];
}
