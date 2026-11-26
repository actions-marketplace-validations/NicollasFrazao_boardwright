import {
  baseConfig,
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
  type AppInstallationsPort,
  type DoctorCheck,
} from '../src/index.ts';

function run(world: Scenario): ReturnType<typeof diagnose> {
  return diagnose({
    config: world.dependencies.config,
    board: world.board,
    repoHost: world.repoHost,
    context: world.context,
  });
}

function lines(
  checks: readonly DoctorCheck[],
  status: DoctorCheck['status'],
): string[] {
  return checks.filter((check) => check.status === status).map((check) => `${check.subject}: ${check.detail}`);
}

describe('diagnose', () => {
  it('passes a config that matches the board and the repository', async () => {
    const report = await run(scenario());

    expect(report.hasFailures).toBe(false);

    expect(lines(
      report.checks,
      'warn',
    )).toEqual([]);

    expect(lines(
      report.checks,
      'ok',
    )).toEqual([
      'board acme#3: "Roadmap", Status: Todo, Ready, In Progress, In review, Done.',
      'acme/app: Reachable; default branch master.',
      'acme/app: The trigger label "boardwright:agent" exists.',
      'acme/app implement: dotcontext: playbook .context/agents/feature-developer.md, 1 skills for phase E.',
      'acme/app implement: dotcontext: playbook .context/agents/feature-developer.md, 1 skills for phase E.',
    ]);
  });

  it('checks the playbook of every agent the stage can pick, labels included', async () => {
    const world = scenario();

    await run(world);

    expect(world.context.selectors).toEqual([
      {
        phase: 'E',
        agent: 'feature-developer',
      },
      {
        phase: 'E',
        agent: 'bug-fixer',
      },
    ]);
  });

  it('fails on each Status a stage needs and the board lacks', async () => {
    const world = scenario();

    world.board.statusOptions = [
      'Todo',
      'Ready',
      'Done',
    ];

    const report = await run(world);

    expect(report.hasFailures).toBe(true);

    expect(lines(
      report.checks,
      'fail',
    )).toEqual([
      'board acme#3: The Status "In Progress" is not an option of the board; add it, or change the stage.',
      'board acme#3: The Status "In review" is not an option of the board; add it, or change the stage.',
    ]);
  });

  it('fails when the board has no Status field', async () => {
    const world = scenario();

    world.board.statusOptions = undefined;

    expect(lines(
      (await run(world)).checks,
      'fail',
    )).toEqual(['board acme#3: "Roadmap" has no single-select field named "Status".']);
  });

  it('fails when the board cannot be read', async () => {
    const world = scenario();

    world.board.describe = () => Promise.reject(new Error('Could not resolve to a ProjectV2 with the number 3.'));

    expect(lines(
      (await run(world)).checks,
      'fail',
    )).toEqual(['board acme#3: Could not resolve to a ProjectV2 with the number 3.']);
  });

  it('warns when the trigger label is missing', async () => {
    const world = scenario();

    world.repoHost.labels.clear();

    const report = await run(world);

    expect(report.hasFailures).toBe(false);

    expect(lines(
      report.checks,
      'warn',
    )).toEqual(['acme/app: The trigger label "boardwright:agent" does not exist; create it to release issues to the pipeline.']);
  });

  it('fails a repository it cannot reach, and goes on', async () => {
    const world = scenario(baseConfig({
      repositories: [
        'acme/gone',
        'acme/app',
      ],
    }));

    world.repoHost.unreachable.add('acme/gone');

    const report = await run(world);

    expect(lines(
      report.checks,
      'fail',
    )).toEqual(['acme/gone: Not Found']);

    expect(lines(
      report.checks,
      'ok',
    )).toContain('acme/app: Reachable; default branch master.');
  });

  it('turns context warnings into warnings, and reports a plain repository by what the agent reads', async () => {
    const world = scenario();

    world.context.context = {
      source: 'plain',
      playbook: undefined,
      skills: [],
      instructionFiles: ['AGENTS.md'],
      warnings: [],
    };

    expect(lines(
      (await run(world)).checks,
      'ok',
    )).toContain('acme/app implement: plain: the agent reads AGENTS.md.');

    world.context.context = {
      ...world.context.context,
      instructionFiles: [],
      warnings: ['No agent instructions in the repository.'],
    };

    expect(lines(
      (await run(world)).checks,
      'warn',
    )).toContain('acme/app implement: No agent instructions in the repository.');
  });

  it('checks what board hygiene needs: the parent Status fails, unknown statuses and fields warn', async () => {
    const world = scenario(baseConfig({
      board: {
        followSubIssues: true,
        inferFields: [
          'Track',
          'Area',
        ],
        parents: {
          notStarted: ['Backlog'],
          status: 'Doing',
        },
      },
    }));

    world.board.singleSelectFields = { Track: ['Showcase'] };

    const report = await run(world);

    expect(report.hasFailures).toBe(true);

    expect(lines(
      report.checks,
      'fail',
    )).toEqual(['board acme#3: board.parents.status "Doing" is not a Status option of the board.']);

    expect(lines(
      report.checks,
      'warn',
    )).toEqual([
      'board acme#3: board.parents lists "Backlog", which is not a Status option of the board; no item can match it.',
      'board acme#3: board.inferFields names "Area", which is not a single-select field of the board; it is skipped.',
    ]);
  });
});

describe('diagnose: the GitHub App', () => {
  function withApp(installationOf: AppInstallationsPort['installationOf']): ReturnType<typeof diagnose> {
    const world = scenario();

    return diagnose({
      config: world.dependencies.config,
      board: world.board,
      repoHost: world.repoHost,
      context: world.context,
      app: { installationOf },
    });
  }

  function appCheck(report: Awaited<ReturnType<typeof diagnose>>): DoctorCheck | undefined {
    return report.checks.find((check) => check.subject === 'acme/app GitHub App');
  }

  it('passes an App installed with everything it needs', async () => {
    const report = await withApp(() => Promise.resolve({
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        issues: 'write',
        checks: 'read',
      },
    }));

    expect(appCheck(report)?.status).toBe('ok');
  });

  it('warns about the permissions the App will need for comments', async () => {
    const report = await withApp(() => Promise.resolve({
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        checks: 'write',
      },
    }));

    expect(appCheck(report)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('issues: write') as unknown,
    });

    expect(appCheck(report)?.detail).not.toContain('checks');
  });

  it.each([
    [
      'not installed',
      () => Promise.resolve(undefined),
      'not installed on this repository',
    ],
    [
      'missing a required permission',
      () => Promise.resolve({
        permissions: {
          contents: 'read',
          pull_requests: 'write',
        },
      }),
      'lacks contents: write',
    ],
    [
      'unreachable',
      () => Promise.reject(new Error('Bad credentials')),
      'Bad credentials',
    ],
  ])('fails an App that is %s', async (
    _name,
    installationOf: AppInstallationsPort['installationOf'],
    detail,
  ) => {
    const report = await withApp(installationOf);

    expect(appCheck(report)).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining(detail) as unknown,
    });

    expect(report.hasFailures).toBe(true);
  });
});
