import { SessionLockError } from '../session/lock.js';
import { SessionManager } from '../session/manager.js';
import { createSession, isValidSessionId } from '../session/session.js';
import { SessionStoreError } from '../session/store.js';
import { parseArgs, USAGE } from './args.js';
import type { CliDeps } from './deps.js';
import { formatSessionList, printToolEvent } from './format.js';
import { runReplMode } from './repl.js';
import { createRuntime } from './runtime-factory.js';

export type { CliDeps } from './deps.js';
export { USAGE } from './args.js';

export async function runCli(deps: CliDeps): Promise<number> {
  const out = deps.stdout ?? ((line: string) => console.log(line));
  const err = deps.stderr ?? ((line: string) => console.error(line));

  const parsed = parseArgs(deps.argv);
  if (!parsed.ok) {
    err(parsed.error);
    err(USAGE);
    return 2;
  }

  const { help, verbose, noThink, noCompress, listSessions, sessionId, question } = parsed.args;
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
      return await runOneShot(deps, question, verbose, noThink, noCompress, out, err);
    }
    return await runReplMode(deps, sessionId, verbose, noThink, noCompress, out, err);
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
  noThink: boolean,
  noCompress: boolean,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const session = createSession({
    id: 'oneshot',
    model: deps.config.model,
    thinking: deps.config.thinking && !noThink,
  });
  const runtime = createRuntime(deps, session, noCompress, {
    onEvent: (event) => {
      if (verbose) {
        printToolEvent(event, out);
      }
    },
  });

  const result = await runtime.runTurn(session, question);
  if (verbose && result.reasoningContent) {
    err(`[思考] ${result.reasoningContent}`);
  }
  out(result.content);
  return 0;
}
