# Design: instruction-corpus library

**Status:** Accepted with [ACA-0023](../decisions/ACA-0023-agent-context-architecture.md)
(issue #23). Group-private evidence package for the agent-context checks —
judgment-free by contract: no JudgeClient, no verdict, no cache, no CLI.

## What it answers

Agent-instruction files have no standard shape: each tool has its own
discovery, activation, and precedence semantics. Every agent-context check
needs the same map. The library answers, deterministically and offline:

1. **What instruction sources exist** in an authorized set of roots?
2. **Which tool loads each one, when** (activation), **for which sessions**
   (scope), with what verification status?
3. **What does each session pay** — estimated tokens, split into baseline /
   conditional / manual?

## Public API

```ts
buildInstructionCorpus(request: CorpusRequest): InstructionCorpus
```

`CorpusRequest`: an explicit `repoRoot`, optional explicitly authorized
`userRoots` (label + path, e.g. a `~/.claude` the caller chose to include),
and an optional injected filesystem port + `TokenEstimator` for tests. The
library never calls `homedir()` and never scans anything it was not handed.

Domain records (readonly, POSIX-normalized paths, machine-independent IDs):

- `InstructionSource` — id (`repo:AGENTS.md`, `user:<label>/CLAUDE.md`),
  origin, path, exact content, sha256, whole-file `TokenEstimate`, bindings,
  diagnostics. One physical file appears once and may carry several bindings.
- `ToolBinding` — tool, convention, scope directory, optional path globs,
  activation class, delivered fragments, `SemanticsEvidence`.
- `Fragment` — the text actually delivered at a stage (`metadata` vs `body`)
  with its own activation and estimate. Required for skills and
  model-selected rules, where a description is paid continuously while the
  body is conditional.
- `SemanticsEvidence` — `{status: 'verified', source: <official URL>,
  verifiedAt}` or `{status: 'unverified', reason}`. Discovery without
  verified semantics stays in the corpus but can never support a confirmed
  total or a co-loading claim.
- `SessionLoadSet` — deterministic id (`tool:scope-dir`), ordered entries,
  and `baselineTokens` / `conditionalTokens` / `manualTokens` totals plus
  `complete` (false whenever an unverified binding participates).
- `TokenEstimate` — `{tokens, bytes, estimated: true, estimator}`.

Activation classes: `always` (session start), `path` (glob/scope
conditioned), `model-selected` (routing metadata always visible, body loaded
on model decision), `manual` (explicit invocation; excluded from automatic
totals), `unknown` (contributes a file estimate, never a confirmed total).

## Discovery and safety

One bounded walk per root: prune `.git`, `node_modules`, `.cache`, and other
generated trees; include hidden instruction directories (`.claude`,
`.cursor`, `.github`, `.windsurf`); reject non-UTF-8 content with a
diagnostic; follow symlinks only when the canonical target stays inside the
walked root (escapes become diagnostics, never silent omissions). Convention
adapters are pure functions over the immutable snapshot — they perform no
filesystem access of their own. Unreadable or malformed candidates degrade
to diagnostics; nothing crashes, nothing is guessed.

Claude `@import` references are expanded only when the target resolves
inside an authorized root; external references become diagnostics.

## Convention matrix (v1)

Semantics were pinned from the primary sources recorded in epic #27
(research date 2026-08-04). `verified` below means "matches that documented
behavior"; anything the docs do not fully define is discovered as
`unverified` rather than guessed.

| Convention | Paths | Tool | Activation | Status |
| --- | --- | --- | --- | --- |
| AGENTS.md | `AGENTS.md` in any directory | codex (chain root→cwd, one per dir) | always | verified — [OpenAI: AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md) |
| Claude memory | `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`; nested dirs load lazily; recursive `@path` imports | claude-code | always (root); path (nested) | verified — [Claude Code memory](https://code.claude.com/docs/en/memory) |
| Claude rules | `.claude/rules/**/*.md`, optional `paths` front matter | claude-code | always / path | verified — same source |
| Claude skills | `.claude/skills/*/SKILL.md` — `name`/`description` metadata vs body | claude-code | metadata always, body model-selected | verified — [skills/slash commands](https://code.claude.com/docs/en/slash-commands) |
| Claude commands | `.claude/commands/**/*.md` | claude-code | manual | verified — same source |
| Copilot repo instructions | `.github/copilot-instructions.md` | copilot | always | verified — [repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide) |
| Copilot path instructions | `.github/instructions/*.instructions.md` with `applyTo` | copilot | path | verified — same + [support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) |
| Cursor rules | `.cursor/rules/**/*.mdc` (nested allowed): `alwaysApply`, `globs`, `description` | cursor | always / path / model-selected | verified — [Cursor rules](https://docs.cursor.com/context/rules) |
| Cursor legacy | `.cursorrules` | cursor | unknown | **unverified** — current docs do not define modern precedence |
| Windsurf rules | `.windsurf/rules/*.md`, `trigger` + `globs` front matter | windsurf | per trigger: always_on / glob / model_decision / manual | verified — [Windsurf memories](https://docs.windsurf.com/windsurf/cascade/memories) |
| Windsurf legacy | `.windsurfrules` | windsurf | unknown | **unverified** — read but activation/precedence undefined in current docs |
| AGENTS.md, other consumers | same file | cursor, windsurf | always | verified — the tools' own docs; separate bindings on the shared source |

Deliberate v1 trims (recorded, not hidden): one coarse session profile per
tool — surface splits (Copilot CLI vs cloud agent vs review; Cursor editor
vs CLI) are future refinements and until then any surface-specific
divergence belongs in `SemanticsEvidence`, not in invented profiles. Other
skills hosts beyond Claude's discovery root are out of scope. Front matter
is parsed by a bounded scalar/list parser (`key: value`, `key: [a, b]`,
dash lists) — the fields the matrix needs and nothing more; anything else
(nesting, anchors, multi-line) yields a diagnostic and `unknown` activation
rather than a YAML dependency or a guess.

## Session load sets

Per tool, a load-set equivalence class exists per directory where that
tool's instruction scope changes (root, plus each nested scope dir). A
target path resolves to the class of its deepest containing scope. Entries
are ordered per the tool's documented order (root→cwd for chained tools);
totals are sums over delivered fragments:

- `baselineTokens` — verified `always` fragments only;
- `conditionalTokens` — `path` + `model-selected` + `unknown` fragments
  (potential additions, never claimed as paid);
- `manualTokens` — `manual` fragments, excluded from automatic totals;
- `complete: false` whenever any participating binding is unverified.

Identity moves when membership, order, scope, activation, or delivered
fragments change — never when filesystem enumeration order changes. A
thousand files under one hierarchy share one load set.

## Token accounting

`TokenEstimator` port; default `heuristic-v1`: `ceil(utf8Bytes / 4)`.
Counts are **reference estimates for comparison, never billing claims** —
every estimate carries `estimated: true`, the estimator id, and exact UTF-8
bytes. Measured 2026-08-05 against `js-tiktoken@1.0.21` `o200k_base` on a
nine-sample corpus (instruction prose, design docs, TS code, JSON, front
matter, mixed CJK/Cyrillic/emoji): mean signed error +0.7%, mean absolute
7.6%, worst case −25% (dense JSON) and −4% (non-ASCII). No universal
cross-provider bound exists — host tokenizers are undisclosed — so none is
claimed. Estimates cover delivered fragments, not loader-only front matter,
and never include provider wrapper/system overhead. The dependency-free
heuristic is a deliberate deviation from the epic sketch's pinned-tiktoken
suggestion: this package has zero runtime dependencies today, and a ±8%
reference unit does not justify the first one. The port exists so a
consumer can inject a real tokenizer; estimator identity participates in
member-check cache keys either way.

## Testing

Fixture trees under `tests/fixtures/instruction-corpus/` per convention;
flat Node-runner tests for discovery (paths, hidden dirs, pruning, symlink
escape, non-UTF-8, determinism), cascade (ordering, nesting, globs,
fragments, dedup, unverified degradation), and tokens (fragment accounting,
no double charge, arithmetic). Convention goldens use an injected fake
estimator so an estimator change cannot rewrite semantic expectations. An
import-graph test asserts the package never imports judge, check, CLI, or
provider code. CI never touches an ambient home directory; user-root
behavior is proven with fixture roots.
