# Instruction-file conventions — source-backed matrix

Reference data for the instruction-corpus library
([design](../design/instruction-corpus.md), issue #23). Every semantic claim
below carries the primary source it was verified against and the date. A
convention not verifiable from a current primary source is marked
**legacy** or **unverified** — the library reports those files as found with
semantics unverified, never guessed. This file is volatile: re-verify before
extending an adapter, and update `verifiedAt` when you do.

Session profiles modeled: `codex-local`, `claude-local`, `claude-cloud`,
`copilot-cli`, `copilot-cloud-agent`, `copilot-code-review`,
`cursor-editor-agent`, `cursor-cli`, `cascade-legacy`, `devin-local`.
The same filename can resolve differently across profiles; there is no
single cross-tool cascade.

## Codex (`codex-local`)

Source: <https://developers.openai.com/codex/guides/agents-md>
(redirects to learn.chatgpt.com) — verified 2026-08-05.

- Global scope (user root): `~/.codex/AGENTS.override.md` first, then
  `~/.codex/AGENTS.md`. Loaded before project files. `CODEX_HOME` relocates
  the profile directory (modeled as the authorized user root).
- Project scope: starting at the project root (typically the git root),
  Codex walks **down** to the CWD. In each directory it takes the first
  match of `AGENTS.override.md`, then `AGENTS.md`, then configured
  fallback filenames (`project_doc_fallback_filenames`). Without a project
  root, only the CWD is checked.
- Merge order: concatenation from root downward; closer files are read
  later and override earlier guidance on conflict.
- Cap: combined instruction bytes limited by `project_doc_max_bytes`
  (default 32 KiB). Empty files are skipped; Codex stops adding files once
  the combined size reaches the limit. The library reads this as: files are
  charged whole, in order, until the next file would cross the cap; that
  file and the rest of the chain are reported as excluded-by-cap.
- Cadence: session start (system-prompt instructions).

## Claude Code (`claude-local`, `claude-cloud`)

Sources: <https://code.claude.com/docs/en/memory> and
<https://code.claude.com/docs/en/skills> — verified 2026-08-05.

Memory files:

- Managed policy: `/Library/Application Support/ClaudeCode/CLAUDE.md`
  (macOS), `/etc/claude-code/CLAUDE.md` (Linux/WSL),
  `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows). Outside repo/user
  roots; the library discovers it only if that path is supplied as an
  explicitly authorized root.
- User: `~/.claude/CLAUDE.md`; user rules `~/.claude/rules/**/*.md`
  (loaded before project rules).
- Project: `./CLAUDE.md` or `./.claude/CLAUDE.md`; local
  `./CLAUDE.local.md` (appended after `CLAUDE.md` at the same level).
  When **both** project locations exist the docs do not define a
  tie-break/dedup rule — the library flags that as unresolved rather than
  guessing.
- Hierarchy: ancestor-directory `CLAUDE.md`/`CLAUDE.local.md` (filesystem
  root down to CWD) load in full at launch, ordered root→CWD. Ancestors
  *above* the repository root are outside the authorized roots and are
  reported as a documented gap, not scanned. Subdirectory files below the
  CWD load on demand when Claude reads files in those directories.
- Project rules: `.claude/rules/**/*.md` (recursive). Without `paths`
  frontmatter: loaded at launch, same priority as `.claude/CLAUDE.md`.
  With `paths` (glob list): load when Claude works with matching files.
- Imports: `@path` outside code spans/fences, relative to the containing
  file, max depth four hops, expanded at launch. Imports in project-scope
  files that resolve **outside** the working directory are gated behind a
  one-time approval dialog — conditional, not confirmed. User-scope
  imports load without the dialog.
- Charged content: block-level HTML comments are stripped before injection
  (comments inside code blocks are preserved).
- Auto memory: `~/.claude/projects/<project>/memory/MEMORY.md` — first
  200 lines or 25 KB, whichever comes first, loaded each session
  (frontmatter and block HTML comments stripped before the limit is
  measured). Topic files load on demand. The `<project>` mapping is
  machine-derived, so the library requires the memory directory to be
  supplied explicitly (config snapshot), never guessed from a home scan.

Skills and commands (Agent Skills standard, see below):

- Personal `~/.claude/skills/<name>/SKILL.md`, project
  `.claude/skills/<name>/SKILL.md` (also discovered in parent directories
  up to the repo root, and in nested directories on access), commands
  `.claude/commands/*.md` (merged into skills; same loading).
- Loading: description metadata is in context every session (combined
  `description` + `when_to_use` truncated at 1,536 characters in the
  listing); full body loads on invocation or model decision;
  `disable-model-invocation: true` removes the description from context.
- `claude-cloud` (cloud sessions / Cowork): does **not** read
  `~/.claude/skills/` or local user files; loads the cloned repository's
  project files and `.claude/skills/`. Account-level synced skills are not
  filesystem-observable — reported as a documented gap.

## GitHub Copilot (`copilot-cli`, `copilot-cloud-agent`, `copilot-code-review`)

Sources:
<https://docs.github.com/en/copilot/reference/custom-instructions-support>
and
<https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions>
— verified 2026-08-05.

- Repository-wide: `.github/copilot-instructions.md`.
- Path-specific: `.github/instructions/**/*.instructions.md` with an
  `applyTo` frontmatter glob.
- Agent instructions: `AGENTS.md`, `CLAUDE.md` (alternative
  `.claude/CLAUDE.md`), `GEMINI.md`. Copilot CLI discovers repository and
  agent files in the repo root, the CWD, intermediate directories between
  them, and directories nested in the path of a file it is working on.
- `copilot-cli` user scope: `$HOME/.copilot/copilot-instructions.md` and
  `$HOME/.copilot/instructions/**/*.instructions.md` (`COPILOT_HOME`
  relocates; `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` adds directories — the
  env-var mechanism is out of scope unless supplied via config snapshot).
- `copilot-cloud-agent`: repository, path-specific, all agent files, plus
  organization instructions (not filesystem-observable — documented gap).
- `copilot-code-review`: repository, path-specific, and `AGENTS.md` only
  (root; the support matrix does not confirm nested agent files for
  review).
- Precedence: applicable files are **combined**; the docs explicitly
  define no general precedence order between instruction classes.
  Identical duplicate instructions are deduplicated; conflicts are not
  auto-resolved. The library models this order relation as *unordered* —
  concatenation order must not be presented as conflict resolution.
- Cadence: session start (per-prompt context for chat surfaces).

## Cursor (`cursor-editor-agent`, `cursor-cli`)

Sources: <https://cursor.com/docs/context/rules> (redirect target of
docs.cursor.com/context/rules) and <https://cursor.com/docs/cli/using> —
verified 2026-08-05.

- Project rules: `.cursor/rules/*.mdc`, version-controlled; nested
  `.cursor/rules/` directories scope to their subtree. Plain `.md` files
  in `.cursor/rules/` are ignored unless they carry frontmatter metadata.
- `.mdc` frontmatter: `description`, `globs`, `alwaysApply`. Four
  activation modes: **Always Apply** (`alwaysApply: true` — every
  session), **Apply to Specific Files** (`globs` — attaches when matching
  files are in context), **Apply Intelligently** (`description` only —
  agent decides; description visible, body on decision), **Apply
  Manually** (no description/globs — `@`-mention only).
- `AGENTS.md`: plain-markdown instructions at the project root or in
  subdirectories (subtree-scoped).
- `cursor-cli`: reads `.cursor/rules` identically to the editor, plus
  `AGENTS.md` **and** `CLAUDE.md` at the project root, applied as rules.
- Order: Team Rules → Project Rules → User Rules; all applicable rules are
  merged and earlier sources take precedence on conflict. Team and User
  rules are app/dashboard state, not repository files — documented gap.
- Legacy `.cursorrules`: current rules documentation does not define its
  precedence or activation; the library reports it **legacy, semantics
  unverified** (still recognized as an instruction candidate).

## Windsurf / Devin (`cascade-legacy`, `devin-local`)

Sources: <https://docs.devin.ai/desktop/cascade/memories>,
<https://docs.devin.ai/desktop/cascade/agents-md>,
<https://docs.devin.ai/desktop/cascade/skills> — verified 2026-08-05.

- Workspace rules: `.devin/rules/*.md` preferred; `.windsurf/rules/*.md`
  fallback. `.devin/` takes precedence over `.windsurf/` at every level.
  Per-file limit 12,000 characters.
- Global rules (user root): `~/.codeium/windsurf/memories/global_rules.md`,
  limited to 6,000 characters; always on. Enterprise system directories
  exist (e.g. `/etc/devin/rules/*.md`) — only discovered if supplied as an
  authorized root.
- Rule activation via `trigger` frontmatter: `always_on` (full content
  every message), `model_decision` (description always; full content on
  demand), `glob` (applies when Cascade reads/edits a matching file),
  `manual` (`@rule-name`).
- `AGENTS.md` / `agents.md` (case-insensitive): root file is always-on
  (full content in the system prompt every message); subdirectory files
  auto-scope via a generated `<directory>/**` glob.
- Legacy `.windsurfrules` (workspace root single file): still read, but
  current docs do not fully define its activation/precedence — reported
  **legacy, semantics unverified**.
- Skills: workspace `.windsurf/skills/<name>/`, global
  `~/.codeium/windsurf/skills/<name>/`, plus cross-agent scan of
  `.agents/skills/`, `~/.agents/skills/`, `.claude/skills/`, and
  `~/.claude/skills/`. Progressive disclosure: name + description by
  default; full SKILL.md and supporting files on invocation/@mention.
- `cascade-legacy` vs `devin-local`: memories persist for the legacy
  Cascade agent only (internal state, not filesystem-observable —
  documented gap); the Devin Local agent reads `AGENTS.md` through the
  Devin CLI rules system. Both profiles share the file conventions above.

## Agent Skills specification (shared by Claude Code and Windsurf/Devin)

Source: <https://agentskills.io/specification> — verified 2026-08-05.

- A skill is a directory whose `SKILL.md` holds YAML frontmatter + body.
- `name`: required, 1–64 chars, lowercase alphanumerics and single
  hyphens, must match the parent directory name. `description`: required,
  1–1024 chars. Optional: `license`, `compatibility` (≤500 chars),
  `metadata` (string map), `allowed-tools` (experimental).
- Progressive disclosure: metadata (`name` + `description`, ~100 tokens)
  loads at startup for all skills; the full body loads on activation;
  `scripts/`, `references/`, `assets/` load on demand.
- The spec defines the format, not discovery locations — each host's
  locations are listed under that host above.

## Token estimation

The reference estimator is `js-tiktoken` pinned at 1.0.21 with the
`o200k_base` encoding — a stable offline comparison unit, **not** a claim
that any host above tokenizes with it. Every count the library emits is
marked `estimated: true` with the estimator identity. No universal error
bound versus host-side tokenizers/wrappers is known; none of the hosts
above documents its tokenizer for instruction files, so per-host error is
model- and client-dependent and stated as unknown. Counts cover file
content after the documented projection (comment stripping, metadata-only,
character/byte caps) — never client wrapper or system-prompt overhead.

Reference calibration corpus (tests pin these against the pinned
estimator; update intentionally when the pin moves, never via live calls):
concise prose, Markdown lists/tables, fenced code, path/frontmatter-heavy
text, and non-ASCII text — see `tests/instruction-corpus-tokens.test.ts`.
