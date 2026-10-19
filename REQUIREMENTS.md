# Code Review Agent — MVP Requirements (rev. 2)

## 1. Purpose

Build an automated code review agent for GitHub repositories. When an eligible pull request is ready for review, the agent analyzes the proposed changes using focused reviewer agents and posts actionable inline review comments.

The system is **self-hostable**: anyone can deploy their own instance against their own repositories. Each deployment is single-tenant: one operator, one GitHub App, one model bill. This document defines the agents, their contracts, and their safety properties. The deployment target is a single service with a persistent volume (e.g. Render), but nothing in the design depends on a specific host.

The MVP is read-only with respect to source code: it must not build, test, import, or execute code from a pull request.

## 2. Scope

### In scope

- GitHub as the only source control and pull request platform.
- A static allowlist of tracked repositories in deployment config.
- Reviews triggered by PR lifecycle events (§3) and by a maintainer label (§3.3).
- An orchestrator that selects specialist reviewers based on the change.
- Reviewers with read-only, revision-pinned repository tools (§6.2).
- Per-agent model selection via OpenRouter (§5.4).
- Findings published as inline comments in one PR review per run.
- Every run tied to the exact head and base revisions analyzed.

### Out of scope for the MVP

- Running or building submitted code, including tests, scripts, plugins, or package hooks.
- Approving, merging, or modifying pull request code.
- Providers other than GitHub.
- Automatically fixing findings.
- Reviewing draft pull requests.
- Multi-tenant hosting, billing, or a registration UI.
- Horizontal scaling (more than one instance).
- A judge/verifier agent pass (deferred until real-world noise justifies it).
- Comment commands such as `@bot review`. The one exception is a maintainer's `Waive: <reason>` reply on the App's thread (§9.2).

## 3. Triggers and eligibility

### 3.1 Events

The GitHub App subscribes to `pull_request` events and acts on these actions:

| Action | Behavior |
|---|---|
| `opened` | Review if the PR is not a draft. |
| `ready_for_review` | Review. |
| `synchronize` | Review the new head if the PR is not a draft. |
| `reopened` | Review if the PR is not a draft. |
| `edited` | Review only if `changes.base` is present (base branch retargeted). |
| `labeled` | Review the current head if the label is the configured review label (§3.3). |
| `converted_to_draft`, `closed` | Mark any queued or running run for the PR `superseded`. Do not review. |

All other actions are ignored. Draft PRs are never reviewed.

The App also subscribes to `pull_request_review_thread` and `pull_request_review_comment`, which can waive a finding (§9.2). A thread's `resolved`, or a review comment's `created` when the comment starts with `Waive:` (ignoring case and leading whitespace) and its author is a maintainer (OWNER, MEMBER or COLLABORATOR), queues a **re-decision** for the PR's current head; anything else on those events is ignored. Gating (§3.2) and the rate limit (§3.4) apply as for a review.

- A re-decision runs no orchestrator and no reviewers. It decides approval again from the latest full run published at that head and base, with waivers applied, and from the threads as they are now: the verifier runs only on unresolved threads where the PR's author or a maintainer spoke last.
- It posts a review only when the approval verdict changes. Withdrawing an approval dismisses it as usual (§9.1). With no review published at that head (or one whose run recorded no decision, such as a review found already posted after a restart), or with approvals off, it is recorded `skipped` and nothing is posted. If the threads can't be read or the verifier fails, it posts nothing and the run is recorded `failed`.
- It bypasses the duplicate check for its head and base, but a re-decision still queued for that head absorbs another. It never supersedes a review run.
- A run already in flight reads the threads again before settling them, so it honours a waiver that lands while it runs.

### 3.2 Author gating

Public repos accept PRs from anyone. Each such PR spends tokens and gives an attacker a way to inject prompts. Eligibility depends on `author_association`:

- `OWNER`, `MEMBER`, `COLLABORATOR`: eligible automatically.
- Everyone else, including fork PRs from outside contributors: eligible only while the PR carries the review label (§3.3).

The deployer can change this policy (`review_outside_prs: label | always | never`). The default is `label`.

### 3.3 Review label

- The label name is configurable and defaults to `ai-review`.
- Applying the label queues a review of the current head. GitHub restricts labeling to triage access or above, which serves as the authorization check.
- Removing and re-applying the label is the manual "review again" trigger.

