import type { Config } from '../config.js';
import type { ModelAdapter } from '../model/adapter.js';

export interface CliDeps {
  argv: string[];
  config: Config;
  system: string;
  createAdapter: (model: string, apiKey: string) => ModelAdapter;
  lines?: AsyncIterable<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}
