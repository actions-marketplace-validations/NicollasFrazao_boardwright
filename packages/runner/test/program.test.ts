import { parseEnv } from 'node:util';
import {
  scenario,
  type Scenario,
} from '@boardwright/testing';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  EXIT,
  runProgram,
  USAGE,
  type ProgramEnvironment,
  type AppCredentials,
} from '../src/program.ts';

const CONFIG = `project:
  owner: acme
  number: 3
repositories:
  - acme/app
stages:
  - id: implement
`;

/** Locks held by test runners, across environments, as on one machine. */
const locks = new Set<string>();

interface TestEnvironment extends ProgramEnvironment {
  readonly files: Map<string, string>;
  readonly out: string[];
  readonly err: string[];
  readonly tokens: string[];
  readonly apps: AppCredentials[];
  readonly reviewers: AppCredentials[];
  readonly commands: Set<string>;
}

function environment(
  world: Scenario = scenario(),
  variables: Record<string, string | undefined> = { GITHUB_TOKEN: 'secret' },
): TestEnvironment {
  const shutdown = new AbortController();

  const files = new Map([[
    'pipeline.config.yml',
    CONFIG,
  ]]);

  const out: string[] = [];
  const err: string[] = [];
  const tokens: string[] = [];
  const apps: AppCredentials[] = [];
  const reviewers: AppCredentials[] = [];

  const commands = new Set([
    'bwrap',
    'socat',
  ]);

  return {
    files,
    out,
    err,
    tokens,
    apps,
    reviewers,
    commands,
    version: '1.2.3',
    variables,
    readFile: (path) => Promise.resolve(files.get(path)),
    // As process.loadEnvFile: the file's variables, never over one already set.
    loadEnvFile: (path) => {
      const text = files.get(path);

      if (text === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }

      for (const [
        name,
        value,
      ] of Object.entries(parseEnv(text))) {
        variables[name] ??= value;
      }
    },
    createFile: (
      path,
      text,
    ) => {
      if (files.has(path)) {
        return Promise.resolve(false);
      }

      files.set(
        path,
        text,
      );

      return Promise.resolve(true);
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    connectMerger: () => world.merger,
    platform: 'linux',
    hasCommand: (name) => Promise.resolve(commands.has(name)),
    inspectApp: () => ({
      installationOf: (repository) => Promise.resolve(repository === 'acme/app' ? {
        permissions: {
          contents: 'write',
          pull_requests: 'write',
        },
      } : undefined),
    }),
    connectAppMerger: (credentials) => {
      apps.push(credentials);

      return world.merger;
    },
    shutdownSignal: () => shutdown.signal,
    sleep: () => {
      shutdown.abort();

      return Promise.resolve();
    },
    acquireLock: (name) => {
      if (locks.has(name)) {
        return Promise.resolve(undefined);
      }

      locks.add(name);

      return Promise.resolve(() => {
        locks.delete(name);

        return Promise.resolve();
      });
    },
    connectAgents: () => ({
      workspaces: world.workspaces,
      agent: world.agent,
    }),
    connect: (
      _config,
      token,
      app,
    ) => {
      tokens.push(token);

      if (app !== undefined) {
        reviewers.push(app);
      }

      return {
        board: world.board,
        repoHost: world.repoHost,
      };
    },
  };
}

describe('boardwright doctor', () => {
  it('prints every check and exits 0 when nothing fails', async () => {
    const env = environment();

    expect(await runProgram(
      ['doctor'],
      env,
    )).toBe(EXIT.ok);

    expect(env.out.join('\n')).toContain('ok    board acme#3: "Roadmap", Status: Todo, Ready, In Progress, In review, Done.');
    expect(env.out.join('\n')).toContain(' failures.');
    expect(env.tokens).toEqual(['secret']);
  });

  it('fails when the agent sandbox cannot run on this machine, and skips it when the sandbox is off', async () => {
    const env = environment();

    env.commands.delete('socat');

    expect(await runProgram(
      ['doctor'],
      env,
    )).toBe(EXIT.failed);

    expect(env.out.join('\n')).toContain('FAIL  agent sandbox: socat not found');

    const off = environment();

    off.commands.clear();

    off.files.set(
      'pipeline.config.yml',
      `${CONFIG}provider:\n  sandbox:\n    enabled: false\n`,
    );

    expect(await runProgram(
      ['doctor'],
      off,
    )).toBe(EXIT.ok);

    expect(off.out.join('\n')).not.toContain('agent sandbox');
  });

  it('checks the GitHub App\'s installation when one is configured', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_APP_ID: '1',
        BOARDWRIGHT_APP_PRIVATE_KEY: 'PEM',
      },
    );

    await runProgram(
      ['doctor'],
      env,
    );

    expect(env.out.join('\n')).toContain('warn  acme/app GitHub App: The App lacks issues: write, checks: read');
  });

  it('reads each repository\'s context base remotely', async () => {
    const world = scenario();

    world.repoHost.files.set(
      'acme/app:.context/agents/feature-developer.md',
      '---\nagentType: feature-developer\nphases: [E]\n---\n',
    );

    world.repoHost.files.set(
      'acme/app:.context/skills/commit-message/SKILL.md',
      '---\nskillSlug: commit-message\ndescription: Commits.\nphases: [E, C]\n---\n',
    );

    const env = environment(world);

    await runProgram(
      ['doctor'],
      env,
    );

    const output = env.out.join('\n');

    expect(output).toContain('ok    acme/app implement: dotcontext: playbook .context/agents/feature-developer.md, 1 skills for phase E.');
    expect(output).toContain('warn  acme/app implement: No playbook for "bug-fixer" in .context/agents.');
  });

  it('exits 1 when a check fails, and prints JSON on request', async () => {
    const world = scenario();

    world.board.statusOptions = ['Todo'];

    const env = environment(world);

    expect(await runProgram(
      [
        'doctor',
        '--json',
      ],
      env,
    )).toBe(EXIT.failed);

    expect(JSON.parse(env.out.join('\n'))).toMatchObject({ hasFailures: true });
  });

  it('exits 2 without a token, before reaching GitHub', async () => {
    const env = environment(
      scenario(),
      {},
    );

    expect(await runProgram(
      ['doctor'],
      env,
    )).toBe(EXIT.usage);

    expect(env.err).toEqual(['No GitHub token: set one of BOARDWRIGHT_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN.']);
    expect(env.tokens).toEqual([]);
  });

  it('prefers BOARDWRIGHT_GITHUB_TOKEN', async () => {
    const env = environment(
      scenario(),
      {
        GH_TOKEN: 'gh',
        BOARDWRIGHT_GITHUB_TOKEN: 'mine',
      },
    );

    await runProgram(
      ['doctor'],
      env,
    );

    expect(env.tokens).toEqual(['mine']);
  });

  it('exits 2 with every problem of an invalid config', async () => {
    const env = environment();

    env.files.set(
      'bad.yml',
      'project:\n  owner: acme\nrepositories: []\nstages: []\n',
    );

    expect(await runProgram(
      [
        'doctor',
        '--config',
        'bad.yml',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('bad.yml is not a valid pipeline config:');
    expect(env.err[0]).toContain('  - project.number');
  });

  it('exits 2 on a file that is not YAML, and on a missing file', async () => {
    const env = environment();

    env.files.set(
      'broken.yml',
      'project: [unclosed',
    );

    expect(await runProgram(
      [
        'doctor',
        '--config',
        'broken.yml',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('broken.yml is not valid YAML');

    expect(await runProgram(
      [
        'doctor',
        '--config',
        'missing.yml',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[1]).toBe('missing.yml not found. Create one with boardwright init, or pass --config <path>.');
  });
});

describe('boardwright once --dry-run', () => {
  it('prints the plan and writes nothing', async () => {
    const world = scenario();
    const env = environment(world);

    expect(await runProgram(
      [
        'once',
        '--dry-run',
      ],
      env,
    )).toBe(EXIT.ok);

    expect(env.out.join('\n')).toBe('implement  acme/app#7  run attempt 1\n\nDry run: nothing was written.');

    expect(world.repoHost.bodies({
      repository: 'acme/app',
      number: 7,
    })).toEqual([]);

    expect(world.board.moves).toEqual([]);
  });

  it('describes every kind of action', async () => {
    const world = scenario();

    world.repoHost.issues.set(
      'acme/app#7',
      {
        ...await world.repoHost.getIssue({
          repository: 'acme/app',
          number: 7,
        }),
        labels: [],
      },
    );

    const env = environment(world);

    await runProgram(
      [
        'once',
        '--dry-run',
      ],
      env,
    );

    expect(env.out.join('\n')).toContain('implement  acme/app#7  skip (not-triggered)');
  });

  it('says so when nothing is in a starting Status', async () => {
    const world = scenario();

    world.board.items.length = 0;

    const env = environment(world);

    await runProgram(
      [
        'once',
        '--dry-run',
        '--json',
      ],
      env,
    );

    expect(JSON.parse(env.out.join('\n'))).toEqual({
      board: [],
      entries: [],
    });

    await runProgram(
      [
        'once',
        '--dry-run',
      ],
      env,
    );

    expect(env.out.at(-1)).toBe('Nothing to do: no item is in a Status a stage starts from.\n\nDry run: nothing was written.');
  });

  it('runs the stage without --dry-run, logs JSON to stderr and prints the outcome', async () => {
    const world = scenario();
    const env = environment(world);

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.ok);

    expect(env.out.join('\n')).toBe('implement  acme/app#7  run attempt 1 → succeeded: Opened https://github.com/acme/app/pull/100.\n\nDone.');
    expect(world.board.statusOf('item-7')).toBe('In review');

    expect(JSON.parse(env.err[0] ?? '{}')).toMatchObject({
      level: 'info',
      event: 'tick.item',
    });
  });

  it('exits 1 when an item errors', async () => {
    const world = scenario();

    world.repoHost.addComment = () => Promise.reject(new Error('GitHub is down'));

    const env = environment(world);

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.failed);

    expect(env.err.some((line) => line.includes('"level":"warn"'))).toBe(true);
  });
});

describe('boardwright init', () => {
  const args = [
    'init',
    '--owner',
    'acme',
    '--project',
    '3',
    '--repository',
    'acme/app',
    '--repository',
    'acme/api',
    '--config',
    'new.yml',
  ];

  it('writes a valid, commented starter config', async () => {
    const env = environment();

    expect(await runProgram(
      args,
      env,
    )).toBe(EXIT.ok);

    expect(env.files.get('new.yml')).toContain('  - acme/api\nstages:');
    expect(env.out).toEqual(['Wrote new.yml. Run boardwright doctor to check it against the board.']);
  });

  it('never overwrites a config', async () => {
    const env = environment();

    env.files.set(
      'new.yml',
      'mine',
    );

    expect(await runProgram(
      args,
      env,
    )).toBe(EXIT.usage);

    expect(env.files.get('new.yml')).toBe('mine');
  });

  it.each([
    [
      'without a repository',
      [
        'init',
        '--owner',
        'acme',
        '--project',
        '3',
      ],
    ],
    [
      'with a project that is not a number',
      [
        'init',
        '--owner',
        'acme',
        '--project',
        'three',
        '--repository',
        'acme/app',
      ],
    ],
  ])('refuses to run %s', async (
    _case,
    argv,
  ) => {
    const env = environment();

    expect(await runProgram(
      argv,
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('init needs --owner');
  });

  it('rejects a repository that is not owner/name, writing nothing', async () => {
    const env = environment();

    expect(await runProgram(
      [
        'init',
        '--owner',
        'acme',
        '--project',
        '3',
        '--repository',
        'app',
        '--config',
        'new.yml',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.files.has('new.yml')).toBe(false);
  });
});

describe('boardwright help', () => {
  it.each([
    [[]],
    [['--help']],
    [['help']],
  ])('prints the usage for %j', async (argv) => {
    const env = environment();

    expect(await runProgram(
      argv,
      env,
    )).toBe(EXIT.ok);

    expect(env.out).toEqual([USAGE]);
  });

  it.each([
    [['--version']],
    [['-v']],
    [[
      'doctor',
      '--version',
    ]],
  ])('prints the version for %j and exits 0', async (argv) => {
    const env = environment();

    expect(await runProgram(
      argv,
      env,
    )).toBe(EXIT.ok);

    expect(env.out).toEqual(['1.2.3']);
    expect(env.tokens).toEqual([]);
  });

  it('lists --version in the usage', () => {
    expect(USAGE).toContain('--version, -v');
  });

  it('exits 2 on an unknown command', async () => {
    const env = environment();

    expect(await runProgram(
      ['deploy'],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('Unknown command "deploy".');
  });

  it('lets unexpected errors through', async () => {
    const world = scenario();

    world.board.describe = () => Promise.reject(new TypeError('boom'));
    world.board.listItems = () => Promise.reject(new TypeError('boom'));

    await expect(runProgram(
      [
        'once',
        '--dry-run',
      ],
      environment(world),
    )).rejects.toThrow('boom');
  });
});

describe('boardwright once with a merge stage', () => {
  const MERGE_CONFIG = `${CONFIG}  - id: merge\n`;

  it('refuses to act without a merge token of its own', async () => {
    const env = environment();

    env.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('BOARDWRIGHT_MERGE_TOKEN');
  });

  it('merges as the GitHub App when it is configured, with its key read from the file only when used', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_MERGE_TOKEN: 'merge-secret',
        BOARDWRIGHT_APP_ID: '5925672',
        BOARDWRIGHT_APP_PRIVATE_KEY_FILE: 'app.pem',
      },
    );

    env.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    env.files.set(
      'app.pem',
      'PEM',
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.ok);

    expect(env.apps.map((app) => app.appId)).toEqual(['5925672']);
    expect(await env.apps[0]?.privateKey()).toBe('PEM');
  });

  it('takes the App key from the environment, and fails clearly on a missing key file', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_APP_ID: '1',
        BOARDWRIGHT_APP_PRIVATE_KEY: 'PEM-FROM-SECRET',
      },
    );

    env.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    await runProgram(
      ['once'],
      env,
    );

    expect(await env.apps[0]?.privateKey()).toBe('PEM-FROM-SECRET');

    const missing = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_APP_ID: '1',
        BOARDWRIGHT_APP_PRIVATE_KEY_FILE: 'nowhere.pem',
      },
    );

    missing.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    await runProgram(
      ['once'],
      missing,
    );

    await expect(missing.apps[0]?.privateKey()).rejects.toThrow('The GitHub App key nowhere.pem does not exist.');
  });

  it('refuses an App id without a key', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_APP_ID: '1',
      },
    );

    env.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('BOARDWRIGHT_APP_PRIVATE_KEY_FILE');
  });

  it('runs with the merge token, and plans without one in a dry run', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_MERGE_TOKEN: 'merge-secret',
      },
    );

    env.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.ok);

    const dry = environment();

    dry.files.set(
      'pipeline.config.yml',
      MERGE_CONFIG,
    );

    expect(await runProgram(
      [
        'once',
        '--dry-run',
      ],
      dry,
    )).toBe(EXIT.ok);
  });
});

