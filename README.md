# boardwright

Agentic delivery pipelines driven by GitHub Projects. Each Status column of your board maps to an
agent role — refine, implement, review, address feedback, and optionally merge — and
boardwright moves cards through that flow the way a person would: on a branch, through a pull request,
under your rulesets and required checks.

> **Status: v0.1.7, early.** The refine, implement, review and address-feedback stages have run end to
> end with a real agent on the local runner: [#49](https://github.com/NicollasFrazao/boardwright/issues/49)
> went from a plan to [#52](https://github.com/NicollasFrazao/boardwright/pull/52), reviewed, fixed and
> approved. The Action and the merge stage have not yet run with a real agent. The roadmap is
> [issue #1](https://github.com/NicollasFrazao/boardwright/issues/1).

## How it works

- **The board is the source of truth.** A config file maps statuses to stages; a reconciliation loop
  reads the board, claims an item, runs the stage's agent in its own git worktree, and moves the card.
  State lives on GitHub (the Status plus a run marker comment), so there is no database.
- **Two runtimes, one core.** A local runner (CLI/daemon) and a GitHub Action, both running the same
  tick and authenticating the agent the same way.
- **Your repository's context decides the agent.** Playbooks and skills come from the repository's
  [dotcontext](https://github.com/vinilana/dotcontext) base (`.context/agents`, `.context/skills`),
  selected by PREVC phase; repositories without one fall back to `AGENTS.md`/`CLAUDE.md`.
- **Claude first, providers pluggable** behind an `AgentProvider` interface.
- **Merging is human by default.** Agentic merge is an opt-in stage decided by a deterministic policy
  (required checks, unresolved threads, review verdict, path denylist, size), through native
  auto-merge, never by bypassing the ruleset.

## The flow

A person releases an issue to the pipeline by adding the `boardwright:agent` label (they need triage
access to the repository) and moving its card to the Status a stage starts from. From there:

| Stage | Starts from | While it runs | When it succeeds | When the agent needs a person | What the agent does |
| --- | --- | --- | --- | --- | --- |
| `refine` (optional) | Refine | — | Ready | Todo | Reads the code and posts a plan on the issue; changes nothing |
| `implement` | Ready | In Progress | In review | Todo | Works on its own branch and opens a pull request that closes the issue, assigned to the issue's assignees |
| `review` | In review | — | — | — | Reviews each new head of the pull request; comments only, unless `approve` is on |
| `address-feedback` | In review | — | — | — | Pushes fixes for unresolved review threads and failing checks, then the pipeline resolves the threads it addressed |
| `merge` (opt-in) | In review | — | — | — | No agent by default: a deterministic policy merges through native auto-merge |

The card reaches Done the way it does today: your board's automation moves it when the pull request is
merged. A failed run is retried on a later tick, up to `maxAttempts`; then the pipeline gives up and
comments on the issue (and, for `refine` and `implement`, moves the card to Todo). Deleting that comment
lets it try again.

Each run leaves a hidden marker comment on the issue. Markers make every action safe to repeat: a tick
that is interrupted, or two runners on the same board, never run the same attempt twice.

## Try it

With Node 24 or newer:

```bash
npm install --global boardwright
export GITHUB_TOKEN=$(gh auth token)   # a token that can read your board (project scope) and repositories
boardwright init --owner <login> --project <number> --repository <owner/name>
boardwright doctor                     # checks the config against the board; changes nothing
boardwright once --dry-run             # prints what one tick would do; changes nothing
boardwright once                       # runs the due stages: needs ANTHROPIC_API_KEY (or another documented method)
boardwright run                        # keeps ticking until Ctrl+C
```

Instead of exporting the variables before every run, put them in a file and pass
`--env-file <path>` to any command, such as `boardwright doctor --env-file .env`. Node's own `.env`
parser reads it; a variable already set in the shell wins over the file, and the GitHub tokens are
still removed from the agent's environment. Keep that file out of version control.

From a clone, `npm run boardwright -- <command>` runs the same CLI from the sources on Node 26.

The agent authenticates only through the [Claude Agent SDK's documented methods](https://code.claude.com/docs/en/agent-sdk/quickstart):
an API key, Amazon Bedrock, Claude Platform on AWS, Google Cloud or Microsoft Foundry. boardwright never
offers or handles a claude.ai login.

## GitHub Action

The Action runs one tick per workflow run, the same `tick()` as `once`. Every tick reads the whole
board, so the events only decide *when* it looks; a missed event is caught by the next one or by the
schedule.

```yaml
name: boardwright

on:
  issues:
    types: [labeled]
  pull_request_review:
  check_suite:
    types: [completed]
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

# One tick at a time; a queued run is enough, since the next tick sees everything that happened.
concurrency:
  group: boardwright
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  tick:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7          # the repository that holds pipeline.config.yml
      - uses: NicollasFrazao/boardwright@<commit sha of v0.1.7>   # pin by commit, not by tag
        with:
          github-token: ${{ secrets.BOARDWRIGHT_GITHUB_TOKEN }}
          # merge-token: ${{ secrets.BOARDWRIGHT_MERGE_TOKEN }}  # only with a merge stage
          # app-id: ${{ vars.BOARDWRIGHT_APP_ID }}               # the pipeline's GitHub App (ADR 0005), instead of merge-token
          # app-private-key: ${{ secrets.BOARDWRIGHT_APP_PRIVATE_KEY }}
          # dry-run: true
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

| Input | Default | |
| --- | --- | --- |
| `github-token` | — (required) | Reads the board and writes to the repositories. A user's Project needs a classic token with the `project` scope; the job's `GITHUB_TOKEN` cannot read it. |
| `merge-token` | `''` | The merge stage's token, an identity other than the one that opens pull requests. |
| `config` | `pipeline.config.yml` | The config, relative to the workspace. |
| `dry-run` | `false` | Print what the tick would do and change nothing. |

The agent's credentials go on the step's `env`, never as inputs: `ANTHROPIC_API_KEY` or a cloud
provider's variables. The Action runs on `node24`; on its first run in a job it downloads the Claude
Agent SDK and its native binary from npm, at the versions `package-lock.json` pins, and refuses any
tarball whose hash differs from the lockfile's.

## Configuration

`pipeline.config.yml`, at the root of the repository the runner or the Action reads it from
(`--config` and the Action's `config` input name another path). `boardwright init` writes a starter,
and `boardwright doctor` checks it against the board. Every option below shows its default; the
commented ones have none.

```yaml
project:
  owner: your-login              # required: the user or organization that owns the board
  number: 1                      # required: the board's number, from its URL
  statusField: Status            # the single-select field whose options are the columns
repositories:                    # required: the only repositories the pipeline acts on (owner/name)
  - your-login/your-repository
trigger:
  label: boardwright:agent       # an issue enters the pipeline only with this label...
  requireTriage: true            # ...added by someone with triage access or more
concurrency: 1                   # agent runs one tick may start; the rest wait for the next tick
provider:
  name: claude
  # model: claude-opus-5-5       # default: the Agent SDK's own
  sandbox:                       # the agent's shell commands run in the Claude Code sandbox
    enabled: true                # needs bubblewrap and socat on Linux; a session refuses to start without them
    # allowedDomains:            # the hosts commands may reach; default: npm, PyPI, Packagist and GitHub's download hosts
    #   - registry.npmjs.org
    # allowUnixSockets: false    # true lets commands reach Unix sockets, such as a test database's; Docker and the
    #                            # session's agents stay hidden (on Linux the sandbox cannot allow one socket by path)
git:
  # author:                      # who the agent's commits are attributed to; default: git's own config
  #   name: boardwright
  #   email: boardwright@users.noreply.github.com
guardRails:
  deniedPaths:                   # paths an agent may never change, checked in the session and on the diff
    - .github/workflows/**
    - '**/.env'
    - '**/.env.*'
    - '**/*.pem'
    - '**/*.key'
  maxTurns: 80                   # per run
  timeoutMinutes: 60             # per run
  maxAttempts: 3                 # per stage and issue, before the pipeline gives up
board:                           # board hygiene, before the stages; every part off by default
  addNewIssues: false            # add the open issues created in the last newIssueWindowDays
  newIssueWindowDays: 2
  inferFields: []                # e.g. [Track]: single-select fields to fill from the repository's other items
  followSubIssues: false         # move a parent that has not started once a sub-issue has
  parents:
    notStarted: [Todo, Ready]    # an empty Status counts too
    started: [In Progress, In review]
    status: In Progress
stages:                          # required: at least one, each id at most once
  - id: implement
```

### Board hygiene

What a person or a board workflow would otherwise do by hand, run at the start of every tick and shown
by `once --dry-run`. No agent is involved, and each part is safe to repeat:

- **`addNewIssues`** adds the open issues of the allowlisted repositories that were created in the last
  `newIssueWindowDays` and are not on the board. Older issues are never added, so turning it on does not
  pull in a backlog.
- **`inferFields`** fills an empty single-select field (such as `Track`) with the most common value among
  the other items of the same repository, the first by name on a tie. An item whose repository has no
  valued item is left alone, and so is any field that already has a value.
- **`followSubIssues`** moves a parent issue whose Status is empty or `notStarted` to `status` once one of
  its sub-issues is `started`, so an umbrella card follows its children.

Moving a labelled issue to Ready stays with a person: releasing work to an agent is a decision, not
hygiene.

### Stages

Every stage takes `maxTurns`, `timeoutMinutes` and `maxAttempts`, overriding the guard rails for that
stage, and a `context` that chooses the playbook from the repository's
[dotcontext](https://github.com/vinilana/dotcontext) base: `phase` (PREVC: `P`, `R`, `E`, `V`, `C`),
`agent` (the playbook) and `agentByLabel` (a playbook per issue label).

| Stage | Statuses (default) | `context` (default) |
| --- | --- | --- |
| `refine` | `when: Refine`, `done: Ready`, `blocked: Todo` | `P`, `architect-specialist` |
| `implement` | `when: Ready`, `claim: In Progress`, `done: In review`, `blocked: Todo` | `E`, `feature-developer`, `bug: bug-fixer` |
| `review` | `when: In review` | `R`, `code-reviewer` |
| `address-feedback` | `when: In review` | `E`, `feature-developer`, `bug: bug-fixer` |
| `merge` | `when: In review` | `V`, `security-auditor` (the gatekeeper of `mode: agent`) |

A status is written as `when: { status: Ready }`. The Status options must already exist on the board:
boardwright never creates them, and `doctor` lists the ones that are missing.

The `review` stage only comments by default. With `approve: true` it submits its verdict as an approval or
a change request, so a ruleset that requires approving reviews can pass without a person. That needs a
GitHub App (`BOARDWRIGHT_APP_ID` and its key, [ADR 0005](.context/docs/adr/0005-github-app-as-the-pipeline-identity.md)):
the App submits the reviews, because GitHub does not let the author of a pull request approve it. An
agent's approval then stands in for a person's review, so turning it on is a trust decision.

### The merge stage

Off unless the config lists it. The policy is plain code, the same for every provider, and reads the
pull request fresh each time. A pull request is merged only when it is not a draft, carries the opt-in
label and not the opt-out one, its checks pass, it has no conflict and no unresolved review thread, no
changed path is denied, it is small enough, and (with `agentApproval`) the pipeline's review of the head
commit approves. It is merged at the commit that was evaluated, so a push after the evaluation fails the
merge instead of merging unchecked code. A ruleset that still holds it gets native auto-merge; nothing
bypasses it. The stage needs an identity other than the one that opened the pull request: a GitHub App
you register and install on the repositories (`BOARDWRIGHT_APP_ID` with `BOARDWRIGHT_APP_PRIVATE_KEY_FILE`,
or `BOARDWRIGHT_APP_PRIVATE_KEY` in CI; [ADR 0005](.context/docs/adr/0005-github-app-as-the-pipeline-identity.md)),
which merges as `<app>[bot]`, or a token of another account, `BOARDWRIGHT_MERGE_TOKEN`. The App wins when both
are set.

```yaml
  - id: merge
    mode: auto                   # auto: the policy decides. agent: a read-only gatekeeper may also veto, never force
    method: squash               # squash, merge or rebase
    maxAttempts: 10              # evaluations of new heads before giving up
    require:
      agentApproval: true
      maxChangedLines: 400
      deniedPaths: [.github/**, '**/migrations/**', '**/*.lock', '**/package-lock.json']
      optInLabel: boardwright:merge   # only pull requests with this label are merged; null merges any that passes
      optOutLabel: boardwright:hold   # on a pull request: a person merges it, whatever else holds
```

### Examples

- [`examples/minimal.config.yml`](examples/minimal.config.yml) — implement only; a person reviews and merges.
- [`examples/full-pipeline.config.yml`](examples/full-pipeline.config.yml) — refine, implement, review and
  address feedback over two repositories; a person merges.
- [`examples/agentic-merge.config.yml`](examples/agentic-merge.config.yml) — implement, review, address
  feedback and the merge stage with a gatekeeper; the review approves as the pipeline's GitHub App.

## Safety model

An agent can do no more than its stage allows:

- **Who can start it:** only issues in the allowlisted repositories, with the trigger label added by
  someone with triage access. A bot or an outside contributor cannot release an issue.
- **What it can touch:** its own worktree and branch. A closed list of tools, no web access, and a hook
  that denies writes to denied paths or outside the worktree and any `git push` or `gh` command. The
  pipeline, not the agent, pushes, after checking the diff against the denylist again; it never pushes to
  the base branch and never force-pushes.
- **What it can read:** the GitHub tokens and the merge token are removed from its environment, and git
  credentials are never written where it could read them.
- **How long it can run:** turn, time and attempt limits per stage.
- **What it can merge:** nothing, unless the merge stage is configured; then only what the deterministic
  policy allows, through the ruleset.

The issue text is untrusted input to a model: these controls limit what it can cause. The threat model
is in [`.context/docs/security.md`](.context/docs/security.md).

## Adding a provider

Agents run behind one port of the core, `AgentProvider` (`packages/core/src/application/ports.ts`):

```ts
interface AgentProvider {
  run(request: AgentRequest): Promise<AgentResult>;
}
```

The request says what to do (`task`: `change` edits and commits, `review` reports a verdict and line
comments, `plan` reports a plan), where (`cwd`, a worktree the pipeline prepared), with which `prompt`,
limits (`maxTurns`, `timeoutMs`) and `deniedPaths`. The result says how it ended (`completed`,
`blocked` when the agent needs a person, `failed`) and carries the pull request text, the review or the
plan. A provider is its own package (`packages/agent-<name>`) that imports only the core and maps the
limits and the denylist to its runtime's own controls; the steps are in
[development-workflow.md](.context/docs/development-workflow.md), "A new agent provider".

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents start at [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
