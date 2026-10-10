// Real GitHub adapter: App JWT -> installation token -> REST calls.
import { sign } from 'node:crypto';
import type { GitHubPort, NewReview } from './ports.ts';

const API = 'https://api.github.com';
const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

export function gitHubApp(appId: string, privateKey: string): GitHubPort {
  function appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
    )}`;
    return `${unsigned}.${b64url(sign('sha256', Buffer.from(unsigned), privateKey))}`;
  }

  async function api(auth: string, method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${auth}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'reviewer',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
    return res.json();
  }

  return {
    async mintToken(installationId) {
      return (await api(appJwt(), 'POST', `/app/installations/${installationId}/access_tokens`)).token;
    },
    cloneUrl: (repo) => `https://github.com/${repo}.git`,
    async getPullRequest(token, repo, number) {
      const pr = await api(token, 'GET', `/repos/${repo}/pulls/${number}`);
      return { number: pr.number, state: pr.state, draft: pr.draft, headSha: pr.head.sha, baseSha: pr.base.sha };
    },
    async listReviews(token, repo, number) {
      // ponytail: first 100 reviews only; paginate if PRs ever carry more.
      const reviews = await api(token, 'GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100`);
      return reviews.map((r: any) => ({ id: r.id, body: r.body ?? '' }));
    },
    async createReview(token, repo, number, review: NewReview) {
      const r = await api(token, 'POST', `/repos/${repo}/pulls/${number}/reviews`, review);
      return { id: r.id };
    },
  };
}
