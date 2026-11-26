import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HookInput,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentRequest } from '@boardwright/core';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ClaudeAgentProvider,
  CREDENTIAL_PATHS,
  DANGEROUS_SOCKET_PATHS,
  guardTools,
  PLAN_REPORT_SCHEMA,
  REPORT_SCHEMA,
  REVIEW_REPORT_SCHEMA,
  sandboxSettings,
  type QueryFunction,
} from '../src/index.ts';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(
    tmpdir(),
    'boardwright-claude-',
  ));
});

afterEach(async () => {
  await rm(
    cwd,
    {
      recursive: true,
      force: true,
    },
  );
});

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    stage: 'implement',
    task: 'change',
    cwd,
    prompt: 'Implement issue #7.',
    maxTurns: 80,
    timeoutMs: 60_000,
    deniedPaths: ['.github/workflows/**'],
    model: undefined,
    ...overrides,
  };
}

function result(fields: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    ...fields,
  } as unknown as SDKMessage;
}

/** A query that records its parameters and yields the given messages. */
function replying(messages: SDKMessage[]): {
  query: QueryFunction;
  calls: {
    prompt: string;
    options: Options;
  }[];
} {
  const calls: {
    prompt: string;
    options: Options;
  }[] = [];

  return {
    calls,
    query: async function* fakeQuery(params) {
      calls.push(params);
      await Promise.resolve();
      yield* messages;
    },
  };
}

describe('ClaudeAgentProvider: the session it starts', () => {
  it('runs in the worktree with a closed tool list, no web, the project settings and the token-free environment', async () => {
    const fake = replying([]);

    const provider = new ClaudeAgentProvider({
      query: fake.query,
      environment: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-test',
        GITHUB_TOKEN: 'ghp_x',
        GH_TOKEN: 'gho_x',
        BOARDWRIGHT_GITHUB_TOKEN: 'ghp_y',
        BOARDWRIGHT_MERGE_TOKEN: 'ghp_merge',
      },
    });

    await provider.run(request({ model: 'claude-opus-5-5' }));

    const options = fake.calls[0]?.options;

    expect(fake.calls[0]?.prompt).toBe('Implement issue #7.');

    expect(options).toMatchObject({
      cwd,
      model: 'claude-opus-5-5',
      maxTurns: 80,
      permissionMode: 'dontAsk',
      allowedTools: [
        'Read',
        'Edit',
        'Write',
        'Glob',
        'Grep',
        'Bash',
        'TodoWrite',
      ],
      disallowedTools: [
        'WebFetch',
        'WebSearch',
        'mcp__dotcontext__sync',
      ],
      settingSources: ['project'],
      outputFormat: {
        type: 'json_schema',
        schema: REPORT_SCHEMA,
      },
      mcpServers: {},
      persistSession: false,
    });

    expect(options?.env).toEqual({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-test',
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      BOARDWRIGHT_GITHUB_TOKEN: undefined,
      BOARDWRIGHT_MERGE_TOKEN: undefined,
    });

    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions');
  });

  it('adds the dotcontext MCP and its read tools when the repository has a .context base', async () => {
    await mkdir(join(
      cwd,
      '.context',
    ));

    const fake = replying([]);

    await new ClaudeAgentProvider({
      query: fake.query,
      environment: {},
    }).run(request());

    const options = fake.calls[0]?.options;

    expect(options?.mcpServers).toEqual({
      dotcontext: {
        type: 'stdio',
        command: 'npx',
        args: [
          '-y',
          '@dotcontext/mcp@1.1.1',
        ],
      },
    });

    expect(options?.allowedTools).toContain('mcp__dotcontext__skill');
    expect(options?.allowedTools).not.toContain('mcp__dotcontext__sync');
    expect(options).not.toHaveProperty('model');
  });
});

