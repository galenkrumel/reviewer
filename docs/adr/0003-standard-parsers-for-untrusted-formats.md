# Untrusted archives and formats are read with the standard library for them

Status: accepted. The tar reader moved to node-tar (`tar`).

Untrusted input in a standard format is read with the library its ecosystem itself uses, never with a parser written here. For npm tarballs that is node-tar, the parser npm extracts with. Reading exactly as the installer reads is the whole point of inspecting a tarball, and a second parser can only drift from it.

"No runtime dependencies" was never a decision. It was read off `package.json` while #79 was being planned, and it produced an in-house tar reader. PR #98 spent 16 review rounds and 28 commits matching that reader to node-tar's handling of pax records, GNU long names, checksums and block framing, one edge case at a time. With node-tar doing the parsing, that whole class of finding is gone. What remains in our code is the policy on top: which entry types and paths are refused as unreadable, so the package is not inspected.

## Considered Options

- **Keep the in-house reader, made fail-closed** (read only plain ustar files and directories, refuse everything else). Rejected: it would refuse real packages npm installs fine, and it would still be a parser to review for drift.
- **Extract to disk with `tar.x`, as npm does.** Rejected for now: the check holds tarballs in memory under its byte caps, and its path refusals already cover what extraction would decide.

## Consequences

- `tar` is the first runtime dependency. Deploys already run `npm ci --omit=dev`.
- A dependency is weighed on its merits. It isn't avoided by default. The pnpm lockfile reader (`src/pnpmlock.ts`) came from the same assumption. A PR author controls the lockfile, so it should be read with the YAML parser pnpm itself reads lockfiles with.
