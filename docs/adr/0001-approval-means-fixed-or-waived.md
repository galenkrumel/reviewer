# Approval means every finding is fixed, disproved, or waived

The App approves once every finding it raised on a pull request is fixed, disproved, or waived by a maintainer (owner, member, or collaborator, the PR's author included). A strict approval ("the reviewer finds nothing at this head") left a disputed finding blocking forever, and the only way past it was merging around the App. Maintainers waive by resolving the App's thread in GitHub, or by replying `Waive: <reason>`. The App can't resolve its own threads, so a resolved App thread always means a human decided. A waiver is recorded the first time a run sees it and is never revoked. For the rest of the PR it absorbs any re-report the "still reported" matcher links to it. A waiver starts a re-decision, which runs no reviewers and recomputes approval from the head's recorded findings, so the approval follows the decision without waiting for a push.

## Considered Options

- **The verifier interprets free-text replies** ("we won't address this"). Rejected: a model deciding whether a maintainer meant it is the inconsistency this decision removes. The verifier instead tells the maintainer how to waive.
- **Waivers only by keyword reply.** Rejected as the only way: resolving is the button people already reach for. `Waive:` stays, so a waiver can carry its reason.
- **A waiver lapses when the code under it changes.** Rejected: the code under a waived finding usually changes on later pushes, which would bring back approval-by-lottery.

## Consequences

- This partly reverses the "no comment commands" non-goal: `Waive:` is the one command, and it only ever lowers the bar for maintainers who could already merge.
- A genuinely new problem on the exact lines of a waived finding, with a matching title, is absorbed by the waiver. Known limit.
- Late findings (on lines an earlier review saw) are now posted as threads rather than held back, so that every approval blocker is a thread with a way out.
- When a later run disagrees with an earlier approval, the App dismisses it. Where branch protection refuses the dismissal, the review says so.
