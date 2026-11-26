---
type: doc
name: architecture
description: Packages and their layer rules, the reconciliation loop, state on GitHub, stages and guard rails
category: architecture
generated: 2026-11-24
status: filled
scaffoldVersion: "2.0.0"
---

# Architecture

## Architecture Overview

One core, two runtimes. The core decides; adapters touch the outside world; the runner and the Action
only wire them together. Every runtime runs the same `tick()`, so a pipeline behaves the same on a
laptop and in GitHub Actions.

```
            ┌──────────── packages/runner (CLI, daemon) ─────┐
            │       action.ts → dist/ (GitHub Action)        │   composition roots
            └───────────────┬───────────────────┬─────────────┘
                            │                   │
   packages/github ─────────┤                   ├───────── packages/agent-claude
   (BoardPort, RepoHostPort)│                   │          (AgentProvider)
                            ▼                   ▼
                    packages/core: application  (tick, stages, merge policy)
                                   domain       (pure types and rules)
```

## Packages

| Package | Layer | Responsibility | Issue |
| --- | --- | --- | --- |
| `packages/core` (`src/domain`) | Domain | Work items, stages, run markers, guard-rail and merge-policy rules; pure | #3 |
| `packages/core` (`src/application`) | Application | Config schema (zod), ports, `tick()` | #3 |
| `packages/context` | Infrastructure | `ContextProvider`: the repository's dotcontext base, or `AGENTS.md`/`CLAUDE.md` | #3 |
| `packages/github` | Infrastructure | `BoardPort` on a Projects v2 board of a user or an organization (GraphQL); `RepoHostPort` on the REST API: issues, comments, the labeller from the issue's events, pull requests, labels, files | #4 |
| `packages/git` | Infrastructure | `WorkspacePort` on the git CLI: a cached clone per repository, a worktree per run, push without force | #5 |
| `packages/agent-claude` | Infrastructure | `AgentProvider` on the Claude Agent SDK: a closed tool list, a `PreToolUse` guard, a token-free environment, a structured report | #5 |
| `packages/runner` | Interface | CLI: `doctor`, `once` (with `--dry-run`), `init`, and the daemon `run`: ticks on an interval with exponential backoff while ticks fail (up to 15 minutes), stops after the current tick on SIGINT/SIGTERM, and holds a lock file per board so a second runner on the machine refuses to start | #4, #5, #8 |
| `packages/testing` | (tests only) | Fakes of every port and a replay of the GitHub API; no `src` may import it | #4 |
| `action.yml`, `packages/runner/src/action.ts` | Interface | GitHub Action: one `once` per workflow run, from the bundle in `dist/` (see [tooling.md](tooling.md), "The Action's build") | #8 |

## Layer rules

Checked by dependency-cruiser (`npm run check:architecture`, `.dependency-cruiser.cjs`):

- `core/src/domain` imports only Node built-ins.
- `core/src/application` imports only the domain and zod.
- `core` imports no other package.
- An adapter (`context`, `git`, `github`, `agent-*`) imports only the core, never another adapter.
- Outside the core, only its public API (`packages/core/src/index.ts`) is imported.
- Nothing imports `runner`: it is the composition root of both the CLI (`cli.ts`) and the Action (`action.ts`).
- Source never imports tests; published code never needs a devDependency at run time.
- No `src` imports `packages/testing`.
- No cycles, no orphan modules.

**Why:** a new provider or a new runtime is then one package that implements a port. Nothing in the
core changes, and nothing in one adapter can break another.

## The reconciliation loop

`tick()` is the only behaviour. It reads the board, decides what each item needs for its Status, and
acts. Each action is idempotent, so a tick can be repeated, interrupted or run by two runners without
doing the work twice:

1. Read the board and, when the config turns it on, tidy it (`application/board-hygiene.ts`, rules in
   `domain/board-hygiene.ts`): add new issues, fill inferred fields, move parents whose sub-issues
   started. Each change is checked against the board as read, so a repeated tick does nothing; if
   anything changed, the board is read again. Then, for each stage, take the items in its `when` Status.
2. Plan each item (`packages/core/src/application/tick.ts`): repository allowlist, open issue, trigger
   label added by someone with triage, then the markers decide (`domain/run-decision.ts`): start an
   attempt, wait for a run in flight, repair the Status after a success, or give up.
3. Claim: write a `started` marker, re-read the markers, and go on only if it is the earliest claim of
   that attempt (`isClaimWinner`); then move the Status to `claim`.
4. Run the stage in its own git worktree (`implement-stage.ts`): the repository's context, the prompt,
   the agent session.
