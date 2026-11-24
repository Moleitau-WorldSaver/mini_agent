export interface Config {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  maxSteps: number;
  contextTokens: number;
  keepRecent: number;
  thinking: boolean;
  maxTokens: number;
  dataDir: string;
  lockStaleMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    apiKey: env.DEEPSEEK_API_KEY?.trim() ? env.DEEPSEEK_API_KEY.trim() : null,
    baseUrl: (env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-flash',
    maxSteps: integer(env.MINI_AGENT_MAX_STEPS, 8, 1),
    contextTokens: integer(env.MINI_AGENT_CONTEXT_TOKENS, 32768, 1000),
    keepRecent: integer(env.MINI_AGENT_KEEP_RECENT, 8, 2),
    thinking: bool(env.MINI_AGENT_THINKING, true),
    maxTokens: integer(env.MINI_AGENT_MAX_TOKENS, 8192, 256),
    dataDir: env.MINI_AGENT_DATA_DIR?.trim() || 'data',
    lockStaleMs: integer(env.MINI_AGENT_LOCK_STALE_MS, 600_000, 1000),
  };
}

function integer(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const rounded = Math.floor(parsed);
  return rounded < min ? fallback : rounded;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) {
    return false;
  }
  if (['1', 'true', 'on', 'yes'].includes(normalized)) {
    return true;
  }
  return fallback;
}
