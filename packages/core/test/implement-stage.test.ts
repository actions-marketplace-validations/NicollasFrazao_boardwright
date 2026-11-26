import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  runImplementStage,
  selectAgent,
  withClosingKeyword,
  type ImplementRun,
} from '../src/index.ts';
import {
  baseConfig,
  firstStage,
  ISSUE,
  scenario,
} from '@boardwright/testing';

function implementRun(labels: string[] = ['boardwright:agent']): ImplementRun {
  const config = baseConfig();

  return {
    issue: {
      ref: ISSUE,
      title: 'Add the feature',
      body: 'Body',
      labels,
      isOpen: true,
      assignees: ['maintainer'],
    },
    stage: firstStage(config),
    deniedPaths: config.guardRails.deniedPaths,
    maxTurns: 80,
    timeoutMs: 3_600_000,
    model: undefined,
  };
}

describe('runImplementStage', () => {
  it('pushes, opens the pull request that closes the issue for the issue\'s assignees, and disposes the worktree', async () => {
    const world = scenario();

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.event).toBe('succeeded');

    expect(world.workspaces.prepared[0]).toMatchObject({
      branch: 'agent/issue-7',
      base: 'master',
    });

    expect(world.workspaces.pushed).toHaveLength(1);

    expect(world.repoHost.drafts[0]).toMatchObject({
      head: 'agent/issue-7',
      base: 'master',
      title: 'feat(app): add the feature',
      body: 'Adds the feature.\n\nCloses #7',
      assignees: ['maintainer'],
    });

    expect(world.workspaces.disposed).toHaveLength(1);
  });

  it('passes the limits, the denylist and the selected playbook to the agent', async () => {
    const world = scenario();

    await runImplementStage(
      world.dependencies,
      implementRun([
        'boardwright:agent',
        'bug',
      ]),
    );

    expect(world.context.selectors).toEqual([
      {
        phase: 'E',
        agent: 'bug-fixer',
      },
    ]);

    expect(world.agent.requests[0]).toMatchObject({
      stage: 'implement',
      cwd: '/work/worktrees/agent/issue-7',
      maxTurns: 80,
      deniedPaths: baseConfig().guardRails.deniedPaths,
    });
  });

  it('pushes nothing when the change touches a denied path', async () => {
    const world = scenario();

    world.workspaces.changed = [
      'src/feature.ts',
      '.github/workflows/ci.yml',
    ];

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.event).toBe('denied');
    expect(outcome.detail).toContain('.github/workflows/ci.yml');
    expect(world.workspaces.pushed).toHaveLength(0);
    expect(world.repoHost.drafts).toHaveLength(0);
    expect(world.workspaces.disposed).toHaveLength(1);
  });

  it('denies a change whose file names are dated after today, and pushes nothing', async () => {
    const world = scenario();

    // The scenario's clock reads 2026-11-24.
    world.workspaces.changed = [
      'database/migrations/2026_11_24_000001_create_things.php',
      'database/migrations/2026_11_25_000000_add_role.php',
    ];

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.event).toBe('denied');
    expect(outcome.detail).toContain('The change dates files after today: database/migrations/2026_11_25_000000_add_role.php.');
    expect(outcome.detail).not.toContain('2026_11_24_000001');
    expect(world.workspaces.pushed).toHaveLength(0);
    expect(world.repoHost.drafts).toHaveLength(0);
  });

  it('fails when the agent changed nothing', async () => {
    const world = scenario();

    world.workspaces.changed = [];

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.event).toBe('failed');
    expect(world.workspaces.pushed).toHaveLength(0);
  });

  it('fails when the agent changed files but committed nothing', async () => {
    const world = scenario();

    world.workspaces.committed = false;

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.event).toBe('failed');
    expect(outcome.detail).toContain('committed nothing');
    expect(world.workspaces.pushed).toHaveLength(0);
  });

  it('reports a blocked agent with its question and pushes nothing', async () => {
    const world = scenario();

    world.agent.result = {
      status: 'blocked',
      summary: 'Which endpoint should the feature use?',
      pullRequest: undefined,
      review: undefined,
      addressedThreadIds: [],
      plan: undefined,
    };

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome).toEqual({
      event: 'blocked',
      detail: 'Which endpoint should the feature use?',
      pullRequest: undefined,
    });

    expect(world.workspaces.pushed).toHaveLength(0);
  });

  it('reuses the open pull request of the branch instead of opening another', async () => {
    const world = scenario();

    world.repoHost.openPullRequests.set(
      'acme/app:agent/issue-7',
      {
        number: 42,
        url: 'https://github.com/acme/app/pull/42',
        headSha: 'def5678',
      },
    );

    const outcome = await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(outcome.pullRequest?.number).toBe(42);
    expect(world.repoHost.drafts).toHaveLength(0);
  });

  it('falls back to the issue title when the agent gave no pull request text', async () => {
    const world = scenario();

    world.agent.result = {
      status: 'completed',
      summary: 'Done.',
      pullRequest: undefined,
      review: undefined,
      addressedThreadIds: [],
      plan: undefined,
    };

    await runImplementStage(
      world.dependencies,
      implementRun(),
    );

    expect(world.repoHost.drafts[0]).toMatchObject({
      title: 'Add the feature',
      body: 'Closes #7',
    });
  });

  it('disposes the worktree when the agent throws', async () => {
    const world = scenario();

    world.agent.error = new Error('session crashed');

    await expect(runImplementStage(
      world.dependencies,
      implementRun(),
    )).rejects.toThrow('session crashed');

    expect(world.workspaces.disposed).toHaveLength(1);
  });
});

describe('selectAgent', () => {
  it('uses the stage default when no label overrides it', () => {
    expect(selectAgent(
      firstStage(baseConfig()),
      [
        'boardwright:agent',
        'enhancement',
      ],
    )).toBe('feature-developer');
  });
});

describe('withClosingKeyword', () => {
  it.each([
    [
      'Fixes #7 by adding X',
      'Fixes #7 by adding X',
    ],
    [
      'resolved #7',
      'resolved #7',
    ],
    [
      'Related to #7',
      'Related to #7\n\nCloses #7',
    ],
    [
      'Closes #70',
      'Closes #70\n\nCloses #7',
    ],
  ])('%j → %j', (
    body,
    expected,
  ) => {
    expect(withClosingKeyword(
      body,
      7,
    )).toBe(expected);
  });
});
