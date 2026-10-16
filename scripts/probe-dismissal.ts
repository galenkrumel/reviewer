// One-off probe for #49: can the App's installation token dismiss the App's own approval?
// Usage: GITHUB_APP_ID=… GITHUB_PRIVATE_KEY="$(cat key.pem)" node scripts/probe-dismissal.ts owner/repo <pr>
// The PR must not be authored by the App: it approves the PR, then tries to dismiss that approval.
// Use a throwaway PR: if the dismissal is refused, the App's approval stays and may count toward required reviews.
import { sign } from 'node:crypto';

const [repo, pr] = process.argv.slice(2);
if (!repo || !pr) throw new Error('usage: probe-dismissal.ts owner/repo <pr>');
const { GITHUB_APP_ID: appId, GITHUB_PRIVATE_KEY: key } = process.env;
if (!appId || !key) throw new Error('set GITHUB_APP_ID and GITHUB_PRIVATE_KEY');
const privateKey = key.replace(/\\n/g, '\n');

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
  JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
)}`;
const jwt = `${unsigned}.${b64url(sign('sha256', Buffer.from(unsigned), privateKey))}`;

// Prints status and GitHub's full body, which the adapter drops. A failed `must` call ends the probe there.
async function api(auth: string, method: string, path: string, body?: unknown, show = true, must = true): Promise<any> {
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
  if (show || !res.ok) console.log(JSON.stringify(json, null, 2));
  if (must && !res.ok) process.exit(1);
  return json;
}

const installation = await call(jwt, 'GET', `/repos/${repo}/installation`, undefined, false);
const minted = await call(jwt, 'POST', `/app/installations/${installation.id}/access_tokens`, undefined, false);
console.log('token permissions:', JSON.stringify(minted.permissions)); // never print the token itself
const token = minted.token;

const pull = await call(token, 'GET', `/repos/${repo}/pulls/${pr}`, undefined, false);
// Likely 403: the App has no administration permission. Note the branch's protection settings by hand.
await call(token, 'GET', `/repos/${repo}/branches/${pull.base.ref}/protection`, undefined, true, false);

const review = await call(token, 'POST', `/repos/${repo}/pulls/${pr}/reviews`, {
  event: 'APPROVE', body: 'Probe for #49: this approval is about to be dismissed.',
});
if (review.state !== 'APPROVED') throw new Error(`expected an APPROVED review, got ${review.state}`);
await call(token, 'PUT', `/repos/${repo}/pulls/${pr}/reviews/${review.id}/dismissals`, {
  message: 'Probe for #49.', event: 'DISMISS',
}, true, false);
