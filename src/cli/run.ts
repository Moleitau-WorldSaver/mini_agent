import { createInterface } from 'node:readline/promises';
import type { Config } from '../config.js';
import type { ModelAdapter } from '../model/adapter.js';
import { AgentRuntime, type RuntimeEvent } from '../runtime/loop.js';
import { TurnCancelledError } from '../runtime/errors.js';
import { createSession, isValidSessionId } from '../session/session.js';
import { loadSession, saveSession } from '../session/store.js';
import { TraceWriter, traceFilePath } from '../telemetry/trace.js';
import { createDefaultTools } from '../tools/index.js';
import { ToolRegistry } from '../tools/registry.js';
import type { Session } from '../types.js';

export interface CliDeps {
  argv: string[];
  config: Config;
  system: string;
  createAdapter: (model: string) => ModelAdapter;
  lines?: AsyncIterable<string>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export const USAGE = [
  '用法：',
  '  agent                          进入交互式会话',
  '  agent --session w1             恢复或新建会话 w1',
  '  agent "问题"                   单次提问',
  '  agent --verbose "问题"         显示思考过程',
  '  agent --no-compress            关闭上下文压缩',
  '  agent --help                   查看帮助',
  '',
  '环境变量：DEEPSEEK_API_KEY（必填）、DEEPSEEK_MODEL、DEEPSEEK_BASE_URL 等，详见 README。',
].join('\n');

export const REPL_HELP = [
  '可用命令：',
  '  /help    显示帮助',
  '  /exit    退出（也可用 /quit）',
  '  /todos   查看当前会话的待办',
  '直接输入文字即可对话。',
].join('\n');

interface ParsedArgs {
  help: boolean;
  verbose: boolean;
  noCompress: boolean;
  sessionId?: string;
  question: string;
}

type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

interface LineSource {
  next(): Promise<string | null>;
  close(): void;
  onInterrupt?: (handler: () => void) => () => void;
}

export async function runCli(deps: CliDeps): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));

  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    err(parsed.error);
    err(USAGE);
    return 2;
  }

  const { help, verbose, noCompress, sessionId, question } = parsed.args;
  if (help) {
    out(USAGE);
    return 0;
  }

  if (!deps.config.apiKey) {
    err('缺少 DEEPSEEK_API_KEY，请在环境变量中设置后再运行。');
    return 1;
  }

  if (sessionId !== undefined && !isValidSessionId(sessionId)) {
    err(`会话 id 不合法：${sessionId}。只能使用 1–32 位字母、数字、下划线或连字符。`);
    return 2;
  }

  try {
    if (question) {
      return await runOneShot(deps, question, verbose, noCompress, out, err);
    }
    return await runReplMode(deps, sessionId, verbose, noCompress, out, err);
  } catch (error) {
    err(`请求失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function runOneShot(
  deps: CliDeps,
  question: string,
  verbose: boolean,
  noCompress: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const session = createSession({
    id: 'oneshot',
    model: deps.config.model,
    thinking: deps.config.thinking,
  });
  const runtime = new AgentRuntime(deps.createAdapter(session.model), {
    system: deps.system,
    maxSteps: deps.config.maxSteps,
    maxTokens: deps.config.maxTokens,
    contextTokens: deps.config.contextTokens,
    keepRecent: deps.config.keepRecent,
    compression: !noCompress,
    tools: new ToolRegistry(createDefaultTools()),
    onEvent: (event) => {
      printEvent(event, out);
    },
  });

  const result = await runtime.runTurn(session, question);
  if (verbose && result.reasoningContent) {
    err(`[思考] ${result.reasoningContent}`);
  }
  out(result.content);
  return 0;
}

async function runReplMode(
  deps: CliDeps,
  sessionId: string | undefined,
  verbose: boolean,
  noCompress: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const id = sessionId ?? newSessionId();
  const existing = await loadSession(deps.config.dataDir, id);
  const session =
    existing ??
    createSession({
      id,
      model: deps.config.model,
      thinking: deps.config.thinking,
    });

  if (existing) {
    if (session.thinking !== deps.config.thinking) {
      err(`提示：会话 ${id} 记录为思考模式${session.thinking ? '开启' : '关闭'}，沿用会话设置。`);
    }
  }

  const trace = new TraceWriter(traceFilePath(deps.config.dataDir, id), (message) => err(message));
  const runtime = new AgentRuntime(deps.createAdapter(session.model), {
    system: deps.system,
    maxSteps: deps.config.maxSteps,
    maxTokens: deps.config.maxTokens,
    contextTokens: deps.config.contextTokens,
    keepRecent: deps.config.keepRecent,
    compression: !noCompress,
    tools: new ToolRegistry(createDefaultTools()),
    onSessionUpdated: (current) => saveSession(deps.config.dataDir, current),
    onEvent: async (event) => {
      await trace.write(id, event);
      printEvent(event, out);
    },
  });

  out(`会话 ${id}（${existing ? '已恢复' : '新建'}）`);

  const source = deps.lines ? fromAsyncIterable(deps.lines) : readlineSource();
  let activeController: AbortController | null = null;
  const detachInterrupt = source.onInterrupt?.(() => {
    if (activeController) {
      activeController.abort();
      return;
    }
    source.close();
  });

  try {
    while (true) {
      const line = await source.next();
      if (line === null) {
        break;
      }
      const input = line.trim();
      if (!input) {
        continue;
      }
      if (input === '/exit' || input === '/quit') {
        break;
      }
      if (input === '/help') {
        out(REPL_HELP);
        continue;
      }
      if (input === '/todos') {
        out(formatTodos(session));
        continue;
      }
      if (input.startsWith('/')) {
        out(`未知命令：${input}。输入 /help 查看可用命令。`);
        continue;
      }

      const controller = new AbortController();
      activeController = controller;
      try {
        const result = await runtime.runTurn(session, input, { signal: controller.signal });
        if (verbose && result.reasoningContent) {
          err(`[思考] ${result.reasoningContent}`);
        }
        out(`助手> ${result.content}`);
      } catch (error) {
        if (error instanceof TurnCancelledError) {
          err('已取消当前轮次。');
        } else {
          err(`请求失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        activeController = null;
      }
    }
  } finally {
    detachInterrupt?.();
    source.close();
  }

  return 0;
}

