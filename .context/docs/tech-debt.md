---
type: doc
name: tech-debt
description: Known gaps, with the reason they are still open
category: workflow
generated: 2026-11-24
status: filled
scaffoldVersion: "2.0.0"
---

# Technical debt

Known gaps, each with the reason it is still open and the issue that closes it.

| # | Gap | Why it is open | Closed by |
| --- | --- | --- | --- |
| TD-15 | A missing or unreadable `--env-file` exits with Node's code 9 (`node: <path>: not found`), not the CLI's usage code 2 | Node 24 and 26 check every `--env-file` path in `process.argv` at startup, even after the script name, before the CLI runs; the CLI's own exit 2 covers the cases that reach it, such as `--env-file` with no path | — (a Node release that stops reading `--env-file` after the script name; no Node issue is linked yet) |
| TD-14 | The Action has not run a stage end to end with a real agent, so the sandbox (on by default) is unverified on GitHub's runners: they may need `bubblewrap` and `socat`, and Ubuntu 24.04 restricts unprivileged user namespaces | It needs an agent credential stored as a repository secret, and the owner has not chosen one for CI (ADR 0004) | #8 |
| TD-13 | A Dependabot pull request that bumps a runtime dependency fails the `action` check until `dist/` is rebuilt on its branch | Rebuilding and pushing from a workflow needs a token that can write to Dependabot's branches; for now a person runs `npm run build:action` on the branch | — |
| TD-12 | `getMergeFacts` reads the first 100 changed files; a larger pull request may hide a denied path | Such a pull request is far over the default `maxChangedLines` (400) and is blocked for size first | — |
| TD-10 | `getFeedback` reads the first 100 review threads and 100 checks of a pull request | More than that is beyond what one round fixes; a person takes over | — |
| TD-3 | The ruleset's required checks list the CI job names, so renaming a job breaks merging | GitHub matches required checks by name | — (rename with the ruleset) |
