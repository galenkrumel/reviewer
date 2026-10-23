# The dependency check decides in code; the security focus reads package code

Lockfiles stay out of line review, but a PR that changes an npm or pnpm lockfile gets a dependency check: code compares the lockfiles at base and head, looks up GitHub advisories for every package that changed, and turns three things into Findings on the lockfile line: an introduced advisory (at its own severity, confidence 1.0), a newly added install script (`high`), and a package resolved from outside its registry (`medium`). The security focus then always runs, given the check's output, and can read each changed package's published code through a `package_diff` tool. We wanted the most intelligence and security we could get here: advisories only catch what someone has already reported, and a hijacked release has no advisory, so only reading the package's code can catch it. But the approval-blocking part stays deterministic, so no model can talk an advisory away. A maintainer who knows a vulnerable path is unreachable waives it, as with any Finding (ADR 0001).

## Considered Options

- **A seventh "dependencies" focus.** Rejected: the orchestrator could skip it, and a model would decide whether a known advisory counts.
- **Deterministic check only.** Rejected: blind to malicious releases and to how the repo actually uses a package.
- **Let the security focus lower an advisory's severity when it judges it unreachable.** Rejected: puts a model judgment back into approval. It may add its own Finding, never remove or lower an advisory one.
- **Read package code for direct dependencies only.** Rejected: supply-chain attacks arrive through transitive packages as often as direct ones.

## Consequences

- §6.2's "no network" has one exception: code (never a model) fetches changed packages' tarballs from their registry, capped per run. The tool reads only what was fetched. Packages over the cap or that can't be fetched are listed as not inspected and block approval, as skipped files do; a failed advisory lookup blocks like a failed focus.
- A lockfile-only PR is no longer "nothing reviewable": once the check and the security focus ran, it can be approved. "No reviewers ran" still blocks PRs where nothing ran.
- The check compares base to head in full on every run, so an advisory published after an earlier review is caught on the next push. The existing re-report matching keeps it on its Thread, and waivers still absorb it.
- Advisories the PR leaves open or fixes are summary lines, not Findings, as doc drift excludes documentation that was already wrong.
- Per-repo `exclude` globs and `.gitattributes` marks remove a lockfile from the check (e.g. test fixtures); the check itself can't be disabled.
