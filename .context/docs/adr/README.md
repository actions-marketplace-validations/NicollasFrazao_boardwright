# Decision records

One file per decision: context, the options weighed, the decision and its consequences. A decision is
changed by a new record that supersedes the old one, never by editing it.

| ADR | Decision |
| --- | --- |
| [0001](./0001-github-as-the-state-store.md) | GitHub is the state store: Status plus a run marker, no database |
| [0002](./0002-local-runner-and-action.md) | One core, two runtimes: a local runner and a GitHub Action; credentials are never stored |
| [0003](./0003-deterministic-merge-policy.md) | Agentic merge is opt-in and decided by deterministic code, through native auto-merge |
| [0004](./0004-agent-credentials-through-documented-methods.md) | The agent authenticates only through the Agent SDK's documented methods (amends 0002) |
| [0005](./0005-github-app-as-the-pipeline-identity.md) | A GitHub App is the pipeline's own identity for what it says, reviews and merges |