### 3.4 Rate limit

Each PR has a configurable cap on runs per rolling 24 hours (default 10). Events past the cap are recorded and skipped.

## 4. Revision handling

- Each run records the repository, PR number, head SHA, base SHA, and triggering event.
- The analysis uses a pinned head/base SHA pair, never a moving branch ref.
- Source is read from a bare, blobless clone cached on the volume, with no working tree (§6.2).
- **Superseding:** when a new job is enqueued for a PR, every queued or running job for that PR with a different head or base is marked `superseded`. The worker checks this flag between reviewer invocations and immediately before publishing.
- **Pre-publish check:** immediately before publishing, the worker fetches the PR and confirms it is open, not a draft, and still at the reviewed head and base SHAs. If anything has changed, nothing is published.
- **Accepted race:** a few seconds remain between the check and the post. The review is created with `commit_id` set to the reviewed head, so in the worst case one review appears as "outdated" on GitHub. This is acceptable.

## 5. Reviewer orchestration

### 5.1 Focus areas

The orchestrator selects from a fixed enum of six focuses:

- **Correctness:** logic errors, edge cases, state handling, error handling.
- **Security:** authentication, authorization, input handling, secrets, dependencies, network boundaries, sensitive data.
- **Performance:** hot paths, data access, concurrency, large allocations, scaling risks.
- **Architecture:** public interfaces, module boundaries, dependencies, cross-cutting behavior.
- **Conciseness:** unnecessary complexity that materially reduces clarity. Subjective style preferences are excluded.
- **Documentation:** doc drift, documentation the PR makes false: prose files (README, `docs/**`, `*.md`/`*.mdx`, ADRs, AGENTS.md/CLAUDE.md, `CONTEXT.md`) and doc comments (JSDoc, docstrings) that still describe behavior, names, paths, flags, config, env vars, commands or architecture the PR changed, plus the accuracy of doc lines the PR adds or edits. Missing docs, CHANGELOGs, generated docs, external sites and docs already wrong before the PR are excluded, as are wording, typos and style. A statement the PR made false is at least medium; it is high when it leads a reader into a broken or unsafe action (a wrong command, credential or setup step) or is agent instructions that now steer agents into broken changes. A drift finding anchors on the changed line that made the doc false and names the drifted doc by `path:line`, quoting it; an accuracy finding anchors on the edited doc line. Documentation findings never merge with other focuses' findings (§7.2).

### 5.2 Selection

- The orchestrator receives what each focus reviews for, the changed file list, diff stats, the PR title and body (as untrusted data, §6.1), and the repository's per-repo config. It returns a list of selected focuses, each with a one-line reason.
- Its output is schema-validated against the enum. It cannot add reviewers, change budgets, or alter reviewer instructions.
- **Always-on minimum:** when any non-excluded code file changes, correctness, security and documentation always run, whatever the orchestrator outputs. They count toward the cap. A repo can disable documentation (§11.2), but not the other two. On a docs-only PR the orchestrator may still pick documentation.
- **Cap:** `max_reviewers` defaults to 4 and is configurable, with a minimum of 3. A deployment set below 3 refuses to start. The always-on reviewers fill slots first, and orchestrator picks fill the rest in its stated priority order.
- Reviewers cannot invoke other reviewers or the orchestrator. There is no recursion.
- **Orchestrator failure:** fall back to correctness, plus security if dependency manifests or auth-related paths changed (path match). Record that the fallback was used.

### 5.3 Reviewer execution

- Each reviewer runs as a tool-use loop with read-only repository tools (§6.2) and a finishing `report_findings` tool.
- Each reviewer has a budget of turns and tokens. Exceeding it counts as a failure.
- Reviewers see the PR diff and pull surrounding context themselves through the tools.

### 5.4 Models

- Every agent (orchestrator, verifier, and each of the six focuses) has its own `model` and an optional `fallback_model` in deployment config. Models are addressed by OpenRouter ID.
- Calls go through OpenRouter's chat completions API. Fallback uses OpenRouter's `models: [...]` array.
- **Startup validation:** the service checks every configured model against OpenRouter's `/models` endpoint. Each one's `supported_parameters` must include `tools`. If any model fails the check, the service refuses to start.
- Findings come back as a call to the `report_findings` tool, not through `response_format`. Arguments are schema-validated, and invalid output is retried once.
- Each run records the model ID, token counts, and cost for each agent invocation, so that models can be compared.