describe('ClaudeAgentProvider: what the session reports', () => {
  async function runWith(messages: SDKMessage[]): ReturnType<ClaudeAgentProvider['run']> {
    return new ClaudeAgentProvider({
      query: replying(messages).query,
      environment: {},
    }).run(request());
  }

  it('turns a completed report into a pull request title and body', async () => {
    expect(await runWith([
      {
        type: 'assistant',
      } as unknown as SDKMessage,
      result({
        structured_output: {
          status: 'completed',
          summary: 'Added the feature.',
          pullRequestTitle: 'feat(app): add the feature',
          pullRequestBody: 'Adds it.',
        },
      }),
    ])).toEqual({
      status: 'completed',
      summary: 'Added the feature.',
      pullRequest: {
        title: 'feat(app): add the feature',
        body: 'Adds it.',
      },
      review: undefined,
      addressedThreadIds: [],
    });
  });

  it('passes a blocked report and its question through', async () => {
    expect(await runWith([
      result({
        structured_output: {
          status: 'blocked',
          summary: 'Which endpoint?',
        },
      }),
    ])).toEqual({
      status: 'blocked',
      summary: 'Which endpoint?',
      pullRequest: undefined,
      review: undefined,
      addressedThreadIds: [],
    });
  });

  it.each([
    [
      'no result at all',
      [],
      'ended without a result',
    ],
    [
      'the turn limit',
      [
        result({ subtype: 'error_max_turns' }),
      ],
      'stopped: error_max_turns',
    ],
    [
      'a report in the wrong shape',
      [
        result({ structured_output: { status: 'done' } }),
      ],
      'without reporting its result',
    ],
  ])('fails on %s', async (
    _case,
    messages,
    expected,
  ) => {
    const outcome = await runWith(messages);

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain(expected);
  });

  it('fails when the session throws', async () => {
    const outcome = await new ClaudeAgentProvider({
      query: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('could not start Claude Code')) }),
      }),
      environment: {},
    }).run(request());

    expect(outcome).toEqual({
      status: 'failed',
      summary: 'The agent session failed: could not start Claude Code',
      pullRequest: undefined,
      review: undefined,
      addressedThreadIds: [],
    });
  });

  it('aborts the session when the stage runs out of time', async () => {
    const outcome = await new ClaudeAgentProvider({
      query: async function* hanging(params) {
        const signal = params.options.abortController?.signal;

        await new Promise((
          _resolve,
          reject,
        ) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'));
            },
          );
        });

        yield* [];
      },
      environment: {},
    }).run(request({ timeoutMs: 10 }));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe('The agent session ran out of time after 0 minutes.');
  });
});

describe('guardTools', () => {
  const guard = guardTools(
    '/work/tree',
    ['.github/workflows/**'],
  );

  const signal = new AbortController().signal;

  async function decide(
    toolName: string,
    toolInput: unknown,
  ): Promise<unknown> {
    return guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: toolInput,
        tool_use_id: 't1',
        session_id: 's',
        transcript_path: '',
        cwd: '/work/tree',
      },
      't1',
      { signal },
    );
  }

  it.each([
    [
      'Write',
      { file_path: '/work/tree/.github/workflows/ci.yml' },
      '.github/workflows/ci.yml is a denied path for agents.',
    ],
    [
      'Edit',
      { file_path: '.github/workflows/release.yml' },
      '.github/workflows/release.yml is a denied path for agents.',
    ],
    [
      'Write',
      { file_path: '/home/someone/.bashrc' },
      '/home/someone/.bashrc is outside the worktree.',
    ],
    [
      'NotebookEdit',
      { notebook_path: '../other/notebook.ipynb' },
      '../other/notebook.ipynb is outside the worktree.',
    ],
    [
      'Bash',
      { command: 'git commit -m x && git push origin HEAD' },
      'boardwright pushes the branch',
    ],
    [
      'Bash',
      { command: 'npm test; gh pr create --fill' },
      'boardwright pushes the branch',
    ],
    [
      'Read',
      { file_path: '/home/someone/.config/gh/hosts.yml' },
      '/home/someone/.config/gh/hosts.yml is outside the worktree; agents read only the worktree.',
    ],
    [
      'Read',
      { file_path: '~/.ssh/id_ed25519' },
      '~/.ssh/id_ed25519 is outside the worktree',
    ],
    [
      'Read',
      { file_path: '../other/.env' },
      '../other/.env is outside the worktree',
    ],
    [
      'NotebookRead',
      { notebook_path: '/srv/notes/notes.ipynb' },
      '/srv/notes/notes.ipynb is outside the worktree',
    ],
    [
      'Glob',
      { pattern: '/home/someone/.config/**/*.pem' },
      '/home/someone/.config/**/*.pem is outside the worktree',
    ],
    [
      'Glob',
      {
        pattern: '**/*.json',
        path: '/home/someone',
      },
      '/home/someone is outside the worktree',
    ],
    [
      'Grep',
      {
        pattern: 'oauth_token',
        path: '/home/someone/.config',
      },
      '/home/someone/.config is outside the worktree',
    ],
    [
      'Write',
      { file_path: '~/.bashrc' },
      '~/.bashrc is outside the worktree.',
    ],
  ])('denies %s %j', async (
    toolName,
    toolInput,
    reason,
  ) => {
    expect(await decide(
      toolName,
      toolInput,
    ) as { hookSpecificOutput?: Record<string, unknown> }).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });

    expect(JSON.stringify(await decide(
      toolName,
      toolInput,
    ))).toContain(reason);
  });

  it.each([
    [
      'Write',
      { file_path: '/work/tree/src/feature.ts' },
    ],
    [
      'Bash',
      { command: 'git commit -m "feat: x" && npm run lint' },
    ],
    [
      'Bash',
      { command: 'echo highlight' },
    ],
    [
      'Read',
      { file_path: '/work/tree/.github/workflows/ci.yml' },
    ],
    [
      'Read',
      { file_path: 'src/feature.ts' },
    ],
    [
      'Glob',
      { pattern: 'src/**/*.ts' },
    ],
    [
      'Glob',
      {
        pattern: '**/*.ts',
        path: '/work/tree/packages',
      },
    ],
    [
      'Grep',
      { pattern: 'TODO' },
    ],
    [
      'Grep',
      {
        pattern: 'TODO',
        path: 'packages',
      },
    ],
    [
      'Write',
      {},
    ],
  ])('allows %s %j', async (
    toolName,
    toolInput,
  ) => {
    expect(await decide(
      toolName,
      toolInput,
    )).toEqual({});
  });

  it('leaves other hook events alone', async () => {
    expect(await guard(
      { hook_event_name: 'Stop' } as HookInput,
      undefined,
      { signal },
    )).toEqual({});
  });
});

