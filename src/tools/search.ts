import type { ToolDefinition } from '../types.js';

interface SearchFixture {
  id: string;
  title: string;
  snippet: string;
  keywords: string[];
}

const FIXTURES: SearchFixture[] = [
  {
    id: 'd1',
    title: 'Agent Runtime 概览',
    snippet: 'Agent runtime 负责 Turn 与 Step 循环，以及工具调用。',
    keywords: ['agent', 'runtime', 'turn', 'step', '工具'],
  },
  {
    id: 'd2',
    title: 'Session 隔离与持久化',
    snippet: '每个 Agent 会话独立保存消息与待办，会话之间互不可见。',
    keywords: ['session', 'agent', '会话', '隔离', '持久化', '待办'],
  },
  {
    id: 'd3',
    title: 'Context 压缩策略',
    snippet: '上下文达到预算后，把旧消息压缩成摘要，保留最近原文。',
    keywords: ['context', '上下文', '压缩', '摘要', '预算'],
  },
  {
    id: 'd4',
    title: '工具调用协议',
    snippet: 'Agent 通过 JSON Schema 描述工具参数，由模型决定是否调用。',
    keywords: ['agent', '工具', 'schema', '调用', '协议'],
  },
  {
    id: 'd5',
    title: '错误处理与重试',
    snippet: 'Agent 遇到限流与网络错误时退避重试，取消时不破坏历史。',
    keywords: ['agent', '错误', '重试', '退避', '取消'],
  },
];

export const searchTool: ToolDefinition = {
  name: 'search',
  description: '搜索本地固定的文档片段，返回标题与摘要。没有命中时返回空列表，不算错误。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      topK: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(args) {
    const { query, topK } = args as { query: string; topK?: number };
    const limit = topK ?? 3;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = FIXTURES.map((document) => {
      const haystack = `${document.title}\n${document.snippet}\n${document.keywords.join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let index = haystack.indexOf(term);
        while (index !== -1) {
          score += 1;
          index = haystack.indexOf(term, index + term.length);
        }
      }
      return { document, score };
    })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id));

    const results = scored.slice(0, limit).map(({ document }) => ({
      id: document.id,
      title: document.title,
      snippet: document.snippet,
    }));

    return {
      content: JSON.stringify({ query, topK: limit, results, total: scored.length }),
      isError: false,
    };
  },
};
