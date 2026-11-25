import { existsSync } from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
} from 'node:path';
import {
  query as sdkQuery,
  type HookCallback,
  type HookJSONOutput,
  type McpServerConfig,
  type Options,
  type SandboxSettings,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  findDeniedPaths,
  type AgentProvider,
  type AgentRequest,
  type AgentResult,
} from '@boardwright/core';
import { z } from 'zod';

/** The tools an implementing agent may use without asking; anything else is denied (`dontAsk`). */
export const STAGE_TOOLS: readonly string[] = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash',
  'TodoWrite',
];

/** Read-only dotcontext tools, allowed when the repository has a `.context` base. */
const DOTCONTEXT_TOOLS: readonly string[] = [
  'mcp__dotcontext__context',
  'mcp__dotcontext__explore',
  'mcp__dotcontext__agent',
  'mcp__dotcontext__skill',
];

/**
 * Tools denied even if a repository's settings allow them: the web (a path out for whatever the session
 * read) and dotcontext's `sync`, whose exports write agent surfaces the repository does not control.
 */
export const DENIED_TOOLS: readonly string[] = [
  'WebFetch',
  'WebSearch',
  'mcp__dotcontext__sync',
];

/** The runner's GitHub tokens, the merge token included; the agent's environment never carries them. */
export const TOKEN_VARIABLES: readonly string[] = [
  'BOARDWRIGHT_GITHUB_TOKEN',
  'BOARDWRIGHT_MERGE_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

/** The tools that read files, and the input fields that name what they read. */
const READ_TOOLS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'Read',
    ['file_path'],
  ],
  [
    'NotebookRead',
    ['notebook_path'],
  ],
  [
    'Glob',
    [
      'path',
      'pattern',
    ],
  ],
  [
    'Grep',
    ['path'],
  ],
]);

/**
 * Credential files a sandboxed shell command may not read: the GitHub CLI's token, boardwright's own App
 * key, and the usual keys and tokens of a developer's home. The Read tool is kept to the worktree by the guard.
 */
export const CREDENTIAL_PATHS: readonly string[] = [
  '~/.config/gh',
  '~/.config/boardwright',
  '~/.claude/.credentials.json',
  '~/.ssh',
  '~/.aws',
  '~/.azure',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker/config.json',
  '~/.npmrc',
  '~/.git-credentials',
  '~/.netrc',
  '~/.pypirc',
  '~/.composer/auth.json',
  '~/.config/composer/auth.json',
];

/** Where a glob pattern stops being a literal path. */
const GLOB_SYNTAX = /[*?[{]/u;

/** Pushing and talking to GitHub are the pipeline's job, after it has checked the change. */
const FORBIDDEN_COMMAND = /\bgit\s+push\b|(?:^|[;&|(\s])gh\s/u;

const MS_PER_MINUTE = 60_000;

const UNATTENDED = [
  'You are running unattended inside boardwright, an agentic delivery pipeline. No one answers questions during this session.',
  'If you cannot go on without a decision from a person, stop and report status "blocked" with exactly what is missing.',
  'Report your result in the structured output: "completed" with a pull request title and body, or "blocked".',
].join('\n');

/**
 * The JSON Schema draft of the report schemas. The Claude Code CLI rejects a `--json-schema` that declares
 * draft 2020-12, zod's default: "no schema with key or ref".
 */
const SCHEMA_DRAFT = { target: 'draft-07' } as const;

const agentReport = z.object({
  status: z.enum([
    'completed',
    'blocked',
  ]),
  summary: z.string(),
  pullRequestTitle: z.string().min(1).optional(),
  pullRequestBody: z.string().optional(),
  addressedThreadIds: z.array(z.string()).optional(),
});

/** The structured output every session must end with. */
export const REPORT_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  agentReport,
  SCHEMA_DRAFT,
);

const reviewReport = z.object({
  status: z.enum([
    'completed',
    'blocked',
  ]),
  summary: z.string(),
  verdict: z.enum([
    'approve',
    'changes',
  ]),
  comments: z.array(z.object({
    path: z.string().min(1),
    line: z.int().positive(),
    body: z.string().min(1),
  })),
});

/** The structured output a review session must end with. */
export const REVIEW_REPORT_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  reviewReport,
  SCHEMA_DRAFT,
);

const planReport = z.object({
  status: z.enum([
    'completed',
    'blocked',
  ]),
  summary: z.string(),
  plan: z.string(),
});

/** The structured output a planning session must end with. */
export const PLAN_REPORT_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  planReport,
  SCHEMA_DRAFT,
);

/** The tools a reviewing or planning agent may use: it reads and runs checks, it never edits. */
export const REVIEW_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
];

const WRITE_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
];

/** Environment variables, some unset. */
type Environment = Record<string, string | undefined>;

