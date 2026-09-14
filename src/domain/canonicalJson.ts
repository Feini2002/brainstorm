/**
 * Stable JSON serialization for hashing.
 *
 * Contract (docs/03_contracts/03_dto_and_version_rules.md §5): object keys are
 * sorted lexicographically at every depth, arrays keep their semantic order, and
 * values that cannot be represented deterministically are rejected instead of
 * silently coerced. Only validated plain data may reach this function.
 */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue = JsonPrimitive | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

export function canonicalJson(value: unknown): string {
  return write(value, new Set<object>());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return JSON.stringify(value as string);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'bigint') throw new CanonicalJsonError('BigInt is not canonical JSON');
  if (type === 'function' || type === 'symbol') {
    throw new CanonicalJsonError(`${type} is not canonical JSON`);
  }
  if (type === 'number') {
    const num = value as number;
    if (!Number.isFinite(num)) throw new CanonicalJsonError('NaN/Infinity is not canonical JSON');
    if (Number.isInteger(num) && Math.abs(num) <= Number.MAX_SAFE_INTEGER) return String(num);
    return JSON.stringify(num);
  }
  if (type === 'undefined') throw new CanonicalJsonError('undefined is not canonical JSON');
  if (type !== 'object') throw new CanonicalJsonError(`unsupported value type: ${type}`);

  const object = value as object;
  if (seen.has(object)) throw new CanonicalJsonError('circular reference is not canonical JSON');
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => write(entry, seen)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError('only plain objects are canonical JSON');
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) throw new CanonicalJsonError(`undefined property is not canonical JSON: ${key}`);
      parts.push(`${JSON.stringify(key)}:${write(entry, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(object);
  }
}
