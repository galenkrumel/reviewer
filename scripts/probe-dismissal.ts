// One-off probe for #49: can the App's installation token dismiss the App's own approval?
// Usage: GITHUB_APP_ID=… GITHUB_PRIVATE_KEY="$(cat key.pem)" node scripts/probe-dismissal.ts owner/repo <pr>
// The PR must not be authored by the App: it approves the PR, then tries to dismiss that approval.
import { sign } from 'node:crypto';

const [repo, pr] = process.argv.slice(2);
if (!repo || !pr) throw new Error('usage: probe-dismissal.ts owner/repo <pr>');
const appId = process.env.GITHUB_APP_ID!;
const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, '\n');

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
  JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
)}`;
const jwt = `${unsigned}.${b64url(sign('sha256', Buffer.from(unsigned), privateKey))}`;

// Prints status and GitHub's full body, which the adapter drops.
async function call(auth: string, method: string, path: string, body?: unknown, show = true): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'reviewer-probe',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  console.log(`\n${method} ${path} -> ${res.status}`);
  if (show) console.log(JSON.stringify(json, null, 2));
  return json;
}

const installation = await call(jwt, 'GET', `/repos/${repo}/installation`, undefined, false);
const minted = await call(jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, false);
console.log('token permissions:', JSON.stringify(minted.permissions)); // never print the token itself
const token = minted.token;

const pull = await call(token, 'GET', `/repos/${repo}/pulls/${pr}`, undefined, false);
await call(token, 'GET', `/repos/${repo}/branches/${pull.base.ref}/protection`); // likely 403: no administration permission

const review = await call(token, 'POST', `/repos/${repo}/pulls/${pr}/reviews`, {
  event: 'APPROVE', body: 'Probe for #49: this approval is about to be dismissed.',
});
await call(token, 'PUT', `/repos/${repo}/pulls/${pr}/reviews/${review.id}/dismissals`, {
  message: 'Probe for #49.', event: 'DISMISS',
});
