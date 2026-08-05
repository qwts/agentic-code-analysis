# agentic-code-analysis

Semantic, agent-powered checks for code structure and maintainability — a
suite of small, loosely coupled CLI tools (`aca <check>`) that make the
judgment mechanical linters cannot: is this file one coherent concept with a
minimal context footprint? Runs as a CI gate (`--enforce`) and as advisory
feedback inside an agent's dev loop, with interchangeable judge models
(Anthropic / OpenAI / local).

Status: core CLI, JudgeClient port, Anthropic/OpenAI/local adapters, and
three checks — `aca context-footprint`, `aca failure-posture`, and
`aca test-honesty`, each with a calibration self-test — are in (TypeScript 7 on Node ≥ 24, no build step —
`node src/cli.ts <check>`). Remaining work:
[open issues](https://github.com/qwts/agentic-code-analysis/issues).

## Docs

- [Adopting aca in your repo](docs/adoption.md) — config, advisory CI step, cost expectations
- [Suite design](docs/design/suite.md) — scope, architecture, CLI and exit-code contracts
- [First check: context-footprint](docs/design/check-context-footprint.md)
- [Second check: failure-posture](docs/design/check-failure-posture.md) — behavior when dependencies misbehave; rubric: [file-failure-posture](docs/standards/file-failure-posture.md)
- [Third check: test-honesty](docs/design/check-test-honesty.md)
- [Fourth check: naming-truth](docs/design/check-naming-truth.md)
- [Prior art and the bar being raised](docs/design/prior-art.md)
- [Implementation plan](docs/plan/issues.md)
- [Check backlog](docs/plan/backlog.md) — candidate checks awaiting design
- [Decisions (ACA series)](docs/decisions/README.md)
- [The enforced standards](docs/standards/) — [file-context-footprint](docs/standards/file-context-footprint.md) (vendored; Agent Space copy is canonical), [naming-truth](docs/standards/naming-truth.md) (authored here)

Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md). Agent context:
[AGENTS.md](AGENTS.md).
