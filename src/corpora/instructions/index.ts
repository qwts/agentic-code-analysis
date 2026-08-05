// Public facade of the instruction-corpus library
// (docs/design/instruction-corpus.md). Two operations plus the data model;
// nothing else in this directory is part of the contract.

export { discoverInstructionCorpus } from './discover.ts';
export { resolveInstructionSession } from './cascade.ts';
export { defaultEstimator, DEFAULT_ESTIMATOR_ID } from './token-estimate.ts';
export { SESSION_PROFILES } from './model.ts';
export type {
  ActivationPhase,
  Cadence,
  ConflictPolicy,
  ContentKind,
  ContentProjection,
  CorpusConfig,
  CorpusDiagnostic,
  CorpusRequest,
  CorpusRootSpec,
  InstructionBinding,
  InstructionCorpus,
  InstructionFile,
  OrderRelation,
  ProjectionKind,
  ScopePredicate,
  SemanticsEvidence,
  SessionContribution,
  SessionLoadSet,
  SessionProfileId,
  SessionScenario,
  TokenEstimate,
} from './model.ts';
export type { CorpusDeps, FileSystemPort, TokenEstimator } from './ports.ts';
