import {
  findDeniedPaths,
  findFutureDatedPaths,
} from '../domain/guard-rails.ts';
import type { RunOutcomeEvent } from '../domain/pipeline.ts';
import type { StageConfig } from './config.ts';
import type {
  AgentProvider,
  Clock,
  ContextProvider,
  Issue,
  PullRequest,
  RepoHostPort,
  Workspace,
  WorkspacePort,
} from './ports.ts';
import { buildImplementPrompt } from './prompt.ts';

/** How a stage run ended, ready to be written as an outcome marker. */
export interface StageOutcome {
  readonly event: RunOutcomeEvent;
  readonly detail: string;
  readonly pullRequest: PullRequest | undefined;
}

/** What the implement stage needs from the outside world. */
export interface ImplementStageDependencies {
  readonly repoHost: RepoHostPort;
  readonly workspaces: WorkspacePort;
  readonly agent: AgentProvider;
  readonly context: ContextProvider;

  /** Today's date for the prompt and for the check of dated file names. */
  readonly clock: Clock;
}

/** Today as an ISO date, `YYYY-MM-DD`, in UTC. */
export function todayOf(clock: Clock): string {
  return clock.now().toISOString().slice(
    0,
    ISO_DATE_LENGTH,
  );
}

const ISO_DATE_LENGTH = 10;

/** Why a change with future-dated file names is not pushed. */
export function futureDatedDetail(paths: readonly string[]): string {
  return `The change dates files after today: ${paths.join(', ')}. Date new files with today's date and raise the sequence or time to order them. Nothing was pushed.`;
}

/** One run of the implement stage. */
export interface ImplementRun {
  readonly issue: Issue;
  readonly stage: StageConfig;
  readonly deniedPaths: readonly string[];
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly model: string | undefined;
}

/** The branch the implement stage works on for an issue. */
export function implementBranch(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

/**
 * Runs the implement stage: the agent changes a worktree, the pipeline checks the change, pushes it and
 * opens (or finds) the pull request that closes the issue.
 *
 * @remarks
 * The path denylist is checked here, on the diff, whatever the provider enforced during the session,
 * and before anything leaves the machine.
 */
export async function runImplementStage(
  dependencies: ImplementStageDependencies,
  run: ImplementRun,
): Promise<StageOutcome> {
  const repository = run.issue.ref.repository;
  const base = await dependencies.repoHost.getDefaultBranch(repository);

  const workspace = await dependencies.workspaces.prepare({
    repository,
    branch: implementBranch(run.issue.ref.number),
    base,
  });

  try {
    return await implementIn(
      dependencies,
      run,
      workspace,
    );
  } finally {
    await dependencies.workspaces.dispose(workspace);
  }
}

async function implementIn(
  dependencies: ImplementStageDependencies,
  run: ImplementRun,
  workspace: Workspace,
): Promise<StageOutcome> {
  const context = await dependencies.context.load(
    workspace.path,
    {
      phase: run.stage.context.phase,
      agent: selectAgent(
        run.stage,
        run.issue.labels,
      ),
    },
  );

  const result = await dependencies.agent.run({
    stage: run.stage.id,
    task: 'change',
    cwd: workspace.path,
    prompt: buildImplementPrompt({
      issue: run.issue,
      workspace,
      context,
      deniedPaths: run.deniedPaths,
      today: todayOf(dependencies.clock),
    }),
    maxTurns: run.maxTurns,
    timeoutMs: run.timeoutMs,
    deniedPaths: run.deniedPaths,
    model: run.model,
  });

  if (result.status !== 'completed') {
    return outcome(
      result.status,
      result.summary,
    );
  }

  const changedPaths = await dependencies.workspaces.changedPaths(workspace);

  const deniedChanges = findDeniedPaths(
    changedPaths,
    run.deniedPaths,
  );

  if (deniedChanges.length > 0) {
    return outcome(
      'denied',
      `The change touches denied paths: ${deniedChanges.join(', ')}. Nothing was pushed.`,
    );
  }

  const futureDated = findFutureDatedPaths(
    changedPaths,
    todayOf(dependencies.clock),
  );

  if (futureDated.length > 0) {
    return outcome(
      'denied',
      futureDatedDetail(futureDated),
    );
  }

  if (changedPaths.length === 0) {
    return outcome(
      'failed',
      'The agent finished without changing anything.',
    );
  }

  if (!await dependencies.workspaces.hasCommits(workspace)) {
    return outcome(
      'failed',
      'The agent changed files but committed nothing, so there is nothing to push.',
    );
  }

  await dependencies.workspaces.push(workspace);

  const pullRequest = await openOrFindPullRequest(
    dependencies.repoHost,
    run.issue,
    workspace,
    result.pullRequest,
  );

  return {
    event: 'succeeded',
    detail: `Opened ${pullRequest.url}.`,
    pullRequest,
  };
}

/** The playbook for an issue: the first label with an override wins, else the stage's default. */
export function selectAgent(
  stage: StageConfig,
  labels: readonly string[],
): string {
  for (const label of labels) {
    const agent = stage.context.agentByLabel[label];

    if (agent !== undefined) {
      return agent;
    }
  }

  return stage.context.agent;
}

async function openOrFindPullRequest(
  repoHost: RepoHostPort,
  issue: Issue,
  workspace: Workspace,
  draft: {
    readonly title: string;
    readonly body: string;
  } | undefined,
): Promise<PullRequest> {
  const existing = await repoHost.findOpenPullRequest(
    workspace.repository,
    workspace.branch,
  );

  if (existing !== undefined) {
    return existing;
  }

  return repoHost.openPullRequest({
    repository: workspace.repository,
    head: workspace.branch,
    base: workspace.base,
    title: draft?.title ?? issue.title,
    body: withClosingKeyword(
      draft?.body ?? '',
      issue.ref.number,
    ),
    assignees: issue.assignees,
  });
}

/** Appends `Closes #N` unless the body already links the issue with a closing keyword. */
export function withClosingKeyword(
  body: string,
  issueNumber: number,
): string {
  const closing = new RegExp(
    `\\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #${issueNumber}\\b`,
    'iu',
  );

  if (closing.test(body)) {
    return body;
  }

  const trimmed = body.trim();

  return trimmed === '' ? `Closes #${issueNumber}` : `${trimmed}\n\nCloses #${issueNumber}`;
}

function outcome(
  event: RunOutcomeEvent,
  detail: string,
): StageOutcome {
  return {
    event,
    detail,
    pullRequest: undefined,
  };
}
