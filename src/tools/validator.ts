import type { JsonSchema } from '../types.js';

const ALLOWED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'items',
  'additionalProperties',
]);

const ALLOWED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function assertSupportedSchema(schema: JsonSchema, path = 'schema'): void {
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      throw new Error(`不支持的 schema 字段：${path}.${key}`);
    }
  }
  if (schema.type !== undefined && !ALLOWED_TYPES.has(schema.type)) {
    throw new Error(`不支持的 schema 类型：${path}.${schema.type}`);
  }
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSupportedSchema(child, `${path}.properties.${key}`);
    }
  }
  if (schema.items) {
    assertSupportedSchema(schema.items, `${path}.items`);
  }
}

export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult {
  const error = validateValue(schema, args, '参数');
  return error === null ? { ok: true } : { ok: false, error };
}

function validateValue(schema: JsonSchema, value: unknown, path: string): string | null {
  if (schema.enum && !schema.enum.some((item) => item === value)) {
    return `${path} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join('、')} 之一`;
  }

  switch (schema.type) {
    case 'object':
      return validateObject(schema, value, path);
    case 'string':
      return validateString(schema, value, path);
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${path} 应为数字`;
      }
      return checkRange(schema, value, path);
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return `${path} 应为整数`;
      }
      return checkRange(schema, value, path);
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} 应为布尔值`;
    case 'array':
      return validateArray(schema, value, path);
    default:
      return null;
  }
}

function validateString(schema: JsonSchema, value: unknown, path: string): string | null {
  if (typeof value !== 'string') {
    return `${path} 应为字符串`;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return `${path} 长度不能小于 ${schema.minLength}`;
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    return `${path} 长度不能超过 ${schema.maxLength}`;
  }
  return null;
}

function validateArray(schema: JsonSchema, value: unknown, path: string): string | null {
  if (!Array.isArray(value)) {
    return `${path} 应为数组`;
  }
  if (schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateValue(schema.items, value[index], `${path}[${index}]`);
      if (error !== null) {
        return error;
      }
    }
  }
  return null;
}

function validateObject(schema: JsonSchema, value: unknown, path: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} 应为对象`;
  }
  const record = value as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (!(key in record)) {
      return `缺少必填参数：${key}`;
    }
  }

  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(record)) {
      if (!(key in schema.properties)) {
        return `不支持的参数：${key}`;
      }
    }
  }

  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!(key in record)) {
        continue;
      }
      const childPath = path === '参数' ? key : `${path}.${key}`;
      const error = validateValue(child, record[key], childPath);
      if (error !== null) {
        return error;
      }
    }
  }

  return null;
}

function checkRange(schema: JsonSchema, value: number, path: string): string | null {
  if (schema.minimum !== undefined && value < schema.minimum) {
    return `${path} 不能小于 ${schema.minimum}`;
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    return `${path} 不能大于 ${schema.maximum}`;
  }
  return null;
}
