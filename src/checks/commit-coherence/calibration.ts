// Pure calibration logic for commit-coherence: validation of the
// check-local manifest extensions (split expectation groups, the
// larger-pass size invariant) and the split-grouping oracle. The oracle
// asserts semantic grouping — each expected anchor set lands in its own
// distinct proposed part — never prose, part order, or exact unit lists.
// Validation mirrors the ACA-0020 manifest discipline: a malformed package
// is a configuration error before any judge call, never a judge miss.
import { ConfigError } from '../../core/config.ts';
import type { PairManifest } from '../pair-fixtures.ts';
import type { SplitPart } from './judge-io.ts';

export interface SplitExpectation {
  /** Anchor sets that must land in distinct parts of the proposal. */
  groups: { anchors: string[] }[];
}

export interface SizeInvariant {
  larger: string;
  smaller: string;
}

export interface CoherenceExtras {
  sizeInvariant: SizeInvariant;
  /** By fixture name; present for every fail-expecting fixture. */
  splits: Map<string, SplitExpectation>;
}

function fail(detail: string): never {
  throw new ConfigError(`commit-coherence manifest: ${detail}`);
}

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v !== '');

/**
 * Validate the check-local fields riding on the shared pair manifest (the
 * shared validator ignores unknown fields by design): `sizeInvariant` at the
 * top level, `split` on each fail-expecting fixture.
 */
export function validateCoherenceExtras(raw: unknown, manifest: PairManifest): CoherenceExtras {
  const top = raw as { sizeInvariant?: unknown };
  const names = new Set(manifest.fixtures.map((fixture) => fixture.name));
  const invariant = top.sizeInvariant as SizeInvariant;
  if (typeof invariant !== 'object' || invariant === null) fail('sizeInvariant is required (the larger-pass invariant is the size trap)');
  if (!names.has(invariant.larger) || !names.has(invariant.smaller) || invariant.larger === invariant.smaller) {
    fail('sizeInvariant must name two distinct declared fixtures');
  }
  const splits = new Map<string, SplitExpectation>();
  for (const fixture of manifest.fixtures as (PairManifest['fixtures'][number] & { split?: unknown })[]) {
    const split = fixture.split as SplitExpectation | undefined;
    if (fixture.expect.verdict !== 'fail') {
      if (split !== undefined) fail(`fixture "${fixture.name}": split expectations belong on fail fixtures only`);
      continue;
    }
    if (typeof split !== 'object' || split === null || !Array.isArray(split.groups) || split.groups.length < 2) {
      fail(`fixture "${fixture.name}": a fail fixture needs a split with at least two groups`);
    }
    for (const group of split.groups) {
      if (typeof group !== 'object' || group === null || !stringArray(group.anchors)) {
        fail(`fixture "${fixture.name}": every split group needs non-empty string anchors`);
      }
    }
    splits.set(fixture.name, { groups: split.groups.map((group) => ({ anchors: [...group.anchors] })) });
  }
  return { sizeInvariant: { larger: invariant.larger, smaller: invariant.smaller }, splits };
}

/** Does this part claim any unit of the anchor file (whole file or hunk)? */
const partTouches = (part: SplitPart, anchor: string): boolean =>
  part.units.some((unit) => unit === anchor || unit.startsWith(`${anchor}@h`));

/**
 * The split oracle: an injective assignment of expected groups to proposed
 * parts must exist, each group's anchors all inside its part. Backtracking —
 * group and part counts are fixture-sized.
 */
export function matchSplitExpectation(expected: SplitExpectation, parts: SplitPart[]): boolean {
  const candidates = expected.groups.map((group) => parts.map((_, index) => index).filter((index) => group.anchors.every((anchor) => partTouches(parts[index]!, anchor))));
  const used = new Set<number>();
  const assign = (group: number): boolean => {
    if (group === candidates.length) return true;
    for (const index of candidates[group]!) {
      if (used.has(index)) continue;
      used.add(index);
      if (assign(group + 1)) return true;
      used.delete(index);
    }
    return false;
  };
  return assign(0);
}