## 6. Analysis and execution safety

### 6.1 Untrusted input

- PR source, title, body, comments, commit messages, file names, and per-repo config content are untrusted.
- Untrusted content is placed in clearly delimited data blocks. System prompts state that instructions inside those blocks are data and must not be followed.
- Reviewer instructions, tool sets, budgets, thresholds, and the focus enum come only from code and deployment config. PR content cannot change them.

### 6.2 Repository access

- Each repository has a bare, blobless clone on the volume. Each run fetches exactly the head and base SHAs. No working tree is ever checked out, which means no hooks, no LFS smudge filters, and no symlink traversal.
- Reviewer tools:
  - `read_file(path, start?, end?)` is implemented as `git show <head>:<path>`.
  - `grep(pattern, path_glob?)` is implemented as `git grep <head>`.
  - `list_dir(path)` is implemented as `git ls-tree <head>`.
  - `diff(path?)` returns the PR diff (base...head).
- Paths are validated against the tree at the pinned SHA. Nothing outside the repository object store is reachable: no host filesystem, no environment, no network.
- No tool executes repository content.

### 6.3 Credentials

- The GitHub App private key and the OpenRouter key exist only in the service environment.
- Short-lived installation tokens are minted per job and used only by the fetch and publish code.
- No credential appears in any prompt, tool result, log line, or stored run metadata.

### 6.4 Output sanitization

Before publishing, comment text is sanitized: `@`-mentions are neutralized, and links are removed unless they point to the reviewed repository on github.com.

## 7. Findings

### 7.1 Finding schema (`report_findings` arguments)

- `title`: concise and specific.
- `severity`: `critical | high | medium | low`, judged by realistic impact: `critical` is an exploitable security hole or data loss in normal use; `high` breaks a feature or exposes data under realistic conditions; `medium` is wrong behavior in an edge case or under unusual but plausible conditions; `low` is unlikely, cosmetic, or matters only at much larger scale.
- `confidence`: 0–1.
- `path`, `line` (and optional `start_line`): a location in the head revision.
- `evidence`: the concrete issue and why it is a defect or a meaningful risk.
- `suggested_fix` (optional): replacement code for the anchored lines, or prose.

### 7.2 Validation (in code, never trusted to the model)

1. Schema-valid.
2. The anchor falls on a line added or modified in the reviewed diff.
   - **Incremental after a push:** when an earlier head was reviewed, against this base or one of its ancestors (main merged in or rebased onto), with at least one focus run, no failed focus and no file skipped for budget, reviewers see the full diff for context plus the changes since that head (and any file the base changed since that review: merging main in can undo one of main's changes on a line the PR didn't touch since), and are told to focus on those. A focus that didn't run on that review never saw its lines, so it gets the full review instead. A **late finding**, on a line an earlier review saw, is still posted inline under the rules below like any other finding, so it blocks approval as a thread someone can fix, disprove or waive rather than by being held back. A push that adds no lines runs no reviewers. A label re-review, a base that isn't a descendant of the earlier one (a retarget), an earlier head that can no longer be fetched, or a diff since that head larger than the PR diff gets a full review.
3. `severity ≥ medium` **and** `confidence ≥ 0.7`. Both thresholds are configurable.
4. **Cross-reviewer merge:** findings on the same path within ±3 lines are merged into one, except that a documentation finding never merges with another focus's finding. The higher severity × confidence finding is kept, and all contributing focuses are noted.
5. **Cross-push dedup:** a finding is dropped if one with the same path and normalized title was already posted on this PR (any earlier head) and its anchor line still exists in the current diff.
6. **Cap:** at most `max_comments` (default 10) per review, ranked by severity × confidence.

Findings that fail validation are omitted from the review. Their outcome (`unanchorable`, `below_threshold`, `merged`, `duplicate`, `over_cap`, `waived`) is recorded in run metadata.

## 8. Large PRs

