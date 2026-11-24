import type { ToolDefinition } from '../types.js';

const MAX_EXPRESSION_LENGTH = 200;

export function evaluate(expression: string): number {
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`表达式过长（最多 ${MAX_EXPRESSION_LENGTH} 字符）`);
  }
  const parser = new ExpressionParser(expression);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) {
    throw new Error('结果不是有限数值');
  }
  return value;
}

export const calculatorTool: ToolDefinition = {
  name: 'calculator',
  description: '计算四则运算表达式，支持加、减、乘、除、括号、小数与一元负号。输入一个表达式字符串。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', minLength: 1, maxLength: MAX_EXPRESSION_LENGTH },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  async execute(args) {
    const { expression } = args as { expression: string };
    const value = evaluate(expression);
    return {
      content: JSON.stringify({ expression, value }),
      isError: false,
    };
  },
};

class ExpressionParser {
  private index = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      const char = this.input[this.index];
      if (char === '+') {
        this.index += 1;
        value += this.parseTerm();
      } else if (char === '-') {
        this.index += 1;
        value -= this.parseTerm();
      } else {
        return value;
      }
    }
  }

  expectEnd(): void {
    this.skipWhitespace();
    if (this.index < this.input.length) {
      throw new Error(`无法识别的字符：${this.input[this.index]}`);
    }
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      this.skipWhitespace();
      const char = this.input[this.index];
      if (char === '*') {
        this.index += 1;
        value *= this.parseFactor();
      } else if (char === '/') {
        this.index += 1;
        const divisor = this.parseFactor();
        if (divisor === 0) {
          throw new Error('除零错误');
        }
        value /= divisor;
      } else {
        return value;
      }
    }
  }

  private parseFactor(): number {
    this.skipWhitespace();
    const char = this.input[this.index];
    if (char === '+') {
      this.index += 1;
      return this.parseFactor();
    }
    if (char === '-') {
      this.index += 1;
      return -this.parseFactor();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();
    const char = this.input[this.index];
    if (char === '(') {
      this.index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.input[this.index] !== ')') {
        throw new Error('缺少右括号');
      }
      this.index += 1;
      return value;
    }

    const start = this.index;
    while (this.index < this.input.length && /[0-9.]/.test(this.input[this.index]!)) {
      this.index += 1;
    }
    if (start === this.index) {
      throw new Error(`无法识别的字符：${char ?? '表达式末尾'}`);
    }
    const text = this.input.slice(start, this.index);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text)) {
      throw new Error(`非法数字：${text}`);
    }
    return Number(text);
  }

  private skipWhitespace(): void {
    while (this.index < this.input.length && /\s/.test(this.input[this.index]!)) {
      this.index += 1;
    }
  }
}
