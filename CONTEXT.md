# Reviewer

A self-hostable GitHub App that reviews pull requests with focused reviewer agents, comments inline, and approves once nothing it raised is left undecided.

## Language

### Findings and threads

**Finding**:
One problem a reviewer reports at a path and line, with a severity and a confidence.
_Avoid_: Issue, comment, nit

**Thread**:
The review conversation the App opens on GitHub for a published finding.
_Avoid_: Comment, conversation

**Fixed**:
A thread whose problem the verifier confirmed is gone from the code at the current head.
_Avoid_: Resolved, addressed

**Disproved**:
A thread whose finding a reply showed was never a real problem.
_Avoid_: Invalid, false positive

**Waived**:
A thread whose finding a maintainer accepted and decided not to fix on this pull request, by resolving its thread or replying `Waive:`. A waiver is never revoked: the finding stays waived for the life of the pull request, re-reports included.
_Avoid_: Accepted, dismissed, won't fix, resolved

**Late finding**:
A finding on lines an earlier review of the pull request already saw. It is published like any other finding.
_Avoid_: Already reviewed, missed finding

**Maintainer**:
Anyone whose association with the repository is owner, member, or collaborator, the pull request's author included.
_Avoid_: Admin, reviewer, owner

**Resolved**:
GitHub's own collapsed state for a thread. It is a UI state, not a verdict: the App cannot set it, and it says nothing about why.

### Approval

**Approval**:
The App's assertion that every finding it raised on the pull request is fixed, disproved, or waived.
_Avoid_: Clean review, pass

**Re-decision**:
A run that runs no reviewers and only decides approval again for the current head, from that head's recorded findings and the threads' current state. A waiver starts one.
_Avoid_: Re-review, recheck

**Stale approval**:
An approval of the App's that a later run at a newer head no longer agrees with. The App dismisses it.
