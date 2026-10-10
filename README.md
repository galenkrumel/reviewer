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
| `REVIEW_OUTSIDE_PRS` | PRs from authors other than OWNER/MEMBER/COLLABORATOR: `label` (only while labelled, default), `always`, `never` |
| `REVIEW_LABEL` | Label that opts a PR in and triggers a (re-)review (default `ai-review`) |
| `RUN_CAP` | Max runs per PR per rolling 24 hours (default `10`) |
| `DATA_DIR` | Persistent volume for SQLite and bare clones (default `./data`) |
| `MAX_REVIEWABLE_LINES` | Above this many reviewable changed lines the summary recommends a split (default `800`) |
| `REVIEW_TOKEN_BUDGET` | Estimated diff tokens given to reviewers; files past it are skipped and listed (default `50000`) |
| `PORT` | HTTP port (default `3000`); point the App's webhook at `POST /` |
