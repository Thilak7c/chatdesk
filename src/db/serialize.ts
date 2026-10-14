// Drizzle returns camelCase rows with Date objects; the browser code
// (see src/types) and the public API speak snake_case with ISO-string
// timestamps. These helpers convert at the response boundary.

type CamelToSnake<S extends string> = S extends `${infer H}${infer T}`
  ? H extends Lowercase<H>
    ? `${H}${CamelToSnake<T>}`
    : `_${Lowercase<H>}${CamelToSnake<T>}`
  : S;

type Jsonish<V> = V extends Date ? string : V extends Date | null ? string | null : V;

export type Snake<T> = {
  [K in keyof T as K extends string ? CamelToSnake<K> : K]: Jsonish<T[K]>;
};

const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Shallow camelCase → snake_case conversion for one row; Dates become ISO strings. */
export function toSnake<T extends Record<string, unknown>>(row: T): Snake<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[camelToSnake(k)] = v instanceof Date ? v.toISOString() : v;
  }
  return out as Snake<T>;
}

/** `toSnake` over an array. */
export function toSnakeRows<T extends Record<string, unknown>>(rows: T[]): Snake<T>[] {
  return rows.map(toSnake);
}
