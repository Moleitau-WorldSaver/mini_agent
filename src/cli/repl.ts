import type { AgentRuntime } from '../runtime/loop.js';
import { TurnCancelledError } from '../runtime/errors.js';
import { acquireLock } from '../session/lock.js';
import { SessionManager } from '../session/manager.js';
import { isValidSessionId, newSessionId } from '../session/session.js';
import { TraceWriter, traceFilePath } from '../telemetry/trace.js';
import type { Session } from '../types.js';
import type { CliDeps } from './deps.js';
import { REPL_HELP, formatTodos, printToolEvent } from './format.js';
import { readlineSource, type LineSource } from './line-source.js';
import { createRuntime } from './runtime-factory.js';

interface ReplContext {
  session: Session;
  runtime: AgentRuntime;
}

export async function runReplMode(
  deps: CliDeps,
  sessionId: string | undefined,
  verbose: boolean,
  noThink: boolean,
  noCompress: boolean,
  apiKey: string,
  source: LineSource | undefined,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const effectiveThinking = deps.config.thinking && !noThink;
  const manager = new SessionManager({
    dataDir: deps.config.dataDir,
    model: deps.config.model,
    thinking: effectiveThinking,
    onWarning: err,
  });

  const id = sessionId ?? newSessionId();
  let releaseLock = await acquireLock(deps.config.dataDir, id, deps.config.lockStaleMs);

  try {
    const opened = await manager.open(id);
    if (!opened.created && opened.session.thinking !== effectiveThinking) {
      err(`提示：会话 ${opened.session.id} 记录为思考模式${opened.session.thinking ? '开启' : '关闭'}，沿用会话设置。`);
    }

    const createContext = (session: Session): ReplContext => {
      const trace = new TraceWriter(traceFilePath(deps.config.dataDir, session.id), (message) => err(message));
      const runtime = createRuntime(
        deps,
        session,
        noCompress,
        {
          onSessionUpdated: (current) => manager.save(current),
          onEvent: async (event) => {
            await trace.write(session.id, event);
            if (verbose) {
              printToolEvent(event, out);
            }
          },
        },
        apiKey,
      );
      return { session, runtime };
    };

    const reportRepair = async (sessionIdToReport: string, repaired: number): Promise<void> => {
      if (repaired <= 0) {
        return;
      }
      await new TraceWriter(
        traceFilePath(deps.config.dataDir, sessionIdToReport),
        (message) => err(message),
      ).writeRepair(sessionIdToReport, repaired);
      out(`提示：已修复 ${repaired} 处未完成的工具调用。`);
    };

    let context = createContext(opened.session);
    out(`会话 ${context.session.id}（${opened.created ? '新建' : '已恢复'}）`);
    await reportRepair(id, opened.repaired);

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

        await reportRepair(nextId, target.repaired);
        out(`会话 ${target.session.id}（${target.created ? '新建' : '已恢复'}）`);
      } finally {
        if (!switched) {
          await nextRelease();
        }
      }
    };

    const lineSource = source ?? readlineSource();
    let activeController: AbortController | null = null;
    const detachInterrupt = lineSource.onInterrupt?.(() => {
      if (activeController) {
        activeController.abort();
        return;
      }
      lineSource.close();
    });

    try {
      while (true) {
        const line = await lineSource.next();
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
      lineSource.close();
    }

    return 0;
  } finally {
    await releaseLock();
  }
}
