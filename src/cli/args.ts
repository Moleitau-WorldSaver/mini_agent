export const USAGE = [
  '用法：',
  '  agent                          进入交互式会话',
  '  agent --session w1             恢复或新建会话 w1',
  '  agent --list                   列出会话',
  '  agent "问题"                   单次提问',
  '  agent --verbose "问题"         显示思考过程',
  '  agent --no-think               新会话关闭思考模式',
  '  agent --no-compress            关闭上下文压缩',
  '  agent --help                   查看帮助',
  '',
  '环境变量：DEEPSEEK_API_KEY（必填）、DEEPSEEK_MODEL、DEEPSEEK_BASE_URL 等，详见 README。',
].join('\n');

export interface ParsedArgs {
  help: boolean;
  verbose: boolean;
  noThink: boolean;
  noCompress: boolean;
  listSessions: boolean;
  sessionId?: string;
  question: string;
}

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  const rest: string[] = [];
  let help = false;
  let verbose = false;
  let noThink = false;
  let noCompress = false;
  let listSessions = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--no-think') {
      noThink = true;
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
    args: { help, verbose, noThink, noCompress, listSessions, sessionId, question: rest.join(' ').trim() },
  };
}