5. Check the diff against the path denylist, push without force and open (or find) the pull request.
6. Write the outcome marker and move the Status: `succeeded` → `done`; `failed` → back to `when` for the
   next attempt; `blocked` (the agent asked a question) or `denied` (a denied path) → `blocked`, for a
   person.

At most `concurrency` runs start per tick; the rest are reported as `deferred`. An error on one item is
reported for that item and the tick goes on. `tick(dependencies, { dryRun: true })` plans without
writing anything.

## State lives on GitHub

There is no database ([ADR 0001](./adr/0001-github-as-the-state-store.md)). The Status of the item
says where it is; a hidden marker comment on the issue
(`<!-- boardwright:run v=1 stage=implement run=<id> attempt=<n> event=<event> -->`, `domain/run-marker.ts`)
records each run's start and outcome, so the next tick knows which run owns the item and how many
attempts were made. Events: `started`, `succeeded`, `failed`, `blocked`, `denied`, `gave-up`. A run
without an outcome after its timeout plus a 5-minute grace is presumed dead and counts as an attempt.
After the last attempt the pipeline writes `gave-up` and leaves the issue to a person; deleting that
comment lets it try again.

## Stages

| Stage | From Status | PREVC phase | What it does |
| --- | --- | --- | --- |
| refine (optional) | a Status the board owner adds (default `Refine`) | P | A read-only `plan` task with the `architect-specialist` playbook; the plan is posted as a marked comment on the issue and the card moves to `done` (default Ready). Deleting the plan comment asks for a new one. Not a `.context/plans` file: the repositories ignore that folder as dotcontext's local state |
| implement | Ready | E | Branch `agent/issue-N`, change, local gate, pull request with `Closes #N` |
| review | In review | R | Reviews the head of `agent/issue-N`'s pull request read-only; posts a review that only comments, with line comments and a `<!-- boardwright:review v=1 verdict=… head=… -->` marker; approves or requests changes only with `approve` and a GitHub App (ADR 0005), never moves the card. A new push starts a new round; `maxAttempts` caps the rounds |
| address-feedback | In review | E | When the pull request has unresolved review threads or failing checks: the agent commits fixes on its branch, the core checks them against the denylist, pushes without force and resolves only the known threads the agent says it addressed. Never moves the card; `maxAttempts` caps the rounds |
| merge (opt-in) | In review | V (gatekeeper) | No agent in `auto` mode. Reads the pull request fresh and evaluates the deterministic policy (`domain/merge-policy.ts`): opt-out label wins; without the opt-in label (default `boardwright:merge`) or while something settles (checks running, mergeability unknown, no review of the head) it waits **quietly**; a blocking condition (draft, conflicts, failing checks, unresolved threads, review asking for changes, over `maxChangedLines`, a path from the merge denylist) gets **one** audit comment per head and set of reasons; a pass merges at the evaluated head with the merge token, or turns on native auto-merge when the ruleset still holds the pull request. With `mode: agent`, a pass first asks a read-only gatekeeper (default `security-auditor`, phase V): its "changes" vetoes with one audit comment per head, its "approve" lets the merge go on after the policy is judged again; it runs only after the policy passed, so it can veto, never force. Every decision leaves a `<!-- boardwright:merge v=1 … -->` audit comment. Never moves the card |
| document (opt-in) | Done | C | Pull request updating the `.context` docs the change touched |

Each stage has a handler (`packages/core/src/application/stages.ts`) that says when it applies (review
needs an open pull request from the branch), what "its result is in place" means (implement: the pull
request is open; review: a review of the current head exists), and where the card goes after a run or
when the pipeline gives up (review leaves it where it is).

The playbook and the skills for each stage come from the target repository's `.context` through the
`ContextProvider` port (`packages/context`): with a `.context/agents` or `.context/skills` directory,
the dotcontext adapter reads the front matter (`agentType`, `skillSlug`, `phases`) of the files the
repository has; otherwise the plain adapter lists `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`. The
playbook is the stage's `context.agent`, overridden by the first matching label in
`context.agentByLabel` (`bug` → `bug-fixer`). The dotcontext MCP's own selection is not used: it adds
built-in agents and skills the repository may have removed (issue #3).

## Guard rails

Enforced in the core, so they hold for every provider:

- No merge outside the merge stage and its policy; no push to the base branch; no force-push; no
  token with bypass rights.
- Path denylist (default `.github/workflows/**` and secret files): checked in the agent session and
  again on the diff before pushing.
- The trigger label counts only when whoever added it has triage access; repositories outside the
  allowlist are ignored.
- `maxTurns`, a timeout and `maxAttempts` per stage. An ambiguous issue gets a comment and the run stops.
