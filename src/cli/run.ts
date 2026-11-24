import { createInterface } from 'node:readline/promises';
import type { Config } from '../config.js';
import type { ModelAdapter } from '../model/adapter.js';
import { AgentRuntime, type RuntimeEvent } from '../runtime/loop.js';
import { TurnCancelledError } from '../runtime/errors.js';
import { acquireLock, SessionLockError } from '../session/lock.js';
import { SessionManager, type SessionSummary } from '../session/manager.js';
import { createSession, isValidSessionId, newSessionId } from '../session/session.js';
import { SessionStoreError } from '../session/store.js';
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
  '  agent --list                   列出会话',
  '  agent "问题"                   单次提问',
  '  agent --verbose "问题"         显示思考过程',
  '  agent --no-compress            关闭上下文压缩',
  '  agent --help                   查看帮助',
  '',
  '环境变量：DEEPSEEK_API_KEY（必填）、DEEPSEEK_MODEL、DEEPSEEK_BASE_URL 等，详见 README。',
].join('\n');

export const REPL_HELP = [
  '可用命令：',
  '  /help          显示帮助',
  '  /new [id]      新建并切换会话',
  '  /switch <id>   切换会话',
  '  /todos         查看当前会话的待办',
  '  /exit          退出（也可用 /quit）',
  '直接输入文字即可对话。',
].join('\n');

interface ParsedArgs {
  help: boolean;
  verbose: boolean;
  noCompress: boolean;
  listSessions: boolean;
  sessionId?: string;
  question: string;
}

type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

interface LineSource {
  next(): Promise<string | null>;
  close(): void;
  onInterrupt?: (handler: () => void) => () => void;
}

interface ReplContext {
  session: Session;
  runtime: AgentRuntime;
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

  const { help, verbose, noCompress, listSessions, sessionId, question } = parsed.args;
  if (help) {
    out(USAGE);
    return 0;
  }

  if (listSessions) {
    const manager = new SessionManager({
      dataDir: deps.config.dataDir,
      model: deps.config.model,
      thinking: deps.config.thinking,
      onWarning: err,
    });
    out(formatSessionList(await manager.list()));
    return 0;
  }

  if (sessionId !== undefined && !isValidSessionId(sessionId)) {
    err(`会话 id 不合法：${sessionId}。只能使用 1–32 位字母、数字、下划线或连字符。`);
    return 2;
  }

  if (!deps.config.apiKey) {
    err('缺少 DEEPSEEK_API_KEY，请在环境变量中设置后再运行。');
    return 1;
  }

