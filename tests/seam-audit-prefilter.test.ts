import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provenLeaf } from '../src/checks/seam-audit/prefilter.ts';

test('declarative leaf forms are proven: literals, types, interfaces, export lists', () => {
  const proven = [
    '',
    '// just a comment\n/* and a block */\n',
    "export const NAME = 'aca';\nexport const LIMIT = 3;\n",
    'const NEGATIVE = -1;\nexport const FLAGS = { retry: true, attempts: 3, label: "x" };\n',
    "export const LIST = ['a', 'b', 'c'] as const;\n",
    'export const TABLE: Record<string, number> = { a: 1, b: 2 };\n',
    'export type Verdict = "pass" | "warn" | "fail";\n',
    'type Handler = (input: string) => Promise<void>;\nexport type Pair = [string, number];\n',
    'export interface Route {\n  provider: string;\n  judge(request: string): Promise<string>;\n}\n',
    'interface Empty {}\nexport interface Extended extends Empty { a: number }\n',
    'const A = 1;\nconst B = 2;\nexport { A, B as RENAMED };\n',
    'export default { name: "config", retries: 2 };\n',
    'export const TEMPLATE = `no interpolation here`;\n',
  ];
  for (const content of proven) {
    assert.equal(provenLeaf(content), true, `should prove: ${JSON.stringify(content)}`);
  }
});

test('import-free ambient access never bypasses the judge', () => {
  const unproven = [
    'export const NOW = Date.now();\n',
    'export const SEED = Math.random();\n',
    'const data = fetch("https://example.com");\n',
    'export const KEY = process.env.API_KEY;\n',
    'export const G = globalThis.thing;\n',
    'export const CLIENT = new Client("key");\n',
    'const handle = setTimeout(() => {}, 5);\n',
    'export const REF = Date;\n', // capturing an ambient binding is still reaching for it
  ];
  for (const content of unproven) {
    assert.equal(provenLeaf(content), false, `must judge: ${JSON.stringify(content)}`);
  }
});

test('dependency acquisition in any form never bypasses the judge', () => {
  const unproven = [
    "import { x } from './x.ts';\nexport const y = 1;\n",
    "import './side-effect.ts';\n",
    "export { x } from './x.ts';\n",
    "export * from './x.ts';\n",
    "const mod = await import('./x.ts');\n",
    "const cjs = require('./x.ts');\n",
    "import type { T } from './x.ts';\nexport type U = T;\n",
  ];
  for (const content of unproven) {
    assert.equal(provenLeaf(content), false, `must judge: ${JSON.stringify(content)}`);
  }
});

test('executable module initializers and unknown syntax never bypass the judge', () => {
  const unproven = [
    'initialize();\n',
    'export const SUM = add(1, 2);\n',
    'export function pure(a: number, b: number): number { return a + b; }\n', // body analysis is judgment
    'export class Thing {}\n',
    'enum Color { Red, Green }\n',
    'export const T = `computed ${value}`;\n',
    'let mutable = 1;\nexport { mutable };\n',
    'const { a, b } = source;\n',
    'export const WEIRD = 1 +;\n', // junk syntax: unproven, not a crash
    'type X = Y\nsneaky()\n', // ASI: a missing semicolon must not swallow a call into type text
  ];
  for (const content of unproven) {
    assert.equal(provenLeaf(content), false, `must judge: ${JSON.stringify(content)}`);
  }
});
