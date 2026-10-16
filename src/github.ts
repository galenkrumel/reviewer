// Real GitHub adapter: App JWT -> installation token -> REST calls.
import { sign } from 'node:crypto';
import type { GitHubPort, NewReview, ReviewThread } from './ports.ts';

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

  async function graphql(token: string, query: string, variables: object): Promise<any> {
    const res = await api(token, 'POST', '/graphql', { query, variables });
    if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors[0].message}`);
    return res.data;
  }

  // Reviews by this app are authored by `<slug>[bot]`.
  let botLogin: Promise<string> | undefined;
  const ownLogin = () => (botLogin ??= api(appJwt(), 'GET', '/app').then((a) => `${a.slug}[bot]`));

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
      // Every page: the idempotency marker check must see all of the PR's reviews.
      const login = await ownLogin();
      const out: { id: number; body: string }[] = [];
      for (let page = 1; ; page++) {
        const reviews = await api(token, 'GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`);
        for (const r of reviews) if (r.user?.login === login) out.push({ id: r.id, body: r.body ?? '' });
        if (reviews.length < 100) return out;
      }
    },
    async createReview(token, repo, number, review: NewReview) {
      const r = await api(token, 'POST', `/repos/${repo}/pulls/${number}/reviews`, review);
      return { id: r.id };
    },
    async reviewThreads(token, repo, number) {
      // GraphQL names a bot by its slug; REST appends [bot].
      const slug = (await ownLogin()).replace(/\[bot\]$/, '');
      const byApp = (login?: string) => login === slug || login === `${slug}[bot]`;
      const [owner, name] = repo.split('/');
      const out: ReviewThread[] = [];
      for (let after: string | null = null; ;) {
        const data = await graphql(token, `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) {
            author { login } authorAssociation
            reviewThreads(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { id isResolved resolvedBy { login } path line comments(first: 50) { nodes { author { login } authorAssociation body diffHunk } } }
            } } } }`, { owner, name, number, after });
        const prAuthor = data.repository.pullRequest.author?.login;
        // GraphQL gives no association for a thread's resolver. Only the PR's author or someone with write access
        // can resolve, so anyone else resolving is a collaborator at least.
        // ponytail: OWNER/MEMBER/COLLABORATOR inferred, not read; REST collaborators/{login}/permission if it matters.
        const resolver = (login = 'ghost') => ({
          login,
          association: login === prAuthor ? data.repository.pullRequest.authorAssociation
            : login === owner ? 'OWNER' : login === 'ghost' ? 'NONE' : 'COLLABORATOR',
        });
        const threads = data.repository.pullRequest.reviewThreads;
        for (const t of threads.nodes) {
          const comments = t.comments.nodes;
          if (!byApp(comments[0]?.author?.login)) continue;
          out.push({
            id: t.id, resolved: t.isResolved, ...(t.isResolved && { resolvedBy: resolver(t.resolvedBy?.login) }),
            path: t.path, line: t.line ?? null, diffHunk: comments[0].diffHunk ?? '',
            comments: comments.map((c: any) => ({
              byApp: byApp(c.author?.login), byPrAuthor: !!prAuthor && c.author?.login === prAuthor,
              association: c.authorAssociation ?? 'NONE', body: c.body ?? '',
            })),
          });
        }
        if (!threads.pageInfo.hasNextPage) return out;
        after = threads.pageInfo.endCursor;
      }
    },
    async replyToThread(token, threadId, body) {
      await graphql(token, `mutation($id: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`,
      { id: threadId, body });
    },
    async resolveThread(token, threadId) {
      await graphql(token, `mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id } } }`,
        { id: threadId });
    },
  };
}
