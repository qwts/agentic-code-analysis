---
name: git
description: Routine Git navigation plus safe rebase recovery.
---
# Routine branch work

Run `git checkout <branch>` and then `git pull --ff-only`.

# Critical recovery rule

If rebase intent becomes unclear, run `git rebase --abort`; never discard the worktree to force continuation.

# Detailed recovery

For conflict diagnosis and rewritten-history validation, read the [rebase recovery workflow](references/rebase.md).
