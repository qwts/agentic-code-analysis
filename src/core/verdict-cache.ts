// Content-addressed verdict memoization (ACA-0003 D7). The key is built from
// every semantic input to a verdict — file content, sorted import edges, rule
// text, prompt version, provider, model — so a hit is provably the same
// judgment. Serialized as a JSON array so component boundaries can never
// collide the way plain concatenation could.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class VerdictCache {
  readonly dir: string;

  constructor(cacheRoot: string, checkName: string) {
    this.dir = join(cacheRoot, checkName);
  }

  static key(components: readonly string[]): string {
    return createHash('sha256').update(JSON.stringify(components)).digest('hex');
  }

  get(key: string): unknown | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value));
  }
}
