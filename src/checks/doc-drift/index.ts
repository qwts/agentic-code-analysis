// The doc-drift check: orchestrates the doc corpus, the check-local change
// index, reference extraction, evidence bundles, the verdict cache, and the
// judge (check design: one request per candidate document, concurrency 3,
// max_tokens per judge-io's MAX_TOKENS). Only candidate documents — at
// least one explicit reference intersecting a changed referent — produce
// verdicts; the output never claims all documentation is current.
import { readFileSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import type { Check, CheckContext, FileVerdict } from '../registry.ts';
import { filterScope } from '../../core/change-scope.ts';
import { loadConfig } from '../../core/config.ts';
import { VerdictCache } from '../../core/verdict-cache.ts';
import { buildChangeIndex, trackedFiles } from './change-index.ts';
import { buildEvidence, type EvidenceBundle } from './evidence.ts';
import {
  EXTRACTION_VERSION,
  judgeOutcome,
  MAX_TOKENS,
  PROMPT_VERSION,
  rubricText,
  systemPrompt,
  userPrompt,
  VERDICT_SCHEMA,
  type DocDriftVerdict,
} from './judge-io.ts';
import { CONCURRENCY, mapPool } from './pool.ts';
import { extractReferences, SCAN_MODE } from './references.ts';
import { discoverDocs, loadDocDriftScope } from './scope.ts';
import { selfTest } from './self-test.ts';

/**
 * Every semantic input to this document's truth judgment (check design,
 * "cache identity"): versions, document identity and content, the sorted
 * reference records, each selected referent's identity/status/content or
 * absent marker, rubric, provider, model. Doc globs, base ref/SHA, and
 * unrelated changed paths are excluded — they select work, they do not
 * affect this document's truth.
 */
function cacheKey(docPath: string, docContent: string, bundle: EvidenceBundle, rubric: string, provider: string, model: string): string {
  const referents = bundle.referents.flatMap((r) => [r.path, r.status, r.renamedTo ?? '', r.content ?? '(absent)']);
  return VerdictCache.key([PROMPT_VERSION, String(MAX_TOKENS), EXTRACTION_VERSION, docPath, docContent, JSON.stringify(bundle.references), ...referents, rubric, provider, model]);
}

async function run(context: CheckContext): Promise<FileVerdict[]> {
  const rubric = rubricText();
  const system = systemPrompt(rubric);
  const globalConfig = loadConfig(context.repoRoot);
  const docs = discoverDocs(trackedFiles(context.repoRoot), loadDocDriftScope(context.repoRoot));
  // Seeds are changed-referent paths, not documents (check design): the
  // dispatcher's diff selection — or explicit CLI paths — normalized to the
  // repo-relative posix form the index and the extractor share.
  const seeds = [...new Set(context.files.map((file) => normalize(file).split(sep).join('/')))];
  const index = buildChangeIndex(context.repoRoot, context.baseRef, seeds, (paths) => filterScope(paths, globalConfig));

  interface Candidate {
    doc: string;
    content: string;
    bundle: EvidenceBundle;
  }
  const candidates: Candidate[] = [];
  for (const doc of docs) {
    let content: string;
    try {
      content = readFileSync(join(context.repoRoot, doc), 'utf8');
    } catch {
      continue; // a doc that cannot be read cannot make claims to judge
    }
    const bundle = buildEvidence(extractReferences(doc, content), index);
    if (bundle.references.length > 0) candidates.push({ doc, content, bundle });
  }

  return mapPool(candidates, CONCURRENCY, async ({ doc, content, bundle }) => {
    const audit = {
      scanMode: SCAN_MODE,
      references: bundle.references,
      referents: bundle.referents.map(({ content: _content, ...rest }) => rest),
    } as const;
    // Bounded evidence and unreadable referents degrade explicitly and are
    // never cached — the next run retries with better evidence.
    if (bundle.unreadable.length > 0) {
      return { file: doc, verdict: 'warn', cached: false, violations: [], note: `referent unreadable: ${bundle.unreadable.join(', ')}`, ...audit } satisfies DocDriftVerdict;
    }
    if (bundle.overflow !== undefined) {
      return { file: doc, verdict: 'warn', cached: false, violations: [], note: `evidence overflow: ${bundle.overflow}`, ...audit } satisfies DocDriftVerdict;
    }
    const key = cacheKey(doc, content, bundle, rubric, context.client.provider, context.client.model);
    const hit = context.cache.get(key) as DocDriftVerdict | undefined;
    if (hit) return { ...hit, file: doc, cached: true };
    const result = await context.client.judge({ system, user: userPrompt(doc, content, bundle), schema: VERDICT_SCHEMA, maxTokens: MAX_TOKENS });
    const { verdict, cacheable } = judgeOutcome(doc, bundle, result);
    if (cacheable) context.cache.set(key, verdict);
    return verdict;
  });
}

export const check: Check = {
  name: 'doc-drift',
  tier: 'T1',
  run,
  selfTest,
};
