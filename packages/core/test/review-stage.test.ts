import {
  baseConfig,
  ISSUE,
  scenario,
  type Scenario,
} from '@boardwright/testing';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  diagnose,
  parseMarker,
  parseReviewMarker,
  tick,
} from '../src/index.ts';

function reviewWorld(overrides: Record<string, unknown> = {}): Scenario {
  const world = scenario(baseConfig({
    stages: [{ id: 'review' }],
    ...overrides,
  }));

  world.board.items[0] = {
    itemId: 'item-7',
    status: 'In review',
    issue: ISSUE,
  };

  world.repoHost.openPullRequests.set(
    'acme/app:agent/issue-7',
    {
      number: 9,
      url: 'https://github.com/acme/app/pull/9',
      headSha: 'abc1234',
    },
  );

  world.agent.result = {
    status: 'completed',
    summary: 'One thing to fix.',
    pullRequest: undefined,
    review: {
      verdict: 'changes',
      comments: [
        {
          path: 'src/feature.ts',
          line: 3,
          body: 'Name this constant.',
        },
      ],
    },
    addressedThreadIds: [],
    plan: undefined,
  };

  return world;
}

function events(world: Scenario): string[] {
  return world.repoHost.bodies(ISSUE).map((body) => {
    const marker = parseMarker(body);

    return `${marker?.event ?? 'text'}#${marker?.attempt ?? 0}`;
  });
}

describe('the review stage', () => {
  it('reviews the head of the pull request as a read-only task and leaves the card where it is', async () => {
    const world = reviewWorld();
    const report = await tick(world.dependencies);

    expect(report.entries[0]?.result).toMatchObject({
      kind: 'completed',
      outcome: {
        event: 'succeeded',
        detail: 'Reviewed https://github.com/acme/app/pull/9: changes needed.',
      },
    });

    expect(world.agent.requests[0]).toMatchObject({
      stage: 'review',
      task: 'review',
    });

    expect(world.context.selectors).toEqual([
      {
        phase: 'R',
        agent: 'code-reviewer',
      },
    ]);

    expect(world.repoHost.reviews).toHaveLength(1);

    const [review] = world.repoHost.reviews;

    expect(parseReviewMarker(review?.body ?? '')).toEqual({
      verdict: 'changes',
      headSha: 'abc1234',
    });

    expect(review).toMatchObject({
      number: 9,
      headSha: 'abc1234',
      event: 'comment',
      comments: [
        {
          path: 'src/feature.ts',
          line: 3,
        },
      ],
    });

    expect(world.board.moves).toEqual([]);
    expect(world.workspaces.pushed).toEqual([]);
    expect(world.workspaces.disposed).toHaveLength(1);
  });

  it.each([
    [
      'changes',
      'request-changes',
    ],
    [
      'approve',
      'approve',
    ],
  ] as const)('submits a %s verdict as %s when the stage approves', async (
    verdict,
    event,
  ) => {
    const world = reviewWorld({
      stages: [
        {
          id: 'review',
          approve: true,
        },
      ],
    });

    world.agent.result = {
      ...world.agent.result,
      review: {
        verdict,
        comments: [],
      },
    };

    await tick(world.dependencies);

    expect(world.repoHost.reviews[0]?.event).toBe(event);
  });

  it('puts an approval\'s line comments in the body as suggestions, so they open no thread', async () => {
    const world = reviewWorld();

    world.agent.result = {
      ...world.agent.result,
      review: {
        verdict: 'approve',
        comments: [
          {
            path: 'src/feature.ts',
            line: 3,
            body: 'Optional: name this constant.',
          },
        ],
      },
    };

    await tick(world.dependencies);

    const [review] = world.repoHost.reviews;

    expect(review?.comments).toEqual([]);
    expect(review?.body).toContain('**Suggestions** (optional, not blocking):\n\n- `src/feature.ts:3` Optional: name this constant.');
  });

  it('does not review the same head twice, and reviews again after a new push', async () => {
    const world = reviewWorld();

    await tick(world.dependencies);

    expect((await tick(world.dependencies)).entries[0]?.action).toEqual({
      kind: 'skip',
      reason: 'up-to-date',
    });

    world.repoHost.openPullRequests.set(
      'acme/app:agent/issue-7',
      {
        number: 9,
        url: 'https://github.com/acme/app/pull/9',
        headSha: 'def5678',
      },
    );

    expect((await tick(world.dependencies)).entries[0]?.action).toEqual({
      kind: 'run',
      attempt: 2,
    });

    expect(events(world)).toEqual([
      'started#1',
      'succeeded#1',
      'started#2',
      'succeeded#2',
    ]);
  });

  it('skips an item without an open pull request from its branch', async () => {
    const world = reviewWorld();

    world.repoHost.openPullRequests.clear();

    expect((await tick(world.dependencies)).entries[0]?.action).toEqual({
      kind: 'skip',
      reason: 'no-pull-request',
    });
  });

  it('fails without posting when the agent gives no verdict, and posts nothing when it is blocked', async () => {
    const world = reviewWorld();

    world.agent.result = {
      ...world.agent.result,
      review: undefined,
      addressedThreadIds: [],
      plan: undefined,
    };

    const failed = await tick(world.dependencies);

    expect(failed.entries[0]?.result).toMatchObject({ outcome: { event: 'failed' } });

    world.agent.result = {
      status: 'blocked',
      summary: 'The diff is empty.',
      pullRequest: undefined,
      review: undefined,
      addressedThreadIds: [],
      plan: undefined,
    };

    world.clock.advance(1000);

    const blocked = await tick(world.dependencies);

    expect(blocked.entries[0]?.result).toMatchObject({ outcome: { event: 'blocked' } });
    expect(world.repoHost.reviews).toEqual([]);
    expect(world.board.moves).toEqual([]);
  });

  it('fails when the pull request closed between planning and running', async () => {
    const world = reviewWorld();
    const findOpenPullRequest = world.repoHost.findOpenPullRequest.bind(world.repoHost);
    let calls = 0;

    world.repoHost.findOpenPullRequest = (
      repository,
      head,
    ) => {
      calls += 1;

      return calls > 2 ? Promise.resolve(undefined) : findOpenPullRequest(
        repository,
        head,
      );
    };

    const report = await tick(world.dependencies);

    expect(report.entries[0]?.result).toMatchObject({
      outcome: {
        event: 'failed',
        detail: 'There is no open pull request from agent/issue-7 to review.',
      },
    });
  });

  it('gives up without moving the card', async () => {
    const world = reviewWorld({ guardRails: { maxAttempts: 1 } });

    world.agent.result = {
      ...world.agent.result,
      review: undefined,
      addressedThreadIds: [],
      plan: undefined,
    };

    await tick(world.dependencies);
    world.clock.advance(1000);

    expect((await tick(world.dependencies)).entries[0]?.action).toEqual({
      kind: 'give-up',
      attempts: 1,
    });

    expect(world.board.moves).toEqual([]);
  });

  it('needs only its own Status on the board', async () => {
    const world = reviewWorld();

    world.board.statusOptions = ['In review'];

    const report = await diagnose({
      config: world.dependencies.config,
      board: world.board,
      repoHost: world.repoHost,
      context: world.context,
    });

    expect(report.hasFailures).toBe(false);
  });
});