- **Always excluded from review:** lockfiles, vendored directories, generated and minified files, and paths marked `linguist-generated` or `linguist-vendored` in `.gitattributes` at the base SHA. Deployment and per-repo config can extend the exclusion list.
- **Budget:** if the remaining files exceed the review token budget, files are ranked by churn and risk (security-sensitive paths first), and only those that fit are reviewed.
- **Oversized PR:** above `max_reviewable_lines` (default 800) reviewable changed lines, the review proceeds within budget, and the summary opens with a recommendation to split the PR. The recommendation states the line count and the directories involved. Rename detection discounts pure renames and moves. The note goes in the review body, not as an inline comment.

## 9. GitHub review publishing

### 9.1 When to post

- Post one review per run, with event `COMMENT`, or `APPROVE` under the rule below. The agent never sends `REQUEST_CHANGES`.
- Post a review if at least one inline comment survives validation, **or** if the summary contains an oversized-PR note, skipped files, or failed focuses, **or** if approvals are on (every such run either approves or says why not).
- **Approval (opt-in, `APPROVE_WHEN_CLEAN=true`, off by default):** approve when at least one focus ran and all succeeded, no file was skipped or left unreviewed as binary, every finding the run reported fell below the publish threshold or was `waived` (so none was posted (late findings included), merged, or dropped as `unanchorable` or `duplicate`), on an incremental run no earlier run on this base dropped a finding as `over_cap`, and every review thread the App started on the PR is verified fixed or waived (§9.2). A thread resolved by someone who can't waive it still blocks, unless it was verified fixed. If the threads can't be read, or the verifier fails, don't approve. A push that runs no reviewers (deletions only) is never approved.
- **Not approved:** with approvals on, a run that doesn't approve says why in one summary line, naming every blocker with counts and paths, never model text: new issues, issues a reviewer still reports, issues outside the changed lines, an earlier comment-cap drop, failed focuses, unreviewed files, unreadable or un-rechecked threads, threads still open, threads resolved by someone who can't waive them, or no reviewers having run (with the re-review label as the way out).
- **Waived findings:** an approval lists every waived finding as its title (`path:line`), waived by the maintainer's login, without `@`, capped at 50 like other path lists. Titles come from the App's own comments, sanitized again.
- **Dismissing stale approvals:** when a run with approvals on doesn't approve, it dismisses every approval of the App's own that is still in force on the PR, with the **Not approved** line as the message, before posting its review, so the App's approval always reflects its latest verdict. Only the App's own reviews are considered, and a dismissed one isn't dismissed again. Branch protection can restrict who may dismiss reviews: a refusal is logged once per run, and the review's summary says an earlier approval by this App could not be dismissed.
- The approval is a model's judgment over PR-controlled content, and any maintainer, the PR's author included, can waive the App's findings. The verifier reads replies from the PR's author and anyone with write access, as untrusted data; those people can resolve the App's threads directly anyway. It must never be the only review that branch protection requires.
- Otherwise post nothing.

### 9.2 Re-checking the App's threads

