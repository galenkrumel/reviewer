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

**Verdict**:
Whether a published Review approved the PR or only commented. A PR's Verdict is that of its latest Run that published one.
_Avoid_: Decision (the blockers a full Run records), status

**PR state**:
Whether a PR is open, a draft, merged or closed, as GitHub last reported it.
_Avoid_: Status (a Run's), disposition

**Dashboard**:
The operator's read-only view of PRs and their Runs: history, current status and Verdicts.
_Avoid_: Admin panel, console

**Focus**:
One kind of review a Run can ask for: correctness, security, performance, architecture, conciseness or documentation. Each selected focus runs as its own reviewer. The orchestrator selects focuses; it cannot add new ones.
_Avoid_: Reviewer type, authorize (for selecting a focus)

**Dependency check**:
The part of a Run that compares a PR's lockfiles at base and head and looks up known advisories for the packages that changed. It is not a Focus: no model runs it and the orchestrator cannot skip it. The security focus is given what it found.
_Avoid_: Dependency review (that's what the security focus does with it), audit

**Advisory**:
A published report that a range of a package's versions is vulnerable, with its own severity. Relative to a PR, an Advisory is **introduced** (open against a version the PR moves to or adds, and not against the version it replaced), **still open** (open before and after), or **fixed** (open before, not after). Only an introduced Advisory is a Finding, at the Advisory's own severity; a model never lowers it, and a Maintainer can waive it.
_Avoid_: Vulnerability, CVE (one Advisory may carry several IDs)

**Doc drift**:
A statement in the repository's documentation that a PR makes false: prose files or doc comments that still describe the behavior, names, paths, config or commands the PR changed. Documentation that was already wrong before the PR is not doc drift.
_Avoid_: Stale docs (it doesn't separate what this PR broke from older debt)

**Finding**:
One problem a reviewer reports at a path and line, with a severity and a confidence.
_Avoid_: Issue, comment, nit

**Thread**:
The review conversation the App opens on GitHub for a published Finding.
_Avoid_: Comment, conversation

**Fixed**:
A Thread whose problem the verifier confirmed is gone from the code at the current head.
_Avoid_: Resolved, addressed

**Disproved**:
A Thread whose Finding a reply showed was never a real problem.
_Avoid_: Invalid, false positive

**Waived**:
A Thread whose Finding a Maintainer accepted and decided not to fix on this PR, by resolving its Thread or replying `Waive:`. A waiver is never revoked: the Finding stays waived for the life of the PR, re-reports included.
_Avoid_: Accepted, dismissed, won't fix, resolved

**Late finding**:
A Finding on lines an earlier Review of the PR already saw. It is published like any other Finding.
_Avoid_: Already reviewed, missed finding

**Maintainer**:
Anyone whose association with the repository is owner, member or collaborator, the PR's author included.
_Avoid_: Admin, reviewer, owner

**Resolved**:
GitHub's own collapsed state for a Thread. A UI state, not a verdict: GitHub refuses the App's own resolve, and it says nothing about why.

**Approval**:
The App's assertion that every Finding it raised on the PR is Fixed, Disproved or Waived. See `docs/adr/0001-approval-means-fixed-or-waived.md`.
_Avoid_: Clean review, pass

**Stale approval**:
An Approval of the App's that a later Run at a newer head no longer agrees with. The App dismisses it.
