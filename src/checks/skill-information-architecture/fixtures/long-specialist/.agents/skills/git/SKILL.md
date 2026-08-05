---
name: git
description: Perform controlled interactive rebases and recover conflicts.
---
# Establish the rewrite boundary

Fetch the remote, identify the upstream, inspect the commit graph, and confirm that every commit being rewritten is private. Create a named backup branch before changing history.

# Build the rebase plan

Choose pick, reword, edit, squash, fixup, or drop for each commit according to the requested final history. Keep independent behavior changes independent unless the task explicitly asks for consolidation.

# Resolve conflicts

Inspect all conflict stages, reconcile intent rather than choosing a side mechanically, stage each verified resolution, review the staged diff, and continue. Abort when the intended result cannot be established.

# Validate and publish

Inspect the rewritten graph, compare the old and new patch ranges, run relevant tests, and use force-with-lease only with explicit permission to update the rewritten remote branch.
