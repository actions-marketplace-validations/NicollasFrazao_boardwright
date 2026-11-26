import { z } from 'zod';

const DEFAULT_MAX_TURNS = 80;
const DEFAULT_TIMEOUT_MINUTES = 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const MS_PER_MINUTE = 60_000;

/** A grace period after a run's timeout before a silent run is presumed dead. */
const STALE_GRACE_MINUTES = 5;

/** Paths an agent may never change: CI definitions and the usual secret files. */
export const DEFAULT_DENIED_PATHS: readonly string[] = [
  '.github/workflows/**',
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
];

const repositoryName = z.string().regex(
  /^[\w.-]+\/[\w.-]+$/u,
  'expected owner/name',
);

const statusName = z.string().trim().min(1);

const phase = z.enum([
  'P',
  'R',
  'E',
  'V',
  'C',
]);

const limitsOverride = {
  maxTurns: z.int().positive().optional(),
  timeoutMinutes: z.int().positive().optional(),
  maxAttempts: z.int().positive().optional(),
};

/** Where the implement stage claims an item, and where board hygiene moves a parent that started. */
const IN_PROGRESS = 'In Progress';

const implementStage = z.object({
  id: z.literal('implement'),
  when: z.object({ status: statusName }).prefault({ status: 'Ready' }),
  claim: z.object({ status: statusName }).prefault({ status: IN_PROGRESS }),
  done: z.object({ status: statusName }).prefault({ status: 'In review' }),
  blocked: z.object({ status: statusName }).prefault({ status: 'Todo' }),
  context: z.object({
    phase: phase.default('E'),
    agent: z.string().min(1).default('feature-developer'),
    agentByLabel: z.record(
      z.string(),
      z.string().min(1),
    ).default({ bug: 'bug-fixer' }),
  }).prefault({}),
  ...limitsOverride,
}).strict();

const reviewStage = z.object({
  id: z.literal('review'),
  when: z.object({ status: statusName }).prefault({ status: 'In review' }),
  context: z.object({
    phase: phase.default('R'),
    agent: z.string().min(1).default('code-reviewer'),
    agentByLabel: z.record(
      z.string(),
      z.string().min(1),
    ).default({}),
  }).prefault({}),

  /**
   * Submits the verdict as an approval or a change request instead of a comment, so a ruleset that requires
   * approving reviews can pass. It needs a GitHub App (ADR 0005): GitHub does not let the author approve.
   */
  approve: z.boolean().default(false),
  ...limitsOverride,
}).strict();

const addressFeedbackStage = z.object({
  id: z.literal('address-feedback'),
  when: z.object({ status: statusName }).prefault({ status: 'In review' }),
  context: z.object({
    phase: phase.default('E'),
    agent: z.string().min(1).default('feature-developer'),
    agentByLabel: z.record(
      z.string(),
      z.string().min(1),
    ).default({ bug: 'bug-fixer' }),
  }).prefault({}),
  ...limitsOverride,
}).strict();

const refineStage = z.object({
  id: z.literal('refine'),
  when: z.object({ status: statusName }).prefault({ status: 'Refine' }),
  done: z.object({ status: statusName }).prefault({ status: 'Ready' }),
  blocked: z.object({ status: statusName }).prefault({ status: 'Todo' }),
  context: z.object({
    phase: phase.default('P'),
    agent: z.string().min(1).default('architect-specialist'),
    agentByLabel: z.record(
      z.string(),
      z.string().min(1),
    ).default({}),
  }).prefault({}),
  ...limitsOverride,
}).strict();

/**
 * The hosts a sandboxed agent command may reach unless the config lists its own: the common package
 * registries and GitHub's download hosts, so installing dependencies works and little else does.
 */
const DEFAULT_SANDBOX_DOMAINS: readonly string[] = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'repo.packagist.org',
  'packagist.org',
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'api.github.com',
];

/** Paths whose changes always wait for a person to merge. */
export const DEFAULT_MERGE_DENIED_PATHS: readonly string[] = [
  '.github/**',
  '**/migrations/**',
  '**/*.lock',
  '**/package-lock.json',
];

const DEFAULT_MAX_CHANGED_LINES = 400;

/** Each evaluation of a new head is an attempt; merges see more rounds than agent stages. */
const DEFAULT_MERGE_ROUNDS = 10;

const mergeStage = z.object({
  id: z.literal('merge'),
  when: z.object({ status: statusName }).prefault({ status: 'In review' }),

  /** `auto` merges when the policy passes; `agent` also asks a gatekeeper agent, which can veto, never force. */
  mode: z.enum([
    'auto',
    'agent',
  ]).default('auto'),
  context: z.object({
    phase: phase.default('V'),
    agent: z.string().min(1).default('security-auditor'),
    agentByLabel: z.record(
      z.string(),
      z.string().min(1),
    ).default({}),
  }).prefault({}),
  method: z.enum([
    'squash',
    'merge',
    'rebase',
  ]).default('squash'),
  require: z.object({
    agentApproval: z.boolean().default(true),
    maxChangedLines: z.int().positive().default(DEFAULT_MAX_CHANGED_LINES),
    deniedPaths: z.array(z.string().min(1)).default([...DEFAULT_MERGE_DENIED_PATHS]),
    optInLabel: z.string().min(1).nullable().default('boardwright:merge'),
    optOutLabel: z.string().min(1).default('boardwright:hold'),
  }).strict().prefault({}),
  maxAttempts: z.int().positive().default(DEFAULT_MERGE_ROUNDS),
  maxTurns: z.int().positive().optional(),
  timeoutMinutes: z.int().positive().optional(),
}).strict();

