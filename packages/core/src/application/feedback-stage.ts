import {
  findDeniedPaths,
  findFutureDatedPaths,
} from '../domain/guard-rails.ts';
import {
  futureDatedDetail,
  implementBranch,
  selectAgent,
  todayOf,
  type ImplementRun,
  type ImplementStageDependencies,
  type StageOutcome,
} from './implement-stage.ts';
import type {
  Feedback,
  Workspace,
} from './ports.ts';
import { buildFeedbackPrompt } from './prompt.ts';

/** Whether a pull request has anything to address. */
export function hasFeedback(feedback: Feedback): boolean {
  return feedback.threads.length > 0 || feedback.failingChecks.length > 0;
}

/**
 * Runs the address-feedback stage: an agent fixes what the unresolved review threads and the failing
 * checks point at, the pipeline checks the new commits, pushes them without force and resolves the
 * threads the agent addressed.
 *
 * @remarks
 * Only threads that were in the feedback are resolved, whatever ids the agent reports. Each round is an
 * attempt, so `maxAttempts` caps review → fix loops.
 */
export async function runFeedbackStage(
  dependencies: ImplementStageDependencies,
  run: ImplementRun,
): Promise<StageOutcome> {
  const repository = run.issue.ref.repository;
  const branch = implementBranch(run.issue.ref.number);

  const pullRequest = await dependencies.repoHost.findOpenPullRequest(
    repository,
    branch,
  );

  if (pullRequest === undefined) {
    return outcome(
      'failed',
      `There is no open pull request from ${branch}.`,
    );
  }

  const feedback = await dependencies.repoHost.getFeedback(
    repository,
    pullRequest.number,
  );

  if (!hasFeedback(feedback)) {
    return outcome(
      'succeeded',
      `${pullRequest.url} has nothing left to address.`,
    );
  }

  const workspace = await dependencies.workspaces.prepare({
    repository,
    branch,
    base: await dependencies.repoHost.getDefaultBranch(repository),
  });

  try {
    return await addressIn(
      dependencies,
      run,
      {
        workspace,
        feedback,
        pullRequestUrl: pullRequest.url,
        prompt: buildFeedbackPrompt({
          issue: run.issue,
          pullRequest,
          feedback,
          workspace,
          context: await dependencies.context.load(
            workspace.path,
            {
              phase: run.stage.context.phase,
              agent: selectAgent(
                run.stage,
                run.issue.labels,
              ),
            },
          ),
          deniedPaths: run.deniedPaths,
          today: todayOf(dependencies.clock),
        }),
      },
    );
  } finally {
    await dependencies.workspaces.dispose(workspace);
  }
}

async function addressIn(
  dependencies: ImplementStageDependencies,
  run: ImplementRun,
  round: {
    readonly workspace: Workspace;
    readonly feedback: Feedback;
    readonly pullRequestUrl: string;
    readonly prompt: string;
  },
): Promise<StageOutcome> {
  const result = await dependencies.agent.run({
    stage: run.stage.id,
    task: 'change',
    cwd: round.workspace.path,
    prompt: round.prompt,
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

  const changedPaths = await dependencies.workspaces.changedPaths(round.workspace);

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

  // Only the threads that were in the feedback the agent read are resolved, whatever else it names.
  const known = new Set(round.feedback.threads.map((thread) => thread.id));
  const addressed = [...new Set(result.addressedThreadIds)].filter((id) => known.has(id));
  const hasCommits = await dependencies.workspaces.hasCommits(round.workspace);

  // A thread can need no change (a nit the reviewer itself waved through); the agent then commits nothing
  // and names it, and resolving it is the whole round. Nothing committed and nothing addressed is a failure.
  if (
    !hasCommits
    && addressed.length === 0
  ) {
    return outcome(
      'failed',
      'The agent committed nothing and addressed no thread, so there is nothing to push or resolve.',
    );
  }

  if (hasCommits) {
    await dependencies.workspaces.push(round.workspace);
  }

  for (const threadId of addressed) {
    await dependencies.repoHost.resolveThread(
      round.workspace.repository,
      threadId,
    );
  }

  const done = hasCommits ? `Pushed fixes to ${round.pullRequestUrl}` : `Pushed nothing to ${round.pullRequestUrl}: no change was needed`;

  return outcome(
    'succeeded',
    `${done}; resolved ${addressed.length} of ${round.feedback.threads.length} review threads.\n\n${result.summary}`,
  );
}

function outcome(
  event: StageOutcome['event'],
  detail: string,
): StageOutcome {
  return {
    event,
    detail,
    pullRequest: undefined,
  };
}
