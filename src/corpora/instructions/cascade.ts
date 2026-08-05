// Pure session resolution: classify every binding of one profile against a
// concrete scenario into confirmed contributions (documented order,
// deterministic totals) and possible additions (with the reason each one
// is conditional). Never sums mutually exclusive trigger combinations
// (docs/design/instruction-corpus.md, 'Session resolution').

import type {
  InstructionBinding,
  InstructionCorpus,
  SessionContribution,
  SessionLoadSet,
  SessionScenario,
} from './model.ts';
import { CODEX_DEFAULT_MAX_BYTES } from './conventions/codex.ts';
import { isWithin, normalizeDir } from './paths.ts';
import { sumEstimates } from './token-estimate.ts';

/** Full-path glob match supporting `**`, `*`, `?`, and `{a,b}` groups. */
export function matchGlob(glob: string, path: string): boolean {
  for (const expanded of expandBraces(glob, 100)) {
    if (globToRegExp(expanded).test(path)) return true;
  }
  return false;
}

function expandBraces(glob: string, cap: number): readonly string[] {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (match === null || match[1] === undefined) return [glob];
  const results: string[] = [];
  for (const option of match[1].split(',')) {
    const expanded = expandBraces(
      glob.slice(0, match.index) + option + glob.slice(match.index + match[0].length),
      cap,
    );
    results.push(...expanded);
    // Over the cap the glob is used unexpanded (matches nothing useful),
    // mirroring the documented budget behavior rather than exploding.
    if (results.length > cap) return [glob.replaceAll('{', "\\{")];
  }
  return results;
}

