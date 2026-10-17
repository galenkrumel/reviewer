# reviewer

`reviewer` is a self-hosted GitHub App that reviews your pull requests and posts its findings as review comments.
It only reads the code changes. It never runs your code, pushes commits, or merges.

Each review runs a few focused AI reviewers: *Correctness* and *Security* always, plus *Architecture*, *Performance*
or *Conciseness* when the change calls for them. When you push new commits, it reviews again and checks whether its
earlier comments were addressed. It never approves a PR unless you turn that on with
[`APPROVE_WHEN_CLEAN`](#deployment-config-env-vars).

The reviewers will sometimes disagree with you or your coding agent. That's expected. Treat the comments as a second
opinion, not a verdict.

## Get your first review

You'll need:

- A **GitHub** account (user or organization) that owns the repositories you want reviewed
- An **OpenRouter** API key from [openrouter.ai](https://openrouter.ai). Model usage is billed there
- A **Render** account on a paid plan, because the service needs a persistent disk (a `starter` instance is enough)

There are three steps: create a GitHub App, deploy on Render, then point the App at the service.

### 1. Create a GitHub App

On the account that owns the repositories, go to **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook URL:** enter a placeholder like `https://example.com/` for now. You'll replace it in step 3.
- **Webhook secret:** a long random string, e.g. from `openssl rand -hex 32`. Save it for step 2.
- **Repository permissions:** set exactly these three and leave everything else at **No access**:

  | Permission | Access | Used for |
  |---|---|---|
  | Contents | Read-only | fetching the PR's commits |
  | Pull requests | Read and write | reading the PR and posting the review |
  | Metadata | Read-only | required for every App |

- **Subscribe to events:** **Pull request** and **Pull request review thread**. The second lets a maintainer's resolve of the App's thread update its approval within seconds.
- **Where can this GitHub App be installed:** only on this account.

Create the App, then:

1. Note its **App ID**.
2. Generate a **private key**. A `.pem` file downloads.
3. Click **Install App** and choose the repositories to review.

### 2. Deploy on Render

1. Fork this repository if you don't own it. Render can only deploy from repositories your account can access.
2. In Render, choose **New → Blueprint** and select your copy. Render reads `render.yaml` from it.
3. Fill in the values it asks for:

   | Variable | What to enter |
   |---|---|
   | `GITHUB_APP_ID` | The App ID from step 1 |
   | `GITHUB_PRIVATE_KEY` | The full contents of the `.pem` file |
   | `GITHUB_WEBHOOK_SECRET` | The webhook secret from step 1 |
   | `OPENROUTER_API_KEY` | Your OpenRouter key |
   | `REPO_ALLOWLIST` | The repositories to review, comma-separated, e.g. `your-org/api,your-org/web` |
   | `REVIEW_MODEL` | An OpenRouter model ID that supports tool use |

Only repositories in `REPO_ALLOWLIST` are reviewed. Installing the App on a repository isn't enough on its own.

If the deploy fails with an error naming a model, OpenRouter doesn't list that model ID or the model doesn't support
tool use. Pick a different one.

### 3. Point the App at the service

Once the service is live, copy its URL from the Render dashboard (e.g. `https://reviewer.onrender.com`). Paste it into
the App's **Webhook URL** in place of the placeholder.

### Check that it works

Open a pull request that:

- isn't a draft,
- is in a repository listed in `REPO_ALLOWLIST`,
- is by the repository's owner, an organization member or a collaborator. PRs from anyone else are reviewed only once
  you add the `ai-review` label.

A review should appear within a few minutes. If the reviewers find nothing, its summary says "no issues to comment on".
Nothing showing up? See [Troubleshooting](#troubleshooting).

## Troubleshooting

Open the service's logs in Render. Every webhook GitHub sends logs a `delivery` line, and every review logs a
`run finished` line.

- **No `delivery` lines:** GitHub isn't reaching the service. Check the App's webhook URL, and look at
  **Advanced → Recent Deliveries** in the App settings. You can redeliver a failed event from there.
- **`delivery` with status 401:** `GITHUB_WEBHOOK_SECRET` doesn't match the App's webhook secret.
- **`delivery` but no review:** the line's `reason` says why it was skipped, e.g. the repository isn't in
  `REPO_ALLOWLIST`, the PR is a draft, or the author is outside and the PR lacks the label.
- **`run finished` with an `error`:** the error names the step that failed. See [Operating](#operating).

## Local development

Requires Node ≥ 22.18 and `git` on your `PATH`. There are no npm runtime dependencies: `npm install` only installs
TypeScript for type checking.

```sh
npm install
npm test
npm run typecheck
```

To run the service locally, set the six variables from step 2, then run `npm start`. You can keep them in a `.env` file
and run `node --env-file=.env src/main.ts` instead. Data goes to `./data` unless you set `DATA_DIR`. GitHub needs a
public URL to send webhooks to, so expose the local port through a tunnel.

Hosting somewhere other than Render works too: any host that runs `npm start` on Node ≥ 22.18 with `git` installed and
a persistent `DATA_DIR`. Run one instance only, because the job queue lives in that instance's SQLite database.

---

Everything below is reference material.

## Deployment config (env vars)

Required:

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | App private key (PEM; `\n` escapes allowed) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret; deliveries without a valid signature are rejected |
| `REPO_ALLOWLIST` | Comma-separated `owner/repo` list; nothing else is reviewed |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `REVIEW_MODEL` | Default OpenRouter model ID for every agent |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_FALLBACK_MODEL` | none | Default fallback model, passed in OpenRouter's `models` array |
| `<AGENT>_MODEL`, `<AGENT>_FALLBACK_MODEL` | `REVIEW_MODEL`, `REVIEW_FALLBACK_MODEL` | Per-agent overrides; `<AGENT>` is `ORCHESTRATOR`, `VERIFIER`, `CORRECTNESS`, `SECURITY`, `PERFORMANCE`, `ARCHITECTURE` or `CONCISENESS`. Startup fails if any configured model lacks tool support on OpenRouter |
| `<AGENT>_MAX_TURNS` | `20` | Model calls per reviewer or verifier invocation; over it, the agent fails |
| `<AGENT>_MAX_TOKENS` | `2000000` | Input plus output tokens per invocation, summed over its calls; each call resends the whole conversation, so this grows with every turn. Over it, the agent fails |
| `MAX_REVIEWERS` | `3` | Reviewer cap per run, at least 2 (correctness and security always run on code changes) |
| `REVIEW_OUTSIDE_PRS` | `label` | PRs from authors other than OWNER/MEMBER/COLLABORATOR: `label` (only while labelled), `always`, `never` |
| `REVIEW_LABEL` | `ai-review` | Label that opts a PR in and triggers a (re-)review |
| `RUN_CAP` | `10` | Max runs per PR per rolling 24 hours; further events are recorded as `skipped` |
| `MIN_SEVERITY` | `medium` | Findings below this severity (`low`, `medium`, `high`, `critical`) are not posted |
| `MIN_CONFIDENCE` | `0.7` | Findings below this confidence (0 to 1) are not posted |
| `MAX_COMMENTS` | `10` | Inline comments per review, highest severity × confidence first |
| `MAX_REVIEWABLE_LINES` | `800` | Above this many reviewable changed lines the summary recommends a split |
| `REVIEW_TOKEN_BUDGET` | `50000` | Estimated diff tokens given to reviewers; files past it are skipped and listed |
| `WORKER_CONCURRENCY` | `2` | Jobs reviewed at once |
| `RETENTION_DAYS` | `90` | Finished run records older than this are deleted, at startup and daily |
| `APPROVE_WHEN_CLEAN` | `false` | `true` approves the PR when a run finds nothing, every reviewer finished, nothing went unreviewed, and every thread the App started is resolved or verified fixed (the App resolves threads it verifies; without contents write, GitHub may refuse, and the threads stay visibly open). Otherwise every run posts a review whose **Not approved:** line names what blocks it. See the note below |
| `DATA_DIR` | `./data` | Persistent volume for SQLite and bare clones |
| `PORT` | `3000` | HTTP port; Render sets it |

**About `APPROVE_WHEN_CLEAN`:** the approval is a model's judgment over content the PR author controls. The author can resolve the App's threads without fixing anything, and the verifier, which resolves threads it judges fixed, reads the author's replies. Treat it as a signal, never as the review that branch protection requires: keep a human approval required, and turn on "Dismiss stale pull request approvals when new commits are pushed".

When a later run doesn't approve, the App dismisses its own earlier approval. On a branch without protection, GitHub accepts the dismissal with the App's permissions from step 1. A protected branch is untested. "Restrict who can dismiss pull request reviews" exists only on organization repositories, and there it may refuse the dismissal unless the App is on that allowlist; if it does, the App's review says the earlier approval could not be dismissed. "Dismiss stale pull request approvals when new commits are pushed" covers the common case on its own: a push clears the approval before the App's next run.

## Per-repo config (`.github/ai-review.yml`)

Read from the PR's **base** SHA only, so a PR that edits it doesn't change its own review. It can only tighten the deployment's settings. Anything invalid, loosening or unknown (models, budgets, credentials, author gating) is ignored, and a warning goes in the run record.

```yaml
disable_focuses: [performance, conciseness]  # correctness and security can't be disabled
exclude:                                     # added to the built-in exclusions; globs match the full path
  - "legacy/"                                # a trailing slash means the whole directory
path_hints:                                  # glob: note, given to the orchestrator for matching changed paths
  "src/billing/**": money handling, check rounding
thresholds:                                  # can only be raised
  severity: high
  confidence: 0.8
max_reviewers: 2                             # caps can only be lowered (max_reviewers at least 2)
max_comments: 5
max_reviewable_lines: 400
```

The parser accepts a strict YAML subset: top-level `key: value`, flow lists `[a, b]` (no commas inside items), and one level of `- item` lists (indented or not) or indented `key: value` maps, with quotes and `#` comments. Anything else makes the file malformed, and then it is ignored entirely.

## Operating

- **Logs** go to stdout, one JSON object per line: `level` (`info`, `warn` or `error`) and `msg`.
  - Every webhook delivery logs `delivery` with `event`, the HTTP `status` returned, and a `reason` if it was not queued.
    A `warn` with status 401 means the signature didn't match: `GITHUB_WEBHOOK_SECRET` differs from the App's secret.
    No `delivery` lines at all means GitHub isn't reaching the service: check the App's webhook URL and its
    **Advanced → Recent Deliveries**.
  - Every run logs `run finished` with `run`, `repo`, `pr`, `status`, `reviewId`, `error` and `cost` (USD).
  - Failures also carry `step`, `run`, `repo`, `pr` and `error`. `step` is one of:
  - `fetch`: the git fetch of the PR's commits;
  - `orchestrator`: focus selection, after which the fixed fallback is used;
  - `reviewer`: a focus reviewer's model call or budget;
  - `validation`: a reviewer's report that failed the schema check;
  - `verifier`: re-checking the App's open threads, after which they all count as open;
  - `threads`: reading, answering or resolving the App's threads;
  - `publish`: posting the review;
  - `run`: anything else, such as a token mint or PR lookup.

  `warn` means the step is being retried or fell back, and `error` means it gave up. Logs never contain credentials.
- **Retries:** fetch and publish are tried four times, with 2 s, 8 s and 32 s backoff. Before each publish attempt the
  service looks for its own review marker on the PR, so a post that actually went through is never repeated. A
  reviewer is retried once, and if it still fails, its focus is marked failed and the other reviewers' findings are
  still posted.
- **Run records** are in `$DATA_DIR/reviewer.db`, table `runs`. A failed run has status `failed` and an `error`
  prefixed with its step, e.g. `fetch: …`. Per-focus status, per-agent model, tokens and cost, and every finding's
  validation outcome are in the `focuses`, `invocations` and `findings` tables.
- **Restarts** are safe: jobs left `running` are re-queued, and the review marker prevents double-posting.
- **Disk:** the clone cache is blobless and grows with the reviewed repositories. To reclaim space, stop the service and
  delete `$DATA_DIR/repos`, which is re-fetched on demand.
