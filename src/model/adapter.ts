import type { ModelRequest, ModelResponse } from '../types.js';

export interface ModelAdapter {
  complete(req: ModelRequest): Promise<ModelResponse>;
}
