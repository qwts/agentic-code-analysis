# Rebase workflow

Fetch the remote and identify the exact upstream before rewriting history.
Start the interactive rebase only after confirming which commits are private.
Resolve conflicts one file at a time, review the staged diff, and continue.
If the intended history is unclear, abort the rebase and return to the original branch state.
Use force-with-lease only when the declared task explicitly permits updating a rewritten remote branch.