- Every run reads every review thread the App started, resolved or not, whether or not reviewers ran (a deletion can be the fix).
- **Waivers:** the App can't resolve its own threads, so a resolved App thread always means a human decided. A thread resolved by a **maintainer** (OWNER, MEMBER or COLLABORATOR, the PR's author included), or where a maintainer replied with a comment starting `Waive: <reason>` (ignoring case and leading whitespace), is **waived**: the first run that sees it records the waiver durably (who, how, the reply's reason sanitized, and the thread's path, line and title) and logs it with run, repo, PR and who waived. A waiver is never revoked: later runs read waivers from the store, not GitHub, so unresolving the thread changes nothing. A waived thread counts as closed and never reaches the verifier. A finding a reviewer reports again that matches a waived thread (same path, and a nearby line or the same title) gets the `waived` outcome: it isn't posted and doesn't block. If it also matches a thread that isn't waived, it is handled as usual and blocks. `Waive:` from anyone else, or in the App's own comments and replies, never waives. A thread resolved by anyone else isn't waived: it stays a blocker, never reaches the verifier, and counts as closed only if the App had verified it fixed.
- When unresolved, unwaived threads remain, the verifier agent judges each at the current head, with the read-only repository tools (§6.2) and each thread's original diff hunk, comments and replies as untrusted data. It finishes with one `report_threads` call: per thread, resolved or open, and a short reply.
- Only comments from the App, the PR's author, and OWNER, MEMBER or COLLABORATOR authors reach the verifier: the people who could resolve the thread themselves. Anyone else's replies are dropped, and don't count as the author speaking last. Each comment reaches it labelled reviewer (the App), PR author, or maintainer; a PR author who is a maintainer is labelled both.
- When a maintainer's last reply states a decision not to fix the finding, the verifier keeps the thread open and, rather than arguing, replies that resolving the thread or replying `Waive: <reason>` waives it.
- If the verifier's report is malformed it is retried once, as reviewers are.
- A thread judged resolved gets the reply (prefixed `Resolved:`, ending with a hidden verified marker) and is resolved, unless a finding this run reported again (a `duplicate`) matches it by path and a nearby line or the same title: that thread stays open.
- GitHub may refuse to resolve (it can want more than pull request write). A thread counts as closed for approval once its verified reply is posted, whether or not resolving succeeds. On later runs, a thread whose last trusted comment is the App's verified reply skips the verifier and is resolved again; an author reply after it sends the thread back to the verifier. A refusal is logged once per run.
- A thread judged open gets the reply only when the author spoke last, so an unanswered thread isn't repeated on every push.
- Replies are sanitized like inline comments, and are only sent while the run is current and not superseded. A thread that fails to update stays open.

### 9.3 Summary body

- The reviewed revisions: `head@<sha7>`, `base@<sha7>`, followed by the result (how many issues were commented inline).
- The names of the focuses that ran. Fallback selection is noted where used.
- On an incremental review, the earlier head whose changes were already reviewed, and any focus that reviewed the whole PR because it didn't run on that review. Selection reasons stay in the run record: they are PR-influenced, and the names are enough for a reader.
- Any focuses that failed.
- Any skipped files or oversized-PR note.
- A hidden marker: `<!-- ai-review:{owner}/{repo}#{pr}:{head}:{base} -->`.

The summary does not repeat inline comment text.

### 9.4 Inline comment body

- The title in bold.
- A severity and focus badge.
- The evidence.
- The suggested fix as a GitHub `suggestion` block when it replaces exactly the anchored lines, and as prose otherwise.

Confidence is not shown to readers. It is stored in metadata only.

### 9.5 Idempotency

- The idempotency key is (repo, PR, head SHA, base SHA).
- Before posting, the publisher lists existing reviews on the PR. If one carries the matching marker, the run is recorded as `published` and nothing is posted again.
- Publish retries with backoff are safe because of this check.

## 10. GitHub App

**Permissions:**

- Contents: read.
- Pull requests: read and write. Write is needed to create reviews.
- Metadata: read.

The App must not request contents write, workflows, administration, or any permission that allows merging or pushing.

**Events:** `pull_request`, `pull_request_review_thread` and `pull_request_review_comment`, filtered in code to the actions in §3.1.

Webhook signatures are verified with the App's webhook secret. Unsigned or invalid deliveries are rejected.

## 11. Configuration

### 11.1 Deployment config (operator-owned, a file or env vars)

- GitHub App credentials and webhook secret.
- The OpenRouter key.
- The repository allowlist.
- `review_outside_prs`, the review label name, and the per-PR run cap.
- Per-agent `model` and `fallback_model`, and per-agent turn and token budgets.
- Default thresholds, `max_reviewers`, `max_comments`, `max_reviewable_lines`, and exclusions.
- Worker concurrency (default 2) and metadata retention (default 90 days).

### 11.2 Per-repo config (maintainer-owned)

- Lives at `.github/ai-review.yml`, **read from the base SHA only**. A PR that edits this file has no effect on its own review.
- It may only tighten or narrow settings:
  - disable non-mandatory focuses (any but correctness and security, documentation included);
  - add exclusions or path hints that bias selection;
  - raise thresholds;
  - lower the caps.
- It cannot set models, budgets, credentials, or author-gating policy, and it cannot disable correctness or security.
- Invalid per-repo config is ignored with a recorded warning, and deployment defaults apply.

## 12. Operations