/** The part of the SDK the provider calls; tests replace it. */
export type QueryFunction = (params: {
  prompt: string;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/** What the provider can be given instead of its defaults. */
export interface ClaudeProviderOptions {
  readonly query?: QueryFunction;

  /** The environment the agent's process starts from, before the tokens are removed. */
  readonly environment?: Readonly<Record<string, string | undefined>>;

  /** The config's `provider.sandbox`; without it, shell commands run unsandboxed. */
  readonly sandbox?: AgentSandbox;
}

/** Whether the agent's shell commands run in the SDK's sandbox, and the hosts they may reach. */
export interface AgentSandbox {
  readonly enabled: boolean;
  readonly allowedDomains: readonly string[];
}

/**
 * The Claude provider: one Claude Agent SDK session per stage run.
 *
 * @remarks
 * Credentials are whatever the Agent SDK resolves from the environment: an API key or a cloud provider
 * (ADR 0004). The provider never reads, stores or refreshes them.
 */
export class ClaudeAgentProvider implements AgentProvider {
  private readonly query: QueryFunction;

  private readonly environment: Readonly<Record<string, string | undefined>>;

  private readonly sandbox: AgentSandbox | undefined;

  constructor(options: ClaudeProviderOptions = {}) {
    this.query = options.query ?? sdkQuery;
    this.environment = options.environment ?? process.env;
    this.sandbox = options.sandbox;
  }

  /** Runs the session to its result, aborting it when the stage's time runs out. */
  async run(request: AgentRequest): Promise<AgentResult> {
    const abort = new AbortController();

    const timer = setTimeout(
      () => {
        abort.abort();
      },
      request.timeoutMs,
    );

    try {
      let result: SDKResultMessage | undefined;

      for await (const message of this.query({
        prompt: request.prompt,
        options: this.optionsFor(
          request,
          abort,
        ),
      })) {
        if (message.type === 'result') {
          result = message;
        }
      }

      return abort.signal.aborted ? timedOut(request) : toAgentResult(
        result,
        request.task,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return abort.signal.aborted ? timedOut(request) : failed(`The agent session failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The SDK options of a run; exposed for tests and for reading what a session is allowed to do. */
  optionsFor(
    request: AgentRequest,
    abort: AbortController,
  ): Options {
    const isReadOnly = request.task !== 'change';

    const hasContextBase = existsSync(join(
      request.cwd,
      '.context',
    ));

    const mcpServers: Record<string, McpServerConfig> = hasContextBase
      ? {
          dotcontext: {
            type: 'stdio',
            command: 'npx',
            args: [
              '-y',
              '@dotcontext/mcp@1.1.1',
            ],
          },
        }
      : {};

    return {
      cwd: request.cwd,
      ...request.model === undefined ? {} : { model: request.model },
      maxTurns: request.maxTurns,
      permissionMode: 'dontAsk',
      allowedTools: [
        ...isReadOnly ? REVIEW_TOOLS : STAGE_TOOLS,
        ...hasContextBase ? DOTCONTEXT_TOOLS : [],
      ],
      disallowedTools: [
        ...DENIED_TOOLS,
        ...isReadOnly ? WRITE_TOOLS : [],
      ],
      settingSources: ['project'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: UNATTENDED,
      },
      outputFormat: {
        type: 'json_schema',
        schema: reportSchemaFor(request.task),
      },
      hooks: {
        PreToolUse: [{
          hooks: [guardTools(
            request.cwd,
            request.deniedPaths,
          )],
        }],
      },
      mcpServers,
      ...this.sandbox?.enabled === true ? { sandbox: sandboxSettings(this.sandbox) } : {},
      env: withoutTokens(this.environment),
      abortController: abort,
      persistSession: false,
    };
  }
}

/**
 * A `PreToolUse` hook that denies writes to denied paths or outside the worktree, reads outside the
 * worktree, and commands that push or call GitHub.
 *
 * @remarks
 * This is the first line; the core checks the diff again before anything is pushed, because a shell
 * command can still write a file this hook cannot see. Reads are limited to the worktree because the
 * session runs as the machine's user, whose home holds credentials (the GitHub CLI's token, keys).
 */
export function guardTools(
  cwd: string,
  deniedPaths: readonly string[],
): HookCallback {
  return (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return Promise.resolve({});
    }

    const reason = deniedReason(
      cwd,
      deniedPaths,
      input.tool_name,
      input.tool_input,
    );

    return Promise.resolve(reason === undefined ? {} : deny(reason));
  };
}

function deniedReason(
  cwd: string,
  deniedPaths: readonly string[],
  toolName: string,
  toolInput: unknown,
): string | undefined {
  const fields = typeof toolInput === 'object' && toolInput !== null ? toolInput as Record<string, unknown> : {};

  const readFields = READ_TOOLS.get(toolName);

  if (readFields !== undefined) {
    return readProblem(
      cwd,
      readFields,
      fields,
    );
  }

  if (FILE_TOOLS.has(toolName)) {
    const target = fields.file_path ?? fields.notebook_path;

    return typeof target === 'string' ? pathProblem(
      cwd,
      deniedPaths,
      target,
    ) : undefined;
  }

  if (
    toolName === 'Bash'
    && typeof fields.command === 'string'
    && FORBIDDEN_COMMAND.test(fields.command)
  ) {
    return 'boardwright pushes the branch and opens the pull request after checking the change; commit and stop.';
  }

  return undefined;
}

/** A read may name any path of the worktree, a denied one included, and nothing outside it. */
function readProblem(
  cwd: string,
  readFields: readonly string[],
  fields: Readonly<Record<string, unknown>>,
): string | undefined {
  for (const field of readFields) {
    const value = fields[field];

    if (typeof value !== 'string') {
      continue;
    }

    // A pattern is checked up to its first wildcard: `/home/**` reads from /home.
    const target = field === 'pattern' ? value.split(GLOB_SYNTAX)[0] ?? '' : value;

    if (
      target !== ''
      && worktreePath(
        cwd,
        target,
      ) === undefined
    ) {
      return `${value} is outside the worktree; agents read only the worktree.`;
    }
  }

  return undefined;
}

/**
 * The target relative to the worktree, with forward slashes; `undefined` when it is outside, a
 * home-relative path (`~`) included.
 */
function worktreePath(
  cwd: string,
  target: string,
): string | undefined {
  if (target.startsWith('~')) {
    return undefined;
  }

  const path = relative(
    cwd,
    isAbsolute(target) ? target : join(
      cwd,
      target,
    ),
  ).replaceAll(
    '\\',
    '/',
  );

  return path.startsWith('..') || isAbsolute(path) ? undefined : path;
}

function pathProblem(
  cwd: string,
  deniedPaths: readonly string[],
  target: string,
): string | undefined {
  const path = worktreePath(
    cwd,
    target,
  );

  if (path === undefined) {
    return `${target} is outside the worktree.`;
  }

  return findDeniedPaths(
    [path],
    deniedPaths,
  ).length > 0 ? `${path} is a denied path for agents.` : undefined;
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * The SDK's sandbox for the agent's shell commands: no credential file, only the listed hosts, and no
 * retry outside the sandbox.
 *
 * @remarks
 * The SDK refuses to start the session when the sandbox cannot run (bubblewrap and socat on Linux), rather
 * than run the commands unsandboxed.
 */
export function sandboxSettings(sandbox: AgentSandbox): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyRead: [...CREDENTIAL_PATHS] },
    network: { allowedDomains: [...sandbox.allowedDomains] },
  };
}

/** A copy of the environment without the GitHub tokens. */
export function withoutTokens(environment: Readonly<Environment>): Environment {
  const copy = { ...environment };

  for (const name of TOKEN_VARIABLES) {
    copy[name] = undefined;
  }

  return copy;
}

function toAgentResult(
  result: SDKResultMessage | undefined,
  task: AgentRequest['task'],
): AgentResult {
  if (result === undefined) {
    return failed('The agent session ended without a result.');
  }

  if (result.subtype !== 'success') {
    return failed(`The agent session stopped: ${result.subtype}.`);
  }

  if (task === 'review') {
    return toReviewResult(result.structured_output);
  }

  if (task === 'plan') {
    return toPlanResult(result.structured_output);
  }

  const report = agentReport.safeParse(result.structured_output);

  if (!report.success) {
    return failed('The agent finished without reporting its result in the expected form.');
  }

  const {
    status,
    summary,
    pullRequestTitle,
    pullRequestBody,
  } = report.data;

  return {
    status,
    summary,
    pullRequest: pullRequestTitle === undefined ? undefined : {
      title: pullRequestTitle,
      body: pullRequestBody ?? '',
    },
    review: undefined,
    addressedThreadIds: report.data.addressedThreadIds ?? [],
    plan: undefined,
  };
}

function reportSchemaFor(task: AgentRequest['task']): Record<string, unknown> {
  switch (task) {
    case 'change':
      return REPORT_SCHEMA;
    case 'review':
      return REVIEW_REPORT_SCHEMA;
    case 'plan':
      return PLAN_REPORT_SCHEMA;
  }
}

function toPlanResult(output: unknown): AgentResult {
  const report = planReport.safeParse(output);

  if (!report.success) {
    return failed('The agent finished without reporting its plan in the expected form.');
  }

  return {
    status: report.data.status,
    summary: report.data.summary,
    pullRequest: undefined,
    review: undefined,
    addressedThreadIds: [],
    plan: report.data.status === 'completed' ? report.data.plan : undefined,
  };
}

function toReviewResult(output: unknown): AgentResult {
  const report = reviewReport.safeParse(output);

  if (!report.success) {
    return failed('The agent finished without reporting its review in the expected form.');
  }

  return {
    status: report.data.status,
    summary: report.data.summary,
    pullRequest: undefined,
    addressedThreadIds: [],
    plan: undefined,
    review: report.data.status === 'completed'
      ? {
          verdict: report.data.verdict,
          comments: report.data.comments,
        }
      : undefined,
  };
}

function timedOut(request: AgentRequest): AgentResult {
  return failed(`The agent session ran out of time after ${Math.round(request.timeoutMs / MS_PER_MINUTE)} minutes.`);
}

function failed(summary: string): AgentResult {
  return {
    status: 'failed',
    summary,
    pullRequest: undefined,
    review: undefined,
    addressedThreadIds: [],
    plan: undefined,
  };
}