describe('ClaudeAgentProvider: review tasks', () => {
  it('reads only: no write tools, the review schema', async () => {
    const fake = replying([]);

    await new ClaudeAgentProvider({
      query: fake.query,
      environment: {},
    }).run(request({ task: 'review' }));

    const options = fake.calls[0]?.options;

    expect(options?.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash',
    ]);

    expect(options?.disallowedTools).toEqual(expect.arrayContaining([
      'Edit',
      'Write',
      'MultiEdit',
      'NotebookEdit',
    ]));

    expect(options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: REVIEW_REPORT_SCHEMA,
    });
  });

  async function review(output: unknown): ReturnType<ClaudeAgentProvider['run']> {
    return new ClaudeAgentProvider({
      query: replying([result({ structured_output: output })]).query,
      environment: {},
    }).run(request({ task: 'review' }));
  }

  it('returns the verdict and the line comments', async () => {
    expect(await review({
      status: 'completed',
      summary: 'One finding.',
      verdict: 'changes',
      comments: [
        {
          path: 'src/a.ts',
          line: 3,
          body: 'Name it.',
        },
      ],
    })).toEqual({
      status: 'completed',
      summary: 'One finding.',
      pullRequest: undefined,
      addressedThreadIds: [],
      review: {
        verdict: 'changes',
        comments: [
          {
            path: 'src/a.ts',
            line: 3,
            body: 'Name it.',
          },
        ],
      },
    });
  });

  it('carries no verdict when the reviewer is blocked, and fails on a malformed review', async () => {
    expect((await review({
      status: 'blocked',
      summary: 'Empty diff.',
      verdict: 'approve',
      comments: [],
    })).review).toBeUndefined();

    expect((await review({
      status: 'completed',
      summary: 'x',
      verdict: 'maybe',
      comments: [],
    })).status).toBe('failed');
  });
});

describe('ClaudeAgentProvider: feedback rounds', () => {
  it('returns the review threads the agent says it addressed', async () => {
    const outcome = await new ClaudeAgentProvider({
      query: replying([
        result({
          structured_output: {
            status: 'completed',
            summary: 'Fixed both.',
            addressedThreadIds: [
              'PRRT_1',
              'PRRT_2',
            ],
          },
        }),
      ]).query,
      environment: {},
    }).run(request());

    expect(outcome.addressedThreadIds).toEqual([
      'PRRT_1',
      'PRRT_2',
    ]);
  });
});

