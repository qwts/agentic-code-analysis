// Shared builders for the agent-rule-conflict suite: a synthetic corpus
// factory (bindings with controllable profiles, scopes, and conflict
// policies), a counting fake JudgeClient, and reply shorthands.
import type { JudgeClient, JudgeRequest, JudgeResult } from '../src/core/judge-client.ts';
import type {
  InstructionBinding,
  InstructionCorpus,
  InstructionFile,
  SessionProfileId,
} from '../src/corpora/instructions/index.ts';

export const ESTIMATOR = 'fake-words@1';

const estimate = (text: string) => ({
  count: text === '' ? 0 : text.split(/\s+/).filter(Boolean).length,
  estimated: true as const,
  estimator: ESTIMATOR,
});

export function binding(over: Partial<InstructionBinding> & { profile: SessionProfileId; text: string }): InstructionBinding {
  const { text, ...rest } = over;
  return {
    tool: 'codex',
    convention: 'codex/agents-chain',
    scope: { kind: 'root' },
    activation: 'session-start',
    cadence: 'per-session',
    charged: { kind: 'whole-file', text, tokens: estimate(text) },
    order: { kind: 'ordered', rule: 'root to CWD', rank: 1 },
    conflict: 'closer-overrides',
    semantics: { status: 'verified', source: 'https://example.test', verifiedAt: '2026-08-05' },
    ...rest,
  };
}

export function file(path: string, content: string, bindings: InstructionBinding[]): InstructionFile {
  return {
    locator: `repo:${path}`,
    origin: 'repo',
    path,
    content,
    contentKind: 'markdown',
    fullFile: estimate(content),
    bindings,
  };
}

export function corpus(files: InstructionFile[], profiles?: SessionProfileId[]): InstructionCorpus {
  return {
    roots: [{ id: 'repo', kind: 'repository', path: '/repo' }],
    files,
    profiles: profiles ?? [...new Set(files.flatMap((f) => f.bindings.map((b) => b.profile)))],
    diagnostics: [],
    estimator: ESTIMATOR,
    config: {},
  };
}

export interface FakeJudge extends JudgeClient {
  requests: JudgeRequest[];
}

/** Replies in order; repeats the last one when calls exceed the queue. */
export function fakeClient(replies: JudgeResult[]): FakeJudge {
  const requests: JudgeRequest[] = [];
  return {
    provider: 'fake',
    model: 'fake-model',
    requests,
    judge: async (request) => {
      requests.push(request);
      return replies[Math.min(requests.length - 1, replies.length - 1)] ?? { ok: false, note: 'no reply queued' };
    },
  };
}

export function memoryCache(): { get(key: string): unknown; set(key: string, value: unknown): void; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return { store, get: (key) => store.get(key), set: (key, value) => store.set(key, value) };
}

export const reply = (verdict: unknown): JudgeResult => ({ ok: true, verdict });

export function conflictsFound(conflicts: unknown[], reasoning = 'rs'): JudgeResult {
  return reply({ assessment: 'conflicts-found', conflicts, reasoning_summary: reasoning });
}

export const noConflict = (): JudgeResult => reply({ assessment: 'no-conflict', conflicts: [], reasoning_summary: 'coherent' });
