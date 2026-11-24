import { describe, expect, it } from 'vitest';
import { evaluate } from '../../src/tools/calculator.js';

describe('calculator', () => {
  it.each<[string, number]>([
    ['1+2', 3],
    ['1.5*(3+4)-2', 8.5],
    ['-2+3*4', 10],
    ['2*(3+(4-1))', 12],
    ['10/4', 2.5],
    ['0.5 + .5', 1],
    ['-(2+3)', -5],
  ])('evaluates %s', (expression, expected) => {
    expect(evaluate(expression)).toBeCloseTo(expected, 10);
  });

  it.each<[string, string]>([
    ['1/0', '除零'],
    ['2+', '无法识别'],
    ['(1+2', '右括号'],
    ['abc', '无法识别'],
    ['2^3', '无法识别'],
    ['1.2.3', '非法数字'],
    ['', '无法识别'],
  ])('rejects %s', (expression, message) => {
    expect(() => evaluate(expression)).toThrow(new RegExp(message));
  });

  it('rejects expressions longer than the schema limit', () => {
    expect(() => evaluate(`1+${'1+'.repeat(100)}1`)).toThrow(/过长/);
  });
});
