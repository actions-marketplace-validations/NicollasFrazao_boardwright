---
type: doc
name: security
description: Threat model, tokens and credentials, the trigger and guard rails, known gaps, how to report a vulnerability
category: security
generated: 2026-11-24
status: filled
scaffoldVersion: "2.0.0"
---

# Security

## Security & Compliance Notes

boardwright gives an agent write access to repositories. The security model is that the agent can do
no more than its stage allows, whatever the issue text says, and that the people who can start it are
the people who could have made the change themselves.

## Threat model

| Threat | Control |
| --- | --- |
| A stranger's issue steers an agent | The trigger label counts only when added by someone with triage access |
| Prompt injection asks the agent to edit CI or exfiltrate secrets | Path denylist (`.github/workflows/**`, secret files) in the session and on the diff; tokens never in the agent environment beyond what the stage needs |
| An agent merges unreviewed code | No merge outside the opt-in merge stage; its policy is deterministic code, and auto-merge still passes the ruleset |
| A token with bypass rights skips the ruleset | Tokens need no bypass; the docs require tokens without it |
| Runaway cost or loops | `maxTurns`, timeout and `maxAttempts` per stage; one run per item |
| Two runners act on the same item | The claim marker and idempotent actions |
| Anyone who can open an issue gets it onto the board (`board.addNewIssues`) | Being on the board releases nothing: a stage still needs the trigger label, added by someone with triage access; hygiene only adds items, fills fields from the repository's own items and moves parents, never runs an agent |

## Authentication & Authorization

- **Board token:** classic token with the `project` scope (user projects are not reachable with the
  default `GITHUB_TOKEN`). The CLI reads it from `BOARDWRIGHT_GITHUB_TOKEN`, `GITHUB_TOKEN` or
  `GH_TOKEN`, in that order, and hands it only to the Octokit client, whose request log is silenced.
- **Who released an issue:** the most recent person who added the trigger label, read from the issue's
  events, with their role from the collaborator permission API. A bot or a non-collaborator has no
  permission, so it can never start an agent.
- **Repository token:** fine-grained, contents/pull requests/issues read-write on the allowlisted
  repositories; pull requests opened with the default token do not trigger CI.
- **Merge identity (opt-in):** a GitHub App (`BOARDWRIGHT_APP_ID` with its key, ADR 0005) or
  `BOARDWRIGHT_MERGE_TOKEN`, either separate from the token that opened the pull request; `once` refuses
  to run a config with a merge stage without one. The App's key is read from a file or a secret, never
  stored by boardwright, and its installation tokens last an hour; the key's variable is removed from the
  agent's environment, and the agent's sandbox denies reading `~/.config/boardwright`.
- **The App writes as the pipeline:** with an App, the run markers, the plan, the notices, the reviews and
  the resolved threads go out as `<app>[bot]`; the board, the push and the pull request stay on the main
  token (GitHub Apps cannot reach a personal account's Projects v2, and the App must not be the author of
  the pull requests it may approve). The merger merges at the
  evaluated head commit (`sha`), so a push after the evaluation fails the merge instead of merging
  unchecked commits, and it never bypasses the ruleset: it falls back to native auto-merge.
- **Markers come only from the pipeline:** run markers in issue comments and review markers in pull
  request reviews count only when the account of the pipeline's token or its GitHub App wrote them.
  Anyone else's comment or review that carries a marker is ignored, so nobody can forge a run's history
  or a review's verdict.
- **Merge gatekeeper (`mode: agent`):** a read-only session asked only after the policy passed. It can
  veto a merge, never force one, and the policy is judged again after it before anything is merged.
- **Agent credentials:** only the Agent SDK's documented methods (`ANTHROPIC_API_KEY`, Bedrock, Claude
  Platform on AWS, Google Cloud, Foundry), never a claude.ai login, and never stored or managed by
  boardwright. See [ADR 0004](./adr/0004-agent-credentials-through-documented-methods.md).

## What an agent session can do

The Claude provider (`packages/agent-claude/src/claude-provider.ts`) starts every session with:

