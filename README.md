# reviewer

Self-hostable GitHub code review agent. See `REQUIREMENTS.md`.

Each deployment is single-tenant: one operator, one GitHub App, one OpenRouter bill. It runs as one service with a
persistent disk, which holds SQLite (the job queue and run records) and a bare clone cache of the reviewed repositories.

Requires Node ≥ 22.18 and `git` on the PATH. No runtime dependencies.

```sh
npm install        # dev tooling only (typescript)
npm test
npm run typecheck
npm start
```

## Deploying

### 1. Create the GitHub App

Create the App on the account (user or organization) that owns the repositories to review. A private App can only be
installed on the account that owns it. Where this repository lives doesn't matter. On GitHub, go to that account's
**Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook:** active. The URL is the service's root, and the service accepts deliveries as `POST /`. The service
  doesn't exist yet, so enter a placeholder such as `https://example.com/` and replace it in step 2.
  Set a long random **webhook secret**, e.g. from `openssl rand -hex 32`. You need it again in step 2.
- **Repository permissions:** exactly these three.

  | Permission | Access | Used for |
  |---|---|---|
  | Contents | Read-only | `git fetch` of the PR's head and base commits |
  | Pull requests | Read and write | reading the PR and the App's own reviews; posting the review |
  | Metadata | Read-only | mandatory for every App |

  Leave everything else at **No access**. The App needs no contents write, workflows, administration, or any
  permission that could merge or push.
- **Subscribe to events:** **Pull request** only. The service ignores every other event and filters actions in code.
- **Where can this GitHub App be installed:** only on this account.

After creating it, note the **App ID** and generate a **private key** (a `.pem` download). Then **Install App** on the
repositories to review. Installing alone does nothing: a repository is reviewed only if it is also in `REPO_ALLOWLIST`.

### 2. Deploy on Render

`render.yaml` is a Blueprint for one web service, with a 10 GB disk mounted at `/var/data` and `DATA_DIR` pointing at it.
The service is created in its own Render project, `reviewer` (environment `production`), so it stays separate from
other projects in the workspace.
Disks need a paid instance type, so the Blueprint uses `starter`.

1. In Render, choose **New → Blueprint** and select the GitHub repository that holds this code, with `render.yaml` at
   its root. That's this repository if you own it. Otherwise fork it into your own account first, because Render
   deploys only from repositories your connected GitHub account can access.
2. Fill in the secrets it asks for: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`,
   `REPO_ALLOWLIST` and `REVIEW_MODEL`. For `GITHUB_PRIVATE_KEY`, paste the whole PEM. Newlines written as `\n` work too.
3. Once it is live, copy the service URL from the Render dashboard (e.g. `https://reviewer.onrender.com`; Render
   adds a suffix if the name is taken) and set it as the App's webhook URL in place of the placeholder. Deliveries
   sent before this fail harmlessly. Redeliver one from the App's **Advanced** tab or push again to trigger a review.

At startup the service checks every configured model against OpenRouter and refuses to start if one is unlisted or
lacks tool support. A failed deploy log naming a model means you need a different model ID.

To confirm the deployment works, open a non-draft PR on an allowlisted repository. A review appears within minutes,
or nothing does if the reviewers found nothing worth posting. Either way the run shows up in the logs and the run records.

Elsewhere: any host that runs `npm start` on Node ≥ 22.18 with `git` installed and a persistent `DATA_DIR`. Run one
instance only, because the queue lives in that instance's SQLite.

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
| `<AGENT>_MODEL`, `<AGENT>_FALLBACK_MODEL` | `REVIEW_MODEL`, `REVIEW_FALLBACK_MODEL` | Per-agent overrides; `<AGENT>` is `ORCHESTRATOR`, `CORRECTNESS`, `SECURITY`, `PERFORMANCE`, `ARCHITECTURE` or `CONCISENESS`. Startup fails if any configured model lacks tool support on OpenRouter |
| `<AGENT>_MAX_TURNS` | `20` | Model calls per reviewer invocation; over it, the reviewer fails |
| `<AGENT>_MAX_TOKENS` | `500000` | Input plus output tokens per invocation; over it, the agent fails |
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
| `DATA_DIR` | `./data` | Persistent volume for SQLite and bare clones |
| `PORT` | `3000` | HTTP port; Render sets it |

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

- **Logs** go to stdout, one JSON object per line: `level` (`info`, `warn` or `error`) and `msg`. Failures also carry
  `step`, `run`, `repo`, `pr` and `error`. `step` is one of:
  - `fetch`: the git fetch of the PR's commits;
  - `orchestrator`: focus selection, after which the fixed fallback is used;
  - `reviewer`: a focus reviewer's model call or budget;
  - `validation`: a reviewer's report that failed the schema check;
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
