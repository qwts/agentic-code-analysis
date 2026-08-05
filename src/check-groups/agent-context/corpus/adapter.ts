// The convention-adapter port and the small helpers every adapter shares.
// An adapter is a pure function over an immutable snapshot: it names the
// candidates its tool documents, builds complete bindings (with fragment
// estimates via the injected estimator), and degrades anything its source
// docs do not define to `unverified`/`unknown` plus a diagnostic — never a
// guess (design doc, convention matrix).
import type { Activation, Fragment, Origin, SemanticsEvidence, TokenEstimate, ToolBinding } from './model.ts';
import type { TreeSnapshot } from './tree.ts';

export type Estimate = (text: string) => TokenEstimate;

export interface CandidateBinding {
  path: string;
  binding: ToolBinding;
  diagnostics?: string[];
}

export interface InstructionConvention {
  id: string;
  discover(snapshot: TreeSnapshot, origin: Origin, estimate: Estimate): CandidateBinding[];
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function verified(source: string, verifiedAt = '2026-08-04'): SemanticsEvidence {
  return { status: 'verified', source, verifiedAt };
}

export function unverified(reason: string): SemanticsEvidence {
  return { status: 'unverified', reason };
}

export function fragment(kind: Fragment['kind'], activation: Activation, text: string, estimate: Estimate): Fragment {
  return { kind, activation, text, estimate: estimate(text) };
}