- `permissionMode: 'dontAsk'` and a closed list of tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`,
  `TodoWrite`, plus dotcontext's read tools when the repository has a `.context` base); everything else is
  denied, and `WebFetch`, `WebSearch` and dotcontext's `sync` are denied even if the repository's settings
  allow them;
- a `PreToolUse` hook that denies writes to a denied path or outside the worktree, reads (`Read`, `Glob`,
  `Grep`) outside the worktree, home-relative paths (`~`) included, and shell commands that push or call
  `gh`;
- shell commands in the Claude Code sandbox (`provider.sandbox`, on by default): they cannot read the
  usual credential files of the machine's home (the GitHub CLI's token, boardwright's App key, SSH and
  cloud keys, registry tokens), they reach only the listed hosts, and they cannot retry outside the
  sandbox. On Linux it needs `bubblewrap` and `socat`; without them the session refuses to start rather
  than run unsandboxed. `allowUnixSockets` (off by default) lets commands reach Unix sockets, such as a
  test database's; because the Linux sandbox cannot allow one socket by path, it allows every socket the
  files let a command reach, and the provider hides the dangerous ones: Docker and containerd, the
  user's runtime directories (the Claude sessions, D-Bus, GnuPG, SSH agents), the system D-Bus, X11,
  snapd, and the directory of `SSH_AUTH_SOCK`;
- the environment without `BOARDWRIGHT_GITHUB_TOKEN`, `BOARDWRIGHT_MERGE_TOKEN`, `BOARDWRIGHT_APP_PRIVATE_KEY`,
  `GITHUB_TOKEN` and `GH_TOKEN`;
- only the project's settings (`settingSources: ['project']`), not the machine user's;
- for a review or a plan, read tools only (`Read`, `Glob`, `Grep`, `Bash`) with `Edit`, `Write`, `MultiEdit` and
  `NotebookEdit` denied; its worktree is thrown away and nothing is pushed. Its review only comments,
  unless the stage sets `approve`: then the GitHub App (ADR 0005) submits the verdict as an approval or a
  change request, and the agent's approval stands in for a person's review.
- for address-feedback, the review comments and check names are fenced as input like the issue, and
  only the core resolves threads: the agent names the ones it addressed, and the core resolves those
  that were in the feedback it read, with or without a commit (a thread can need no change).

The git workspaces give the token to the runner's own `clone`, `fetch` and `push` through the commands'
`GIT_CONFIG_*` environment; it is never written to `.git/config`, so the agent cannot read it, and its own
`git push` has no credentials. The core still checks the diff against the denylist before pushing.

## The GitHub Action

- The CLI runs as a child process with an environment the Action builds: the inputs (`INPUT_*`, which hold
  the tokens) and the Actions runtime's own credentials (`ACTIONS_RUNTIME_TOKEN`, the OIDC request token,
  the cache and results URLs) are left out; the tokens go back in only as `BOARDWRIGHT_GITHUB_TOKEN` and
  `BOARDWRIGHT_MERGE_TOKEN`, which the Claude provider removes from the agent's environment. An agent in
  the Action can therefore not write to the Actions cache, upload artifacts or mint an OIDC token.
- The agent's credentials are the step's `env`, not inputs, so boardwright never handles them (ADR 0004).
- The Agent SDK and its native binary are not in the repository. The Action downloads them from the npm
  registry at the versions `package-lock.json` pins and checks each tarball against the lockfile's
  `sha512` integrity before unpacking; a mismatch stops the run with nothing installed.
- A workflow that runs the Action on `pull_request` from a fork gets no secrets, so the tick fails on the
  missing token. Never run it on `pull_request_target`: the board token would meet untrusted code.

## Releases

The npm package is published only by `release.yml`, through npm trusted publishing: npm accepts the
workflow's OIDC token for this repository and workflow file, so no npm token exists to leak, and every
version carries a provenance attestation that links it to the commit it was built from. The job runs in
the `npm` environment, which only deploys `v*` tags, and npm trusts only that workflow file in that
environment: a branch, a pull request or another workflow cannot publish. The first version, 0.1.0, was
published by hand, because trusted publishing can only be set up for a package that exists.

## Secrets & Sensitive Data

Tokens are read only in the composition roots, never logged, never written to a marker, comment,
artifact or dotcontext harness trace. Logs are JSON and redact any value read from a secret.

## Known gaps

- The issue text is untrusted input to a model; the controls above limit what it can cause, not what
  it can say. Labelling an issue is a trust decision.
- Subscription use: the terms check of #5 is recorded in
  [ADR 0004](./adr/0004-agent-credentials-through-documented-methods.md). boardwright never offers,
  detects or handles a claude.ai login, and does not decide whether a person may run their own tools on
  their own subscription; that is between them and Anthropic's terms.

## Incident Response

Report vulnerabilities privately through
[private vulnerability reporting](https://github.com/NicollasFrazao/boardwright/security/advisories/new);
see `SECURITY.md` for scope.
