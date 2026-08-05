---
name: git
description: Routine Git navigation, synchronization, and safe history repair.
---
# Safety and prerequisites

If the worktree is dirty, preserve its changes before switching branches. Never discard work merely to make a command succeed.

# Routine branch work

For a switch-and-update task, run `git checkout <branch>` and then `git pull --ff-only`. Stop and inspect instead of forcing a non-fast-forward update.

# Specialist workflows

For history rewriting, interactive rebase, conflict recovery, or aborting a rebase, read the [rebase workflow](references/rebase.md) before acting.