- **Topology:** one service. The HTTP handler verifies the webhook, evaluates eligibility, enqueues the job, and returns 202 Accepted. An in-process worker loop processes jobs.
- **Storage:** SQLite in WAL mode on the persistent volume holds both the job queue and run metadata. The repository clone cache lives on the same volume.
- **Job dedup:** a second job for the same (repo, PR, head, base) while one is queued, running, or published is a no-op. A forced label re-review bypasses this.
- **Run metadata:**
  - the GitHub delivery ID and event;
  - author gating outcome;
  - selected focuses with reasons, and whether fallback was used;
  - the head and base SHAs;
  - per-agent model, tokens, cost, and status;
  - every finding with its validation outcome;
  - publish status and the review ID.
- **Retention:** metadata is pruned on startup and daily, past the retention window.
- **Failure handling:**
  - Source fetch: retry with backoff.
  - Reviewer: retry once, then mark the focus failed and continue with the others.
  - Orchestrator: fixed fallback (§5.2).
  - Publish: retry with backoff, guarded by the marker check (§9.5).
  - All failures are written to structured logs and run metadata.
- **Restart safety:** jobs left `running` at startup are re-queued. The idempotency marker prevents double-posting.
- **Dashboard:** a read-only HTML view of runs at `/admin`, served only when an admin password is set and behind HTTP Basic auth. Its home page lists PRs by their latest run (that run's status, the PR's verdict: whether its latest published review approved or only commented, its run count and cost; filter by repo or active PRs). A PR's page lists its runs and waivers; a run's page shows its recorded metadata, skipped files and blockers; a flat run list filters across PRs by status and full run or re-decision. Everything from the PR or a model is escaped, and no script runs on the page.

## 13. Acceptance criteria

1. A draft PR does not trigger a review when opened or updated.
2. Marking a draft PR ready starts a review.
3. A new commit pushed to a non-draft PR triggers a review of the new head SHA.
4. Reopening a non-draft PR triggers a review.
5. Reopening or updating a draft PR does not start a review until it is ready.
6. The orchestrator can select a subset of the six focuses and records a reason for each.
7. No code from the PR is executed during review.
8. Published findings are inline comments anchored to changed lines.
9. An empty result with no summary-worthy notes produces no review.
10. Duplicate event delivery does not duplicate comments.
11. If the PR head changes during analysis, the stale run publishes nothing.
12. The agent never merges or modifies the PR, and approves only under the opt-in rule in §9.1.
13. A non-draft `opened` PR triggers a review.
14. `converted_to_draft` or `closed` during a run results in nothing being published.
15. Retargeting the base branch triggers a re-review against the new base.
16. A finding already posted on an earlier head of the same PR is not posted again.
17. An outside-contributor PR without the review label is not reviewed, and applying the label reviews it.
18. Per-repo config is read from the base SHA, and a PR editing that config does not change its own review.
19. Reviewer tools cannot read anything outside the repository tree at the pinned SHA.
20. The service refuses to start if a configured model lacks tool support on OpenRouter.
21. A PR above `max_reviewable_lines` receives a summary recommending a split.
22. If one reviewer fails, the other reviewers' findings are still published, and the summary names the failed focus.
23. Each run records the model, tokens, and cost for every agent invocation.
24. Correctness, security and documentation run on every PR that changes code, regardless of orchestrator output, unless the repo disables documentation.

Every criterion must have a deterministic test using a fake GitHub client and a stubbed model.

## 14. Settled defaults (all configurable)

| Setting | Default |
|---|---|
| Publish threshold | severity ≥ medium, confidence ≥ 0.7 |
| `max_reviewers` | 4, at least 3 (correctness, security and documentation always included for code changes) |
| `max_comments` | 10 |
| `max_reviewable_lines` | 800 |
| Merge window for cross-reviewer duplicates | ±3 lines |
| Runs per PR per 24 h | 10 |
| Review label | `ai-review` |
| `review_outside_prs` | `label` |
| Worker concurrency | 2 |
| Metadata retention | 90 days |
| Summary-only posts | Only for oversized, skipped-file, or failed-focus notes |

## 15. Remaining implementation choices

- Implementation language (TypeScript on Node suggested: Octokit, `@octokit/webhooks`, `better-sqlite3`).
- The default model for each agent.
- Exact turn and token budgets per agent.
- The prompt text for each focus.
