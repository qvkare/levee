// Append-only JSONL files for raw archive reads. A killed run keeps what it fetched.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { RAW_DIR } from '../paths.ts';

export const rawFile = (...parts: string[]): string => join(RAW_DIR, ...parts);

export async function* eachLine<T>(path: string): AsyncGenerator<T> {
  if (!existsSync(path)) return;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) yield JSON.parse(line) as T;
  }
}

export function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n');
}
