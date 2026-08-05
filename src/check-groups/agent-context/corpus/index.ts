// Public facade of the instruction-corpus library (ACA-0023): the narrow,
// data-only API the agent-context checks consume. Judgment-free by contract
// — this package must never export or import a JudgeClient, verdict, cache,
// check, CLI, or provider concept.
export { buildInstructionCorpus, type CorpusRequest, type UserRoot } from './discover.ts';
export { loadSetsForDir, loadSetsUnder } from './cascade.ts';
export { referenceEstimator, type TokenEstimator } from './tokens.ts';
export { snapshotFromMap, walkTree, type TreeSnapshot } from './tree.ts';
export type {
  Activation,
  Fragment,
  InstructionCorpus,
  InstructionSource,
  LoadEntry,
  Origin,
  SemanticsEvidence,
  SessionLoadSet,
  TokenEstimate,
  Tool,
  ToolBinding,
} from './model.ts';
