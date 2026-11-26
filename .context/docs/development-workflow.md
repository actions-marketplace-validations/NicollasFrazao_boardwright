---
type: doc
name: development-workflow
description: Setup, day-to-day commands and recipes (new stage, new provider, new config option)
category: workflow
generated: 2026-11-24
status: filled
scaffoldVersion: "2.0.0"
---

# Development workflow

## Development Workflow

Every change goes: issue on the roadmap (#1) → branch → commits → local gate → pull request with
`Closes #N` → CI green → squash merge. The rules behind each step are in
[development-conventions.md](development-conventions.md).

## Setup

```bash
nvm use 26        # Node 26, the active LTS, is the runtime of CI and the runner
npm ci            # dependencies and the git hooks (husky)
```

No token is needed to develop: the core is tested with fake ports.

## Day-to-day commands

| Command | What it does |
| --- | --- |
| `npm test` | All Vitest projects (unit and tooling) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:unit` / `test:tooling` | One Vitest project |
| `npm run lint` | ESLint, any warning fails |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check:architecture` | Layer rules |
| `npm run check:unused` | knip |
| `npm run test:coverage` | Tests with the 80% gate |
| `npm run export:context` / `check:context` | Write / verify the agent surfaces |

The full table, with what each one catches, is in [tooling.md](tooling.md).

## Running the CLI against a real board

```bash
export GITHUB_TOKEN=$(gh auth token)       # or BOARDWRIGHT_GITHUB_TOKEN; needs the project scope for a user's board
npm run boardwright -- init --owner <login> --project <number> --repository <owner/name>
npm run boardwright -- doctor               # config vs board and repositories; exit 1 on a failure
npm run boardwright -- once --dry-run       # what one tick would do; writes nothing
npm run boardwright -- run --interval 60    # ticks until Ctrl+C; JSON logs on stderr
```

`--config <path>` reads another file; `--json` prints the report as JSON; `--version` (or `-v`) prints
the version of the root `package.json` the CLI was built from, for bug reports. `--env-file <path>`
loads the variables of a `.env` file before the command runs, with Node's own parser
(`process.loadEnvFile`): a variable already set wins over the file, and the GitHub tokens it holds
are still removed from the agent's environment. A missing or unreadable file stops the run; Node
itself checks the path at startup (TD-15). `once` without `--dry-run` acts:
it needs a token that can write the repositories' contents, issues and pull requests, and an agent
credential the Agent SDK accepts, such as `ANTHROPIC_API_KEY` (ADR 0004). A config with a merge stage also needs a second identity: a GitHub App
(`BOARDWRIGHT_APP_ID` with `BOARDWRIGHT_APP_PRIVATE_KEY_FILE` or `BOARDWRIGHT_APP_PRIVATE_KEY`, ADR 0005), or
`BOARDWRIGHT_MERGE_TOKEN`, a token other than the one that opens pull requests (ADR 0003). Clones and worktrees live in
`BOARDWRIGHT_CACHE_DIR`, else `$XDG_CACHE_HOME/boardwright` or `~/.cache/boardwright`.

## Branching & Releases

- Branch from `master` with a prefix (`feat/`, `fix/`, `docs/`, `refactor/`, `chore/`, `test/`, `ci/`).
- Squash merge only; the pull request title becomes the commit, so it follows Conventional Commits.
- The commit types since the last tag decide the next version (`feat` minor, `fix`/`perf`/`refactor`
  patch, `!` major; while the major is 0, a breaking change bumps the minor).
- **To release:**
  1. Open a pull request that sets `version` in the root `package.json` (and the lockfile, with
     `npm install --package-lock-only`).
  2. After it merges, publish a GitHub release whose tag is `v<version>` on that commit.
  3. The release workflow (`.github/workflows/release.yml`) checks that the tag is the version and that
     `dist/` is up to date, then publishes `build/npm` to npm through trusted publishing (OIDC, with
     provenance; no token is stored).
- The Action is used by tag or commit of this repository. Its Marketplace listing is updated by ticking
  "Publish this Action to the GitHub Marketplace" on the release. The Marketplace reads `action.yml` at
  the release's tag, and refuses a `name` that matches an existing action, user or organization (the
  `boardwright` organization is someone else's) and an icon outside GitHub's supported Feather list.

## Recipes

### A new stage

1. Add the stage to the config schema in `packages/core` with its `when`, `claim` and `done` rules.
2. Write its decision in the domain as a pure function and its action in `tick()`; say how a repeated
   tick detects that the action already happened.
3. Map it to a PREVC phase and a default playbook (the table in [architecture.md](architecture.md)).
4. Tests with fake ports: the happy path, a duplicate claim, the attempt limit, the guard rails.

### A new agent provider

1. New package `packages/agent-<name>` implementing `AgentProvider`; it imports only the core.
2. Map the stage's allowed tools, turn limit and path denylist to the provider's own controls.
3. Wire it in the runner and the Action; document its credentials without ever storing them.

### A new config option

Add it to the zod schema with a default that keeps today's behaviour, document it in the README's
configuration reference, and test both the default and the new value.

## Code Review Expectations

Review against [development-conventions.md](development-conventions.md) and the
[code-review skill](../skills/code-review/SKILL.md). Changes to `tick()`, a guard rail or the merge
policy get the [security-auditor](../agents/security-auditor.md) checklist as well.
