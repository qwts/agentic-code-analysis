// The check contract and the registry the dispatcher routes through. Adding a
// check means one new entry here and one new directory under src/checks/ —
// checks never import each other (ACA-0003 D1).
import type { Tier } from '../core/config.ts';
import type { JudgeClient } from '../core/judge-client.ts';
import type { VerdictCache } from '../core/verdict-cache.ts';

export type Verdict = 'pass' | 'warn' | 'fail';

export interface Violation {
  criterion: string;
  evidence: string;
  suggestion: string;
}

export interface FileVerdict {
  file: string;
  verdict: Verdict;
  cached: boolean;
  violations: Violation[];
  note?: string;
}

export interface CheckContext {
  repoRoot: string;
  baseRef: string;
  files: string[];
  client: JudgeClient;
  cache: VerdictCache;
}

export interface SelfTestResult {
  passed: boolean;
  lines: string[];
}

export interface Check {
  name: string;
  tier: Tier;
  run(context: CheckContext): Promise<FileVerdict[]>;
  /** Calibration against golden fixtures (ACA-0004 D8); always live, never cached. */
  selfTest?(client: JudgeClient): Promise<SelfTestResult>;
}

export type CheckLoader = () => Promise<Check>;

export const checks: ReadonlyMap<string, CheckLoader> = new Map([
  ['commit-coherence', async () => (await import('./commit-coherence/index.ts')).check],
  ['context-footprint', async () => (await import('./context-footprint/index.ts')).check],
  ['failure-posture', async () => (await import('./failure-posture/index.ts')).check],
  ['seam-audit', async () => (await import('./seam-audit/index.ts')).check],
  ['test-honesty', async () => (await import('./test-honesty/index.ts')).check],
  ['naming-truth', async () => (await import('./naming-truth/index.ts')).check],
  ['review-readiness', async () => (await import('./review-readiness/index.ts')).check],
  ['single-responsibility', async () => (await import('./single-responsibility/index.ts')).check],
  ['doc-drift', async () => (await import('./doc-drift/index.ts')).check],
]);