const stage = z.discriminatedUnion(
  'id',
  [
    implementStage,
    reviewStage,
    addressFeedbackStage,
    refineStage,
    mergeStage,
  ],
);

/** How many days back a tick looks for issues to add to the board. */
const DEFAULT_NEW_ISSUE_WINDOW_DAYS = 2;

/**
 * Board hygiene: what the pipeline keeps tidy on the board besides running stages. Every part is off by
 * default, so a config without `board` changes nothing that is not a stage's.
 */
const boardHygiene = z.object({
  /** Adds the open issues of the allowlisted repositories created in the window that are not on the board. */
  addNewIssues: z.boolean().default(false),
  newIssueWindowDays: z.int().positive().default(DEFAULT_NEW_ISSUE_WINDOW_DAYS),

  /** Single-select fields an item without a value takes from its repository's other items (the most common value). */
  inferFields: z.array(z.string().min(1)).default([]),

  /** Moves a parent issue that has not started once one of its sub-issues has. */
  followSubIssues: z.boolean().default(false),
  parents: z.object({
    notStarted: z.array(statusName).default([
      'Todo',
      'Ready',
    ]),
    started: z.array(statusName).default([
      IN_PROGRESS,
      'In review',
    ]),
    status: statusName.default(IN_PROGRESS),
  }).strict().prefault({}),
}).strict();

/** The schema of `pipeline.config.yml`, with every default the docs promise. */
export const pipelineConfigSchema = z.object({
  project: z.object({
    owner: z.string().min(1),
    number: z.int().positive(),
    statusField: z.string().min(1).default('Status'),
  }).strict(),
  repositories: z.array(repositoryName).min(1),
  trigger: z.object({
    label: z.string().min(1).default('boardwright:agent'),
    requireTriage: z.boolean().default(true),
  }).strict().prefault({}),
  concurrency: z.int().positive().default(1),
  provider: z.object({
    name: z.string().min(1).default('claude'),
    model: z.string().min(1).optional(),

    /** Runs the agent's shell commands in the provider's sandbox: no credential files, only the listed hosts. */
    sandbox: z.object({
      enabled: z.boolean().default(true),
      allowedDomains: z.array(z.string().min(1)).default([...DEFAULT_SANDBOX_DOMAINS]),

      /**
       * Lets commands connect to Unix sockets, such as a test database's. On Linux the sandbox cannot allow
       * one socket by path, so this allows every socket the files let a command reach, and the provider
       * hides the dangerous ones (Docker, the session's agents).
       */
      allowUnixSockets: z.boolean().default(false),
    }).strict().prefault({}),
  }).strict().prefault({}),
  git: z.object({
    /** Who the agent's commits are attributed to; without it, git's own config on the machine decides. */
    author: z.object({
      name: z.string().min(1),
      email: z.string().min(1),
    }).strict().optional(),
  }).strict().prefault({}),
  guardRails: z.object({
    deniedPaths: z.array(z.string().min(1)).default([...DEFAULT_DENIED_PATHS]),
    maxTurns: z.int().positive().default(DEFAULT_MAX_TURNS),
    timeoutMinutes: z.int().positive().default(DEFAULT_TIMEOUT_MINUTES),
    maxAttempts: z.int().positive().default(DEFAULT_MAX_ATTEMPTS),
  }).strict().prefault({}),
  board: boardHygiene.prefault({}),
  stages: z.array(stage).min(1).refine(
    (stages) => new Set(stages.map((entry) => entry.id)).size === stages.length,
    'each stage may appear once',
  ),
}).strict();

/** A validated pipeline configuration. */
export type PipelineConfig = z.output<typeof pipelineConfigSchema>;

/** One stage of a validated configuration. */
export type StageConfig = PipelineConfig['stages'][number];

/** The limits that apply to one stage: its own overrides over the global guard rails. */
export interface StageLimits {
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly staleAfterMs: number;
}

/** A configuration that does not match the schema, with one readable line per problem. */
export class InvalidConfigError extends Error {
  /** One line per problem, each starting with the path of the offending field. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    const lines = problems.map((problem) => `- ${problem}`);

    super([
      'Invalid pipeline config:',
      ...lines,
    ].join('\n'));

    this.name = 'InvalidConfigError';
    this.problems = problems;
  }
}

/**
 * Validates a parsed config file and fills in the defaults.
 *
 * @throws {@link InvalidConfigError} when the input does not match the schema.
 */
export function parsePipelineConfig(input: unknown): PipelineConfig {
  const result = pipelineConfigSchema.safeParse(input);

  if (!result.success) {
    throw new InvalidConfigError(result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';

      return `${path}: ${issue.message}`;
    }));
  }

  return result.data;
}

/** The limits of a stage, falling back to the global guard rails. */
export function stageLimits(
  config: PipelineConfig,
  stageConfig: StageConfig,
): StageLimits {
  const timeoutMinutes = stageConfig.timeoutMinutes ?? config.guardRails.timeoutMinutes;

  return {
    maxTurns: stageConfig.maxTurns ?? config.guardRails.maxTurns,
    timeoutMs: timeoutMinutes * MS_PER_MINUTE,
    maxAttempts: stageConfig.maxAttempts ?? config.guardRails.maxAttempts,
    staleAfterMs: (timeoutMinutes + STALE_GRACE_MINUTES) * MS_PER_MINUTE,
  };
}
