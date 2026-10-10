# reviewer

Self-hostable GitHub code review agent. See `REQUIREMENTS.md`.

Requires Node ≥ 22.18 and `git` on the PATH. No runtime dependencies.

```sh
npm install        # dev tooling only (typescript)
npm test
npm run typecheck
npm start
```

## Deployment config (env vars)

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | App private key (PEM; `\n` escapes allowed) |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret |
| `REPO_ALLOWLIST` | Comma-separated `owner/repo` list |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `REVIEW_MODEL` | OpenRouter model ID for the reviewer |
| `MAX_REVIEWERS` | Reviewer cap per run, at least 2 (default `3`) |
| `REVIEW_OUTSIDE_PRS` | PRs from authors other than OWNER/MEMBER/COLLABORATOR: `label` (only while labelled, default), `always`, `never` |
| `REVIEW_LABEL` | Label that opts a PR in and triggers a (re-)review (default `ai-review`) |
| `RUN_CAP` | Max runs per PR per rolling 24 hours (default `10`) |
| `DATA_DIR` | Persistent volume for SQLite and bare clones (default `./data`) |
| `MAX_REVIEWABLE_LINES` | Above this many reviewable changed lines the summary recommends a split (default `800`) |
| `REVIEW_TOKEN_BUDGET` | Estimated diff tokens given to reviewers; files past it are skipped and listed (default `50000`) |
| `PORT` | HTTP port (default `3000`); point the App's webhook at `POST /` |

## Per-repo config (`.github/ai-review.yml`)

Read from the PR's **base** SHA only, so a PR that edits it doesn't change its own review. It can only tighten the deployment's settings. Anything invalid, loosening or unknown (models, budgets, credentials, author gating) is ignored, and a warning goes in the run record.

```yaml
disable_focuses: [performance, conciseness]  # correctness and security can't be disabled
exclude:                                     # added to the built-in exclusions; globs match the full path
  - "legacy/**"
path_hints:                                  # glob: note, given to the orchestrator for matching changed paths
  "src/billing/**": money handling, check rounding
thresholds:                                  # can only be raised
  severity: high
  confidence: 0.8
max_reviewers: 2                             # caps can only be lowered (max_reviewers at least 2)
max_comments: 5
max_reviewable_lines: 400
```

The parser accepts a strict YAML subset: top-level `key: value`, flow lists `[a, b]` (no commas inside items), and one level of indented `- item` lists or `key: value` maps, with quotes and `#` comments. Anything else makes the file malformed, and then it is ignored entirely.
