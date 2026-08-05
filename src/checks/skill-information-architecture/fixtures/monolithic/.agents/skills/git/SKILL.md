---
name: git
description: Routine Git navigation, synchronization, and safe history repair.
---
# Interactive rebase in detail

Fetch every remote and inspect each candidate upstream. Draw the commit graph and label merge bases. Create a backup branch. Start an interactive rebase and decide separately whether every commit should be picked, reworded, edited, squashed, fixed up, or dropped. At each stop, inspect the index and worktree, amend only the intended changes, and continue. For conflicts, identify all stages, compare both sides, edit each file, stage resolutions, inspect the complete staged diff, and continue. If any assumption about the desired history is uncertain, abort, compare against the backup branch, and begin again. Afterward, inspect the rewritten graph, run all relevant tests, compare the patch range, and use force-with-lease only when permission to rewrite the remote branch is explicit.

# Routine branch work

For a switch-and-update task, run `git checkout <branch>` and then `git pull --ff-only`. Stop and inspect instead of forcing a non-fast-forward update.

# Safety and prerequisites

If the worktree is dirty, preserve its changes before switching branches. Never discard work merely to make a command succeed.
