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
