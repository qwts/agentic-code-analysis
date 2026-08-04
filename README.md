# agentic-code-analysis

Semantic, agent-powered checks for code structure and maintainability — a
suite of small, loosely coupled CLI tools (`aca <check>`) that make the
judgment mechanical linters cannot: is this file one coherent concept with a
minimal context footprint? Runs as a CI gate (`--enforce`) and as advisory
feedback inside an agent's dev loop, with interchangeable judge models
(Anthropic / OpenAI / local).

Status: design accepted; implementation tracked in
[issues #3–#6](https://github.com/qwts/agentic-code-analysis/issues). Nothing
is runnable yet.

## Docs

- [Suite design](docs/design/suite.md) — scope, architecture, CLI and exit-code contracts
- [First check: context-footprint](docs/design/check-context-footprint.md)
- [Prior art and the bar being raised](docs/design/prior-art.md)
- [Implementation plan](docs/plan/issues.md)
- [Decisions (ACA series)](docs/decisions/README.md)
- [The enforced standard](docs/standards/file-context-footprint.md) (vendored; Agent Space copy is canonical)

Contribution workflow: [CONTRIBUTING.md](CONTRIBUTING.md). Agent context:
[AGENTS.md](AGENTS.md).
