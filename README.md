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
| `DATA_DIR` | Persistent volume for SQLite and bare clones (default `./data`) |
| `PORT` | HTTP port (default `3000`); point the App's webhook at `POST /` |