function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        // `**/` may match zero directories; bare `**` crosses separators.
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else if (char !== undefined && /[.+^$()|[\]\\{}]/.test(char)) {
      pattern += `\\${char}`;
    } else if (char !== undefined) {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

type ScopeStatus =
  | { readonly state: 'active' }
  | { readonly state: 'conditional'; readonly reason: string }
  | { readonly state: 'excluded' };

function resolveScope(
  binding: InstructionBinding,
  locator: string,
  scenario: SessionScenario,
): ScopeStatus {
  const cwd = normalizeDir(scenario.cwd ?? '');
  const touched = scenario.touchedPaths ?? [];
  const scope = binding.scope;
  switch (scope.kind) {
    case 'always':
    case 'root':
      return { state: 'active' };
    case 'directory-subtree': {
      const cwdInside =
        scope.directory === '' || (cwd !== '' && isWithin(scope.directory, cwd));
      const touchedInside = touched.some((path) => isWithin(scope.directory, path));
      if (scope.via === 'cwd') {
        return cwdInside ? { state: 'active' } : { state: 'excluded' };
      }
      if (scope.via === 'touched') {
        return touchedInside
          ? { state: 'active' }
          : { state: 'conditional', reason: `no touched path under ${scope.directory}/` };
      }
      if (cwdInside || touchedInside) return { state: 'active' };
      return { state: 'conditional', reason: `CWD outside and no touched path under ${scope.directory}/` };
    }
    case 'glob': {
      const hit = touched.some((path) => scope.globs.some((glob) => matchGlob(glob, path)));
      return hit
        ? { state: 'active' }
        : { state: 'conditional', reason: `no touched path matches ${scope.globs.join(', ')}` };
    }
    case 'unresolved': {
      if (
        binding.convention.endsWith('import-external') &&
        (scenario.acceptedExternalImports ?? []).includes(locator)
      ) {
        return { state: 'active' };
      }
      return { state: 'conditional', reason: scope.reason };
    }
  }
}

type ActivationStatus =
  | { readonly state: 'met' }
  | { readonly state: 'conditional'; readonly reason: string };

function resolveActivation(
  binding: InstructionBinding,
  locator: string,
  scenario: SessionScenario,
  scope: ScopeStatus,
): ActivationStatus {
  switch (binding.activation) {
    case 'session-start':
      return { state: 'met' };
    case 'on-path-access':
      // The trigger is the scope itself (a touched path or glob hit).
      return scope.state === 'active'
        ? { state: 'met' }
        : { state: 'conditional', reason: 'path trigger not in scenario' };
    case 'model-decision':
      return (scenario.modelSelected ?? []).includes(locator)
        ? { state: 'met' }
        : { state: 'conditional', reason: 'model-decision body not in scenario.modelSelected' };
    case 'on-invocation':
      return (scenario.invoked ?? []).includes(locator)
        ? { state: 'met' }
        : { state: 'conditional', reason: 'not invoked in this scenario' };
    case 'on-demand-resource':
      return { state: 'conditional', reason: 'resource loads on demand' };
    case 'unresolved': {
      // External imports become deterministic once accepted.
      if (
        binding.convention.endsWith('import-external') &&
        (scenario.acceptedExternalImports ?? []).includes(locator)
      ) {
        return { state: 'met' };
      }
      return { state: 'conditional', reason: 'activation unresolved' };
    }
  }
}

export function resolveInstructionSession(
  corpus: InstructionCorpus,
  scenario: SessionScenario,
): SessionLoadSet {
  const confirmed: { contribution: SessionContribution; rank: number; ordered: boolean }[] = [];
  const possible: SessionContribution[] = [];
  const diagnostics: string[] = [];
  let unresolvedSemantics = false;

  for (const file of corpus.files) {
    for (const binding of file.bindings) {
      if (binding.profile !== scenario.profile) continue;
      const contributionBase: SessionContribution = {
        locator: file.locator,
        convention: binding.convention,
        activation: binding.activation,
        cadence: binding.cadence,
        charged: binding.charged.tokens,
      };
      if (binding.semantics.status !== 'verified') {
        unresolvedSemantics = true;
        possible.push({
          ...contributionBase,
          condition: `semantics ${binding.semantics.status}: ${binding.semantics.reason}`,
        });
        continue;
      }
      const scope = resolveScope(binding, file.locator, scenario);
      if (scope.state === 'excluded') continue;
      const activation = resolveActivation(binding, file.locator, scenario, scope);
      if (scope.state === 'active' && activation.state === 'met') {
        if (binding.activation === 'unresolved' || binding.scope.kind === 'unresolved') {
          // Accepted external import: deterministic but flag its origin.
          diagnostics.push(`${file.locator}: confirmed via scenario.acceptedExternalImports`);
        }
        confirmed.push({
          contribution: contributionBase,
          rank: binding.order.kind === 'ordered' ? binding.order.rank : Number.MAX_SAFE_INTEGER,
          ordered: binding.order.kind === 'ordered',
        });
        if (binding.order.kind === 'unresolved') {
          unresolvedSemantics = true;
          diagnostics.push(`${file.locator}: load order unresolved (${binding.order.reason})`);
        }
      } else {
        const reasons = [
          ...(scope.state === 'conditional' ? [scope.reason] : []),
          ...(activation.state === 'conditional' ? [activation.reason] : []),
        ];
        if (binding.activation === 'unresolved' || binding.scope.kind === 'unresolved') {
          if (!binding.convention.endsWith('import-external')) unresolvedSemantics = true;
        }
        possible.push({ ...contributionBase, condition: reasons.join('; ') });
      }
    }
  }

  confirmed.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.contribution.locator.localeCompare(b.contribution.locator) ||
      a.contribution.convention.localeCompare(b.contribution.convention),
  );

  let contributions = confirmed.map((entry) => entry.contribution);

  // Codex combined-size cap: charged whole, in chain order, until the next
  // file would cross the cap; the rest of the chain is deterministically
  // excluded.
  if (scenario.profile === 'codex-local') {
    const cap = corpus.config.codexProjectDocMaxBytes ?? CODEX_DEFAULT_MAX_BYTES;
    const encoder = new TextEncoder();
    const kept: SessionContribution[] = [];
    let bytes = 0;
    for (const contribution of contributions) {
      if (contribution.convention !== 'codex/agents-chain') {
        kept.push(contribution);
        continue;
      }
      const file = corpus.files.find((entry) => entry.locator === contribution.locator);
      const binding = file?.bindings.find(
        (entry) => entry.profile === 'codex-local' && entry.convention === 'codex/agents-chain',
      );
      const size = encoder.encode(binding?.charged.text ?? '').length;
      if (bytes + size > cap) {
        diagnostics.push(
          `${contribution.locator}: excluded — combined instructions reach project_doc_max_bytes (${cap})`,
        );
        continue;
      }
      bytes += size;
      kept.push(contribution);
    }
    contributions = kept;
  }

  const complete = possible.length === 0 && !unresolvedSemantics;
  if (!complete && possible.length > 0) {
    diagnostics.push(
      `${possible.length} conditional contribution(s); the confirmed subtotal is a floor, not the session total`,
    );
  }

  return {
    scenario,
    contributions,
    confirmedTokens: sumEstimates(
      corpus.estimator,
      contributions.map((contribution) => contribution.charged),
    ),
    possibleAdditional: possible.toSorted(
      (a, b) => a.locator.localeCompare(b.locator) || a.convention.localeCompare(b.convention),
    ),
    complete,
    diagnostics,
  };
}
