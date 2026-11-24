import type { Config } from '../config.js';
import type { ModelAdapter } from '../model/adapter.js';
import { AgentRuntime } from '../runtime/loop.js';
import { createSession } from '../session/session.js';

export interface CliDeps {
  argv: string[];
  config: Config;
  system: string;
  createAdapter: () => ModelAdapter;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export const USAGE = [
  '用法：',
  '  agent "问题"                 单次提问',
  '  agent --verbose "问题"       显示思考过程',
  '  agent --help                 查看帮助',
  '',
  '环境变量：DEEPSEEK_API_KEY（必填）、DEEPSEEK_MODEL、DEEPSEEK_BASE_URL 等，详见 README。',
].join('\n');

export async function runCli(deps: CliDeps): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));
  const args = deps.argv;

  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }

  const verbose = args.includes('--verbose');
  const question = args
    .filter((arg) => !arg.startsWith('-'))
    .join(' ')
    .trim();

  if (!question) {
    err(USAGE);
    return 2;
  }

  if (!deps.config.apiKey) {
    err('缺少 DEEPSEEK_API_KEY，请在环境变量中设置后再运行。');
    return 1;
  }

  const session = createSession({
    id: 'oneshot',
    model: deps.config.model,
    thinking: deps.config.thinking,
  });
  const runtime = new AgentRuntime(deps.createAdapter(), {
    system: deps.system,
    maxSteps: deps.config.maxSteps,
    maxTokens: deps.config.maxTokens,
  });

  try {
    const result = await runtime.runTurn(session, question);
    if (verbose && result.reasoningContent) {
      err(`[思考] ${result.reasoningContent}`);
    }
    out(result.content);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    err(`请求失败：${detail}`);
    return 1;
  }
}
