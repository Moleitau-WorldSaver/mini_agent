import type { ToolDefinition } from '../types.js';

const CELSIUS_BY_CITY: Record<string, number> = {
  北京: 26,
  上海: 28,
  广州: 30,
  深圳: 29,
  杭州: 24,
};

export const weatherTool: ToolDefinition = {
  name: 'weather',
  description: '查询城市当前天气（mock）。支持北京、上海、广州、深圳、杭州，可选择摄氏或华氏。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', minLength: 1 },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
    required: ['city'],
    additionalProperties: false,
  },
  async execute(args) {
    const { city, unit } = args as { city: string; unit?: 'celsius' | 'fahrenheit' };
    const celsius = CELSIUS_BY_CITY[city];
    if (celsius === undefined) {
      throw new Error(`未知城市：${city}。支持的城市：${Object.keys(CELSIUS_BY_CITY).join('、')}`);
    }

    const selectedUnit = unit ?? 'celsius';
    const temperature = selectedUnit === 'fahrenheit' ? Math.round((celsius * 9) / 5 + 32) : celsius;

    return {
      content: JSON.stringify({ city, temperature, unit: selectedUnit }),
      isError: false,
    };
  },
};