function parseArgs(argv: string[]): ParseResult {
  const rest: string[] = [];
  let help = false;
  let verbose = false;
  let noCompress = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--no-compress') {
      noCompress = true;
    } else if (arg === '--session') {
      const value = argv[index + 1];
      if (!value) {
        return { ok: false, error: '--session 需要一个值' };
      }
      sessionId = value;
      index += 1;
    } else if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
    } else if (arg.startsWith('--')) {
      return { ok: false, error: `未知参数：${arg}` };
    } else {
      rest.push(arg);
    }
  }

  return { ok: true, args: { help, verbose, noCompress, sessionId, question: rest.join(' ').trim() } };
}

function newSessionId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `s-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function fromAsyncIterable(lines: AsyncIterable<string>): LineSource {
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await iterator.next();
      return result.done ? null : result.value;
    },
    close() {
      void iterator.return?.();
    },
  };
}

function readlineSource(): LineSource {
  const terminal = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal });
  const iterator = rl[Symbol.asyncIterator]();
  return {
    async next() {
      if (terminal) {
        rl.setPrompt('你> ');
        rl.prompt();
      }
      try {
        const result = await iterator.next();
        return result.done ? null : result.value;
      } catch {
        return null;
      }
    },
    close() {
      rl.close();
    },
    onInterrupt(handler: () => void) {
      rl.on('SIGINT', handler);
      return () => {
        rl.off('SIGINT', handler);
      };
    },
  };
}

function formatTodos(session: Session): string {
  if (session.todos.length === 0) {
    return '当前会话没有待办。';
  }
  return session.todos.map((todo) => `${todo.id} [${todo.done ? 'x' : ' '}] ${todo.content}`).join('\n');
}

function printEvent(event: RuntimeEvent, out: (line: string) => void): void {
  if (event.type !== 'tool') {
    return;
  }
  const args = compactArguments(event.call.arguments);
  const result = truncateText(event.result.content, 160);
  out(`[工具] ${event.call.name} ${args} → ${event.result.isError ? '错误：' : ''}${result}`);
}

function compactArguments(raw: string): string {
  try {
    return truncateText(JSON.stringify(JSON.parse(raw) as unknown), 120);
  } catch {
    return truncateText(raw, 120);
  }
}

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