describe('ClaudeAgentProvider: plan tasks', () => {
  async function plan(
    output: unknown,
    captured?: { options?: Options | undefined },
  ): ReturnType<ClaudeAgentProvider['run']> {
    const fake = replying([result({ structured_output: output })]);

    const outcome = await new ClaudeAgentProvider({
      query: fake.query,
      environment: {},
    }).run(request({ task: 'plan' }));

    if (captured !== undefined) {
      captured.options = fake.calls[0]?.options;
    }

    return outcome;
  }

  it('reads only, with the plan schema, and returns the plan', async () => {
    const captured: { options?: Options | undefined } = {};

    const outcome = await plan(
      {
        status: 'completed',
        summary: 'Planned.',
        plan: '## Scope',
      },
      captured,
    );

    expect(captured.options?.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Bash',
    ]);

    expect(captured.options?.disallowedTools).toContain('Write');

    expect(captured.options?.outputFormat).toEqual({
      type: 'json_schema',
      schema: PLAN_REPORT_SCHEMA,
    });

    expect(outcome.plan).toBe('## Scope');
  });

  it('carries no plan when blocked, and fails on a malformed report', async () => {
    expect((await plan({
      status: 'blocked',
      summary: 'Which API?',
      plan: 'draft',
    })).plan).toBeUndefined();

    expect((await plan({
      status: 'completed',
      summary: 'x',
    })).status).toBe('failed');
  });
});

describe('ClaudeAgentProvider: the sandbox', () => {
  const sandbox = {
    enabled: true,
    allowedDomains: ['registry.npmjs.org'],
  };

  it('runs shell commands in the SDK sandbox: no credential file, only the listed hosts, no way out', () => {
    expect(sandboxSettings(sandbox)).toEqual({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...CREDENTIAL_PATHS] },
      network: { allowedDomains: ['registry.npmjs.org'] },
    });

    expect(CREDENTIAL_PATHS).toEqual(expect.arrayContaining([
      '~/.config/gh',
      '~/.config/boardwright',
      '~/.ssh',
    ]));
  });

  it('lets commands reach Unix sockets only when asked, hiding the dangerous ones and the SSH agent', () => {
    const settings = sandboxSettings(
      {
        ...sandbox,
        allowUnixSockets: true,
      },
      { SSH_AUTH_SOCK: '/home/someone/.ssh-agent/agent.42' },
    );

    expect(settings.network).toEqual({
      allowedDomains: ['registry.npmjs.org'],
      allowAllUnixSockets: true,
    });

    expect(settings.filesystem?.denyRead).toEqual([
      ...CREDENTIAL_PATHS,
      ...DANGEROUS_SOCKET_PATHS,
      '/home/someone/.ssh-agent',
    ]);

    expect(DANGEROUS_SOCKET_PATHS).toEqual(expect.arrayContaining([
      '/var/run/docker.sock',
      '/run/user',
    ]));

    expect(sandboxSettings({
      ...sandbox,
      allowUnixSockets: true,
    }).filesystem?.denyRead).toEqual([
      ...CREDENTIAL_PATHS,
      ...DANGEROUS_SOCKET_PATHS,
    ]);

    expect(sandboxSettings(sandbox).network).not.toHaveProperty('allowAllUnixSockets');
  });

  it.each([
    [
      'enabled',
      sandbox,
      true,
    ],
    [
      'disabled',
      {
        ...sandbox,
        enabled: false,
      },
      false,
    ],
    [
      'absent',
      undefined,
      false,
    ],
  ])('passes the sandbox to the session only when it is enabled: %s', (
    _name,
    option,
    isSandboxed,
  ) => {
    const provider = new ClaudeAgentProvider({
      query: () => {
        throw new Error('not called');
      },
      ...option === undefined ? {} : { sandbox: option },
    });

    const options = provider.optionsFor(
      {
        stage: 'implement',
        task: 'change',
        cwd,
        prompt: 'x',
        maxTurns: 1,
        timeoutMs: 1000,
        deniedPaths: [],
        model: undefined,
      },
      new AbortController(),
    );

    expect(options.sandbox !== undefined).toBe(isSandboxed);
  });
});