describe('boardwright once with an approving review stage', () => {
  const APPROVING = `${CONFIG}  - id: review\n    approve: true\n`;

  it('refuses to approve without a GitHub App', async () => {
    const env = environment();

    env.files.set(
      'pipeline.config.yml',
      APPROVING,
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('approves only as a GitHub App');
  });

  it('gives the App to the repository host, which submits the reviews as the App', async () => {
    const env = environment(
      scenario(),
      {
        GITHUB_TOKEN: 'secret',
        BOARDWRIGHT_APP_ID: '5925672',
        BOARDWRIGHT_APP_PRIVATE_KEY: 'PEM',
      },
    );

    env.files.set(
      'pipeline.config.yml',
      APPROVING,
    );

    expect(await runProgram(
      ['once'],
      env,
    )).toBe(EXIT.ok);

    expect(env.reviewers.map((app) => app.appId)).toEqual(['5925672']);
  });
});

describe('boardwright --env-file', () => {
  it('reads the GitHub token from the file', async () => {
    const env = environment(
      scenario(),
      {},
    );

    env.files.set(
      '.env',
      '# local run\nGITHUB_TOKEN=from-file\nBOARDWRIGHT_CACHE_DIR=cache\n',
    );

    expect(await runProgram(
      [
        'doctor',
        '--env-file',
        '.env',
      ],
      env,
    )).toBe(EXIT.ok);

    expect(env.tokens).toEqual(['from-file']);
    expect(env.variables.BOARDWRIGHT_CACHE_DIR).toBe('cache');
  });

  it('keeps a variable already set over the file', async () => {
    const env = environment();

    env.files.set(
      '.env',
      'GITHUB_TOKEN=from-file\n',
    );

    expect(await runProgram(
      [
        'doctor',
        '--env-file=.env',
      ],
      env,
    )).toBe(EXIT.ok);

    expect(env.tokens).toEqual(['secret']);
  });

  it('exits 2 naming a missing file, before reaching GitHub', async () => {
    const env = environment();

    expect(await runProgram(
      [
        'doctor',
        '--env-file',
        'missing.env',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err.join('\n')).toContain('Cannot load the env file missing.env');
    expect(env.tokens).toEqual([]);
  });

  it('exits 2 when the option has no path', async () => {
    const env = environment();

    expect(await runProgram(
      [
        'doctor',
        '--env-file',
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err).toEqual(['--env-file needs a path.']);
  });

  it('reports an error that is not an Error', async () => {
    const env = environment();

    expect(await runProgram(
      [
        'doctor',
        '--env-file',
        '.env',
      ],
      {
        ...env,
        loadEnvFile: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the test needs a thrown value that is not an Error
          throw 'unreadable';
        },
      },
    )).toBe(EXIT.usage);

    expect(env.err).toEqual(['Cannot load the env file .env: unreadable']);
  });

  it('lists --env-file in the usage', () => {
    expect(USAGE).toContain('--env-file <path>');
  });
});

describe('boardwright run', () => {
  it('runs ticks until shutdown, logs a line per tick and releases its lock', async () => {
    const env = environment();

    expect(await runProgram(
      [
        'run',
        '--interval',
        '30',
      ],
      env,
    )).toBe(EXIT.ok);

    expect(env.err.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'tick.item',
      'daemon.tick',
      'daemon.stopped',
    ]);

    expect(locks.size).toBe(0);
  });

  it('refuses to start while another runner holds the lock for the board', async () => {
    locks.add('acme-3');

    try {
      const env = environment();

      expect(await runProgram(
        ['run'],
        env,
      )).toBe(EXIT.usage);

      expect(env.err[0]).toBe('Another boardwright runner already works on acme#3 on this machine.');
    } finally {
      locks.delete('acme-3');
    }
  });

  it.each([
    ['5'],
    ['ten'],
  ])('rejects --interval %s', async (interval) => {
    const env = environment();

    expect(await runProgram(
      [
        'run',
        '--interval',
        interval,
      ],
      env,
    )).toBe(EXIT.usage);

    expect(env.err[0]).toContain('--interval needs a whole number of seconds');
  });
});