  try {
    if (question) {
      return await runOneShot(deps, question, verbose, noCompress, out, err);
    }
    return await runReplMode(deps, sessionId, verbose, noCompress, out, err);
  } catch (error) {
    if (error instanceof SessionLockError) {
      err(error.message);
      return 1;
    }
    if (error instanceof SessionStoreError) {
      err(`会话无法载入：${error.message}`);
      return 1;
    }
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
  const manager = new SessionManager({
    dataDir: deps.config.dataDir,
    model: deps.config.model,
    thinking: deps.config.thinking,
    onWarning: err,
  });

  const id = sessionId ?? newSessionId();
  let releaseLock = await acquireLock(deps.config.dataDir, id, deps.config.lockStaleMs);

  try {
    const opened = await manager.open(id);
    if (!opened.created && opened.session.thinking !== deps.config.thinking) {
      err(`提示：会话 ${opened.session.id} 记录为思考模式${opened.session.thinking ? '开启' : '关闭'}，沿用会话设置。`);
    }

    const createContext = (session: Session): ReplContext => {
      const trace = new TraceWriter(traceFilePath(deps.config.dataDir, session.id), (message) => err(message));
      const runtime = new AgentRuntime(deps.createAdapter(session.model), {
        system: deps.system,
        maxSteps: deps.config.maxSteps,
        maxTokens: deps.config.maxTokens,
        contextTokens: deps.config.contextTokens,
        keepRecent: deps.config.keepRecent,
        compression: !noCompress,
        tools: new ToolRegistry(createDefaultTools()),
        onSessionUpdated: (current) => manager.save(current),
        onEvent: async (event) => {
          await trace.write(session.id, event);
          printEvent(event, out);
        },
      });
      return { session, runtime };
    };

    let context = createContext(opened.session);
    out(`会话 ${context.session.id}（${opened.created ? '新建' : '已恢复'}）`);
    if (opened.repaired > 0) {
      await new TraceWriter(traceFilePath(deps.config.dataDir, id), (message) => err(message)).writeRepair(
        id,
        opened.repaired,
      );
      out(`提示：已修复 ${opened.repaired} 处未完成的工具调用。`);
    }

    const switchTo = async (nextId: string, createNew: boolean): Promise<void> => {
      if (!isValidSessionId(nextId)) {
        err(`会话 id 不合法：${nextId}。只能使用 1–32 位字母、数字、下划线或连字符。`);
        return;
      }
      if (nextId === context.session.id) {
        out(`已经在会话 ${nextId}。`);
        return;
      }

      const nextRelease = await acquireLock(deps.config.dataDir, nextId, deps.config.lockStaleMs);
      let switched = false;
      try {
        const target = createNew
          ? { session: await manager.create(nextId), created: true, repaired: 0 }
          : await manager.open(nextId);

        await releaseLock();
        releaseLock = nextRelease;
        switched = true;
        context = createContext(target.session);

        if (target.repaired > 0) {
          await new TraceWriter(traceFilePath(deps.config.dataDir, nextId), (message) => err(message)).writeRepair(
            nextId,
            target.repaired,
          );
          out(`提示：已修复 ${target.repaired} 处未完成的工具调用。`);
        }
        out(`会话 ${target.session.id}（${target.created ? '新建' : '已恢复'}）`);
      } finally {
        if (!switched) {
          await nextRelease();
        }
      }
    };

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
          out(formatTodos(context.session));
          continue;
        }
        if (input === '/new' || input.startsWith('/new ')) {
          const requested = input.slice('/new'.length).trim() || newSessionId();
          try {
            await switchTo(requested, true);
          } catch (error) {
            err(`无法新建会话：${error instanceof Error ? error.message : String(error)}`);
          }
          continue;
        }
        if (input === '/switch' || input.startsWith('/switch ')) {
          const requested = input.slice('/switch'.length).trim();
          if (!requested) {
            err('用法：/switch <会话 id>');
            continue;
          }
          try {
            await switchTo(requested, false);
          } catch (error) {
            err(`无法切换会话：${error instanceof Error ? error.message : String(error)}`);
          }
          continue;
        }
        if (input.startsWith('/')) {
          out(`未知命令：${input}。输入 /help 查看可用命令。`);
          continue;
        }

        const controller = new AbortController();
        activeController = controller;
        try {
          const result = await context.runtime.runTurn(context.session, input, {
            signal: controller.signal,
          });
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
  } finally {
    await releaseLock();
  }
}

function parseArgs(argv: string[]): ParseResult {
  const rest: string[] = [];
  let help = false;
  let verbose = false;
  let noCompress = false;
  let listSessions = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--no-compress') {
      noCompress = true;
    } else if (arg === '--list') {
      listSessions = true;
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

  return {
    ok: true,
    args: { help, verbose, noCompress, listSessions, sessionId, question: rest.join(' ').trim() },
  };
}

function formatSessionList(items: SessionSummary[]): string {
  if (items.length === 0) {
    return '暂无会话。';
  }
  return items
    .map(
      (item) =>
        `${item.id} | ${item.title} | ${item.updatedAt} | 消息 ${item.messageCount} | 待办 ${item.todoCount} | 思考 ${item.thinking ? '开' : '关'}`,
    )
    .join('\n');
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
