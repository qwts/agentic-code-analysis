# Contributing

This repo follows the shared `qwts` SOPs from
[playbook-engineering](https://github.com/qwts/playbook-engineering/tree/main/docs/sop)
— inherited by default, varied only by documented delta (none recorded yet):

- [Issue lifecycle](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/issue-lifecycle.md) — every change traces to an issue; agent-executed issues carry tier + routing from the registry.
- [Branch, PR, and review](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/branch-pr-review.md) — trunk-based, bot identity for agent PRs, one approving human review, signed commits via the Git Data API.
- [Feature lifecycle](https://github.com/qwts/playbook-engineering/blob/main/docs/sop/feature-lifecycle.md) — features open as a four-section spec and close with a closeout.

Repo-specific design and decisions live in [docs/](docs/design/suite.md).
New source files must satisfy the
[file-context-footprint standard](docs/standards/file-context-footprint.md)
— the suite applies the rule it enforces to itself.
