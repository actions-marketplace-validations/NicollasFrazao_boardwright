# 0005. A GitHub App is the pipeline's own identity for what it says, reviews and merges

- Status: accepted
- Date: 2026-11-25
- Relates to: [0003](./0003-deterministic-merge-policy.md), which keeps "who opened" and "who merged" distinct

## Context

Everything the pipeline writes goes out under one person's token: the run markers, the plan, the reviews,
the notices, the pull requests. Three problems follow.

- The review stage cannot approve. GitHub does not let the author of a pull request approve it, so a
  ruleset that requires approving reviews waits for a person, even when the review found nothing (#59).
- The merge stage needs a second identity (ADR 0003), and the owner has no second account (#7).
- GitHub does not notify a person about their own comments. The owner is never notified of what the
  pipeline writes, and the history does not tell the pipeline from the person.

## Options

1. **A machine account with a long-lived token.** GitHub's terms allow one per person. It is a second
   account to keep, and its token never expires.
2. **The Action's `GITHUB_TOKEN` (`github-actions[bot]`).** It needs no new identity, but it works only in
   the Action, approving needs a repository setting that lets every workflow approve, and the local
   runner has nothing like it.
3. **A GitHub App the owner registers and installs on the repositories the pipeline works on.** It acts
   as `<app>[bot]`, and its installation tokens expire after an hour. Installing it on selected
   repositories limits what a leaked key reaches.

## Decision

Option 3. The identities are split as follows.

| Action | Identity |
| --- | --- |
| Read the board, move cards | The owner's token. A GitHub App cannot access a personal account's Projects v2. |
| Push the branch, open the pull request | The owner's token, so the App is not the author and can approve |
| Run markers, the plan, comments, notices | The App |
| Reviews (`COMMENT`, `APPROVE`, `REQUEST_CHANGES`) and resolving threads | The App |
| Merge | The App |

- The App asks only for what these actions need: contents, pull requests and issues with write access,
  and checks with read access.
- Approving is opt-in per repository. An agent's approval satisfies a rule meant to guarantee a person's
  review, so turning it on is a trust decision. Every other guard still holds: required checks,
  resolved threads, the merge policy and `boardwright:hold`.
- boardwright never stores the App's key. The local runner reads it from a path the owner configures and
  mints installation tokens, renewing them before they expire. In CI, `actions/create-github-app-token`
  mints the token, and the key stays a secret.
- The App's credentials never reach the agent. Tokens are removed from the agent's environment like the
  others. The agent session's guard and sandbox keep the key file out of the agent's reach: reads stay
  inside the worktree, and shell commands cannot read credential files.

## Consequences

- Rulesets that require approving reviews can pass without a person, when the owner turns approving on.
- The App replaces `BOARDWRIGHT_MERGE_TOKEN` as the merge stage's identity. The token stays as a fallback
  for setups without an App.
- The owner is notified of what the pipeline writes, and the history shows which actor did what.
- A second, reviewer-only App would take the owner's account out of everything but the board. That is a
  later option, not part of this decision.
