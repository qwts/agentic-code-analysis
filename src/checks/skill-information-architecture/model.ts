// Data model for one corpus-bound Agent Skill package. Mechanical topology,
// workload evidence, judge proposals, and host-derived measurements stay
// explicit so model-authored arithmetic can never enter the result.
import type { ActivationPhase, CorpusDiagnostic, InstructionBinding, SessionProfileId } from '../../corpora/instructions/index.ts';

export type Basis = 'workload-grounded' | 'cohesion-only';
export type Assessment = 'well-structured' | 'needs-restructure' | 'uncertain';
export type Criterion =
  | 'buried-core-guidance'
  | 'fragmented-core-workflow'
  | 'eager-specialist-detail'
  | 'weak-disclosure-route';
export type Action = 'move-earlier' | 'co-locate' | 'extract-resource' | 'inline-core' | 'add-route';

export interface SkillSection {
  readonly heading: string;
  readonly level: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type RouteStatus = 'resolved' | 'missing' | 'external' | 'escapes-package' | 'fragment' | 'target-unverifiable';

export interface SkillRoute {
  readonly sourcePath: string;
  readonly excerpt: string;
  readonly target: string;
  readonly resolvedPath?: string;
  readonly status: RouteStatus;
  readonly cue: string;
}

export interface SkillLoad {
  readonly profile: SessionProfileId;
  readonly tool: InstructionBinding['tool'];
  readonly convention: string;
  readonly activation: ActivationPhase;
  readonly projection: 'metadata' | 'body';
  readonly tokens: number;
}

export interface SkillResource {
  readonly path: string;
  readonly locator: string;
  readonly content: string;
  readonly available: boolean;
  readonly opaque: boolean;
  readonly potentialTokens?: number;
  readonly diagnostics: readonly string[];
}

export interface SkillPackage {
  readonly packageId: string;
  readonly packageDir: string;
  readonly skillFile: string;
  readonly locator: string;
  readonly body: string;
  readonly bodyTokens: number;
  readonly metadataText: string;
  readonly metadataTokens: number;
  readonly sections: readonly SkillSection[];
  readonly routes: readonly SkillRoute[];
  readonly loads: readonly SkillLoad[];
  readonly resources: readonly SkillResource[];
  readonly diagnostics: readonly CorpusDiagnostic[];
  readonly complete: boolean;
}

export interface TaskScenario {
  readonly id: string;
  readonly description: string;
  readonly profile?: SessionProfileId;
  readonly frequency?: number;
  readonly value?: number;
  readonly critical: boolean;
  readonly requiredConcepts: readonly string[];
  readonly expectedResources: readonly string[];
  readonly observedReads: readonly string[];
}

export interface TaskEvidence {
  readonly schemaVersion: 1;
  readonly basis: Basis;
  readonly scenarios: readonly TaskScenario[];
}

export interface PayloadOmission {
  readonly path: string;
  readonly reason: 'input-bound' | 'unavailable' | 'opaque';
  readonly chars: number;
}

export interface PackagePayload {
  readonly text: string;
  readonly omissions: readonly PayloadOmission[];
  readonly complete: boolean;
}

export interface ProposedEdit {
  readonly operation: 'add' | 'delete' | 'replace';
  readonly path: string;
  readonly excerpt: string;
  readonly replacement: string;
}

export interface TopologyDelta {
  readonly activatedBodyTokensBefore: number;
  readonly activatedBodyTokensAfter: number;
  readonly conditionalTokensBefore: number;
  readonly conditionalTokensAfter: number;
  readonly resourceOpensDelta: number;
}

export interface VerifiedFinding {
  readonly criterion: Criterion;
  readonly severity: 'high' | 'medium' | 'low';
  readonly sourcePath: string;
  readonly heading: string;
  readonly excerpt: string;
  readonly scenarioIds: readonly string[];
  readonly action: Action;
  readonly destinationPath: string;
  readonly destinationSection: string;
  readonly proposalText: string;
  readonly preserve: readonly string[];
  readonly rationale: string;
  readonly affectedScenarioPercent?: number;
  readonly delta: TopologyDelta;
  readonly edits: readonly ProposedEdit[];
}

export interface MeasurementSeed {
  readonly scenarioId: string;
  readonly cohort: 'common' | 'specialist' | 'critical' | 'unspecified';
  readonly expectedResources: readonly string[];
  readonly metrics: readonly [
    'task-success',
    'activated-body-tokens',
    'total-loaded-tokens',
    'resource-opens',
    'required-read-recall',
    'unnecessary-read-rate',
    'success-per-1k-loaded-tokens',
  ];
}
