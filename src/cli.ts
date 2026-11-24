import { readFileSync } from 'node:fs';
import { runCli } from './cli/run.js';
import { loadConfig } from './config.js';
import { DeepSeekAdapter } from './model/deepseek.js';

const config = loadConfig();
const system = readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8');

const code = await runCli({
  argv: process.argv.slice(2),
  config,
  system,
  createAdapter: (model, apiKey) =>
    new DeepSeekAdapter({
      apiKey,
      baseUrl: config.baseUrl,
      model,
    }),
});

process.exitCode = code;
