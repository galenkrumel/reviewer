# reviewer

A self-hosted GitHub App that reviews pull requests with focused model agents and posts its findings as a PR review.

## Language

**Run**:
One job the App takes on for a PR at a specific head and base, from queued to its final status, whatever that turns out to be.
_Avoid_: Job (in prose), review (for the job itself)

**Re-decision**:
A Run that runs no reviewers and decides approval again from an earlier published Run's findings and the threads as they are now.

**Review**:
The GitHub pull request review a Run publishes. Not every Run has one.
_Avoid_: Run, review run

**Dashboard**:
The operator's read-only view of Runs: their history and current status.
_Avoid_: Admin panel, console

**Focus**:
One kind of review a Run can ask for: correctness, security, performance, architecture, conciseness or documentation. Each selected focus runs as its own reviewer. The orchestrator selects focuses; it cannot add new ones.
_Avoid_: Reviewer type, authorize (for selecting a focus)

**Doc drift**:
A statement in the repository's documentation that a PR makes false: prose files or doc comments that still describe the behavior, names, paths, config or commands the PR changed. Documentation that was already wrong before the PR is not doc drift.
_Avoid_: Stale docs (it doesn't separate what this PR broke from older debt)
