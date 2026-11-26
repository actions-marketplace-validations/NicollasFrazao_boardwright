import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { RepositoryContextProvider } from '@boardwright/context';
import {
  diagnose,
  tick,
  type AgentProvider,
  type AppInstallationsPort,
  type BoardPort,
  type DoctorCheck,
  type DoctorReport,
  type Logger,
  type MergerPort,
  type PipelineConfig,
  type RepoHostPort,
  type TickDependencies,
  type WorkspacePort,
} from '@boardwright/core';
import {
  ConfigFileError,
  DEFAULT_CONFIG_PATH,
  readConfigText,
  starterConfig,
} from './config-file.ts';
import {
  formatDoctor,
  formatTick,
} from './format.ts';
import { runDaemon } from './daemon.ts';
import { repositoryFiles } from './repository-files.ts';

/** Exit codes: success, checks or runs that failed, and a command that could not run. */
export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
} as const;

/** The outside world of the program: files, output and the adapters. */
export interface ProgramEnvironment {
  /** The version of the build that runs, from the root `package.json`, such as `0.1.2`. */
  readonly version: string;
  readonly variables: Readonly<Record<string, string | undefined>>;
  readFile(path: string): Promise<string | undefined>;

  /**
   * Adds the variables of a `.env` file to `variables`, keeping every variable already set.
   *
   * @throws {@link Error} when the file is missing or cannot be read.
   */
  loadEnvFile(path: string): void;

  /** Writes a new file; resolves `false` when the file already exists. */
  createFile(path: string, text: string): Promise<boolean>;
  stdout(text: string): void;
  stderr(text: string): void;

  /** The adapters that read and write the board and the repositories. */
  /** The board and the repository host; with a GitHub App, the host submits reviews as the App (ADR 0005). */
  connect(config: PipelineConfig, token: string, app?: AppCredentials): GitHubAdapters;

  /** The adapters that act: the workspaces and the agent. Only `once` without `--dry-run` asks for them. */
  connectAgents(config: PipelineConfig, token: string): AgentAdapters;

  /** Aborted on SIGINT or SIGTERM. */
  shutdownSignal(): AbortSignal;

  /** Waits, ending early when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;

  /** Takes a machine-wide lock; resolves its release, or `undefined` when another process holds it. */
  acquireLock(name: string): Promise<(() => Promise<void>) | undefined>;

  /** The merger, on its own token. Only `once` without `--dry-run` with a merge stage asks for it. */
  connectMerger(token: string): MergerPort;

  /** The merger as a GitHub App (ADR 0005); preferred over the merge token when the App is configured. */
  connectAppMerger(credentials: AppCredentials): MergerPort;

  /** The App's installations, for `doctor`. */
  inspectApp(credentials: AppCredentials): AppInstallationsPort;

  /** The operating system, as `process.platform` names it. */
  readonly platform: string;

  /** Whether a command is on the `PATH`, for `doctor`'s machine checks. */
  hasCommand(name: string): Promise<boolean>;
}

/** A GitHub App's id and a way to read its private key on first use. */
export interface AppCredentials {
  readonly appId: string;
  readonly privateKey: () => Promise<string>;
}

interface GitHubAdapters {
  readonly board: BoardPort;
  readonly repoHost: RepoHostPort;
}

interface AgentAdapters {
  readonly workspaces: WorkspacePort;
  readonly agent: AgentProvider;
}

const TOKEN_VARIABLES = [
  'BOARDWRIGHT_GITHUB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

const MS_PER_SECOND = 1000;
const DEFAULT_INTERVAL_SECONDS = 60;
const MIN_INTERVAL_SECONDS = 10;

/** The longest wait between failing ticks: 15 minutes. */
const MAX_BACKOFF_MS = 900_000;

/** The help text. */
export const USAGE = `Usage: boardwright <command> [options]

Commands:
  doctor            Check the config against the board and the repositories. Changes nothing.
  once              Run one tick: claim the items that are due, run their stage, record the outcome.
  once --dry-run    Print what one tick would do. Changes nothing.
  run               Run ticks until SIGINT or SIGTERM: --interval <seconds> (default ${DEFAULT_INTERVAL_SECONDS}, at least ${MIN_INTERVAL_SECONDS}).
  init              Write a starter ${DEFAULT_CONFIG_PATH}: --owner <login> --project <number> --repository <owner/name>...

Options:
  --config <path>   The config file (default: ${DEFAULT_CONFIG_PATH})
  --env-file <path> Load environment variables from a .env file; variables already set win
  --json            Print the report as JSON
  --help            Show this help
  --version, -v     Print the version

The GitHub token is read from BOARDWRIGHT_GITHUB_TOKEN, GITHUB_TOKEN or GH_TOKEN. It needs read access to the
board (a classic token needs the project scope for a user's project) and, for once, write access to the
repositories' contents, issues and pull requests. The agent authenticates through the Claude Agent SDK's
documented methods, such as ANTHROPIC_API_KEY; boardwright never handles those credentials.`;

class UsageError extends Error {}

/**
 * The tick interval from `--interval`.
 *
 * @throws {@link UsageError} when it is not a whole number of seconds of at least the minimum.
 */
function intervalFrom(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_INTERVAL_SECONDS;
  }

  const seconds = Number(value);

  if (
    !Number.isInteger(seconds)
    || seconds < MIN_INTERVAL_SECONDS
  ) {
    throw new UsageError(`--interval needs a whole number of seconds, at least ${MIN_INTERVAL_SECONDS}.`);
  }

  return seconds;
}

/**
 * Loads the `--env-file` before the command runs, so the token and the agent's credentials can come from it.
 *
 * @throws {@link UsageError} when the option has no path, or the file is missing or unreadable.
 */
function loadEnvFile(
  environment: ProgramEnvironment,
  value: unknown,
): void {
  if (value === undefined) {
    return;
  }

  if (
    typeof value !== 'string'
    || value === ''
  ) {
    throw new UsageError('--env-file needs a path.');
  }

  try {
    environment.loadEnvFile(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    throw new UsageError(`Cannot load the env file ${value}: ${reason}`);
  }
}

/**
 * Runs one command and returns its exit code.
 *
 * @remarks
 * Errors the user can fix (usage, config, missing token) are printed as one message and exit with 2;
 * anything else propagates.
 */
export async function runProgram(
  argv: readonly string[],
  environment: ProgramEnvironment,
): Promise<number> {
  try {
    return await dispatch(
      argv,
      environment,
    );
  } catch (error) {
    if (
      error instanceof UsageError
      || error instanceof ConfigFileError
    ) {
      environment.stderr(error.message);

      return EXIT.usage;
    }

    throw error;
  }
}

async function dispatch(
  argv: readonly string[],
  environment: ProgramEnvironment,
): Promise<number> {
  const {
    values,
    positionals,
  } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'env-file': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
      version: {
        type: 'boolean',
        short: 'v',
      },
      'dry-run': { type: 'boolean' },
      interval: { type: 'string' },
      owner: { type: 'string' },
      project: { type: 'string' },
      repository: {
        type: 'string',
        multiple: true,
      },
    },
    strict: false,
  });

  const [command] = positionals;

  const options = {
    configPath: typeof values.config === 'string' ? values.config : DEFAULT_CONFIG_PATH,
    json: values.json === true,
  };

  if (values.version === true) {
    environment.stdout(environment.version);

    return EXIT.ok;
  }

  if (
    values.help === true
    || command === undefined
    || command === 'help'
  ) {
    environment.stdout(USAGE);

    return EXIT.ok;
  }

  loadEnvFile(
    environment,
    values['env-file'],
  );

  switch (command) {
    case 'doctor':
      return doctor(
        environment,
        options,
      );
    case 'once':
      return once(
        environment,
        {
          ...options,
          isDryRun: values['dry-run'] === true,
        },
      );
    case 'run':
      return run(
        environment,
        {
          ...options,
          intervalSeconds: intervalFrom(values.interval),
        },
      );
    case 'init':
      return init(
        environment,
        options.configPath,
        values,
      );
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

interface CommonOptions {
  readonly configPath: string;
  readonly json: boolean;
}

async function doctor(
  environment: ProgramEnvironment,
  options: CommonOptions,
): Promise<number> {
  const config = await loadConfig(
    environment,
    options.configPath,
  );

  const {
    board,
    repoHost,
  } = environment.connect(
    config,
    tokenFrom(environment),
  );

  const app = appCredentials(environment);

  const report = await diagnose({
    config,
    board,
    repoHost,
    context: new RepositoryContextProvider(repositoryFiles(repoHost)),
    ...app === undefined ? {} : { app: environment.inspectApp(app) },
  });

  const sandbox = await checkSandbox(
    environment,
    config,
  );

  const full: DoctorReport = {
    checks: [
      ...report.checks,
      ...sandbox,
    ],
    hasFailures: report.hasFailures || sandbox.some((check) => check.status === 'fail'),
  };

  environment.stdout(options.json ? JSON.stringify(
    full,
    null,
    2,
  ) : formatDoctor(full));

  return full.hasFailures ? EXIT.failed : EXIT.ok;
}

/** What the agent's sandbox needs on Linux: bubblewrap isolates the files, socat relays the network. */
const SANDBOX_COMMANDS: readonly string[] = [
  'bwrap',
  'socat',
];

/**
 * Whether this machine can run the agent's sandbox (`provider.sandbox`): on Linux a session refuses to
 * start without bubblewrap and socat, so their absence is a failure here, before any run.
 */
async function checkSandbox(
  environment: ProgramEnvironment,
  config: PipelineConfig,
): Promise<DoctorCheck[]> {
  if (
    !config.provider.sandbox.enabled
    || environment.platform !== 'linux'
  ) {
    return [];
  }

  const missing: string[] = [];

  for (const name of SANDBOX_COMMANDS) {
    if (!await environment.hasCommand(name)) {
      missing.push(name);
    }
  }

  return [
    missing.length === 0 ? {
      subject: 'agent sandbox',
      status: 'ok',
      detail: 'bubblewrap and socat are installed.',
    } : {
      subject: 'agent sandbox',
      status: 'fail',
      detail: `${missing.join(' and ')} not found: agent sessions will refuse to start. Install bubblewrap and socat (sudo apt install bubblewrap socat), or set provider.sandbox.enabled: false.`,
    },
  ];
}

async function once(
  environment: ProgramEnvironment,
  options: CommonOptions & { readonly isDryRun: boolean },
): Promise<number> {
  const config = await loadConfig(
    environment,
    options.configPath,
  );

  const report = await tick(
    tickDependencies(
      environment,
      config,
      options.isDryRun,
    ),
    { dryRun: options.isDryRun },
  );

  environment.stdout(options.json ? JSON.stringify(
    report,
    null,
    2,
  ) : formatTick(
    report,
    options.isDryRun,
  ));

  return report.entries.some((entry) => entry.result?.kind === 'error') ? EXIT.failed : EXIT.ok;
}

/**
 * Runs ticks until SIGINT or SIGTERM, holding a lock so a second runner for the same board on this machine
 * refuses to start.
 */
async function run(
  environment: ProgramEnvironment,
  options: CommonOptions & { readonly intervalSeconds: number },
): Promise<number> {
  const config = await loadConfig(
    environment,
    options.configPath,
  );

  const dependencies = tickDependencies(
    environment,
    config,
    false,
  );

  const release = await environment.acquireLock(`${config.project.owner}-${config.project.number}`);

  if (release === undefined) {
    throw new UsageError(`Another boardwright runner already works on ${config.project.owner}#${config.project.number} on this machine.`);
  }

  try {
    await runDaemon({
      intervalMs: options.intervalSeconds * MS_PER_SECOND,
      maxBackoffMs: MAX_BACKOFF_MS,
      signal: environment.shutdownSignal(),
      tick: () => tick(dependencies),
      sleep: (
        ms,
        signal,
      ) => environment.sleep(
        ms,
        signal,
      ),
      logger: dependencies.logger,
    });
  } finally {
    await release();
  }

  return EXIT.ok;
}

function tickDependencies(
  environment: ProgramEnvironment,
  config: PipelineConfig,
  isDryRun: boolean,
): TickDependencies {
  const token = tokenFrom(environment);
  const app = appCredentials(environment);

  checkApprovingReview(
    config,
    app,
  );

  return {
    config,
    ...environment.connect(
      config,
      token,
      app,
    ),
    ...isDryRun ? dryRunAdapters() : environment.connectAgents(
      config,
      token,
    ),
    merger: isDryRun ? dryRunMerger() : mergerFor(
      environment,
      config,
      app,
    ),
    context: new RepositoryContextProvider(),
    clock: { now: () => new Date() },
    runIds: { next: () => randomUUID() },
    logger: isDryRun ? silentLogger() : jsonLogger(environment),
  };
}

async function init(
  environment: ProgramEnvironment,
  configPath: string,
  values: {
    owner?: unknown;
    project?: unknown;
    repository?: unknown;
  },
): Promise<number> {
  const projectNumber = Number(values.project);
  const repositories = Array.isArray(values.repository) ? values.repository.filter((entry) => typeof entry === 'string') : [];

  if (
    typeof values.owner !== 'string'
    || !Number.isInteger(projectNumber)
    || projectNumber <= 0
    || repositories.length === 0
  ) {
    throw new UsageError('init needs --owner <login>, --project <number> and at least one --repository <owner/name>.');
  }

  const text = starterConfig({
    owner: values.owner,
    projectNumber,
    repositories,
  });

  readConfigText(
    configPath,
    text,
  );

  if (!await environment.createFile(
    configPath,
    text,
  )) {
    throw new UsageError(`${configPath} already exists; init never overwrites a config.`);
  }

  environment.stdout(`Wrote ${configPath}. Run boardwright doctor to check it against the board.`);

  return EXIT.ok;
}

async function loadConfig(
  environment: ProgramEnvironment,
  path: string,
): Promise<PipelineConfig> {
  const text = await environment.readFile(path);

  if (text === undefined) {
    throw new UsageError(`${path} not found. Create one with boardwright init, or pass --config <path>.`);
  }

  return readConfigText(
    path,
    text,
  );
}

function tokenFrom(environment: ProgramEnvironment): string {
  for (const name of TOKEN_VARIABLES) {
    const token = environment.variables[name];

    if (
      token !== undefined
      && token !== ''
    ) {
      return token;
    }
  }

  throw new UsageError(`No GitHub token: set one of ${TOKEN_VARIABLES.join(', ')}.`);
}

/**
 * The acting adapters of a dry run: a dry run only plans, so they are never called.
 *
 * @throws {@link Error} from those adapters if a change ever made a dry run reach them.
 */
function dryRunAdapters(): AgentAdapters {
  const unavailable = (): Promise<never> => Promise.reject(new Error('A dry run never acts.'));

  return {
    workspaces: {
      prepare: unavailable,
      changedPaths: unavailable,
      hasCommits: unavailable,
      push: unavailable,
      dispose: unavailable,
    },
    agent: { run: unavailable },
  };
}

/** A dry run's merger: a dry run never merges. */
function dryRunMerger(): MergerPort {
  return { merge: () => Promise.reject(new Error('A dry run never acts.')) };
}

/**
 * The merger for a config with a merge stage: the GitHub App when `BOARDWRIGHT_APP_ID` is set (ADR 0005),
 * else `BOARDWRIGHT_MERGE_TOKEN`.
 *
 * @throws {@link UsageError} when the config has a merge stage and neither is set, or the App has no key:
 * the identity that merges must not be the one that opened the pull request.
 */
function mergerFor(
  environment: ProgramEnvironment,
  config: PipelineConfig,
  app: AppCredentials | undefined,
): MergerPort {
  if (app !== undefined) {
    return environment.connectAppMerger(app);
  }

  const token = environment.variables.BOARDWRIGHT_MERGE_TOKEN;

  if (
    token === undefined
    || token === ''
  ) {
    if (config.stages.some((stage) => stage.id === 'merge')) {
      throw new UsageError('The merge stage needs a GitHub App (BOARDWRIGHT_APP_ID with its key) or BOARDWRIGHT_MERGE_TOKEN, a token other than the one that opens pull requests.');
    }

    return { merge: () => Promise.reject(new Error('No merge stage is configured.')) };
  }

  return environment.connectMerger(token);
}

/**
 * A review stage that approves needs the GitHub App: GitHub does not let the token that opened the pull
 * request approve it.
 *
 * @throws {@link UsageError} when the config has an approving review stage and no App.
 */
function checkApprovingReview(
  config: PipelineConfig,
  app: AppCredentials | undefined,
): void {
  if (
    app === undefined
    && config.stages.some((stage) => stage.id === 'review' && stage.approve)
  ) {
    throw new UsageError('The review stage approves only as a GitHub App: set BOARDWRIGHT_APP_ID with its key, or drop `approve`.');
  }
}

/**
 * The GitHub App of `BOARDWRIGHT_APP_ID`, with its key from `BOARDWRIGHT_APP_PRIVATE_KEY` (the PEM, as CI
 * secrets hold it) or `BOARDWRIGHT_APP_PRIVATE_KEY_FILE` (a path, for a local runner); `undefined` without
 * an App id.
 *
 * @throws {@link UsageError} when the App id is set without a key.
 */
function appCredentials(environment: ProgramEnvironment): AppCredentials | undefined {
  const {
    BOARDWRIGHT_APP_ID: appId,
    BOARDWRIGHT_APP_PRIVATE_KEY: key,
    BOARDWRIGHT_APP_PRIVATE_KEY_FILE: keyFile,
  } = environment.variables;

  if (
    appId === undefined
    || appId === ''
  ) {
    return undefined;
  }

  if (
    key !== undefined
    && key !== ''
  ) {
    return {
      appId,
      privateKey: () => Promise.resolve(key),
    };
  }

  if (
    keyFile === undefined
    || keyFile === ''
  ) {
    throw new UsageError('BOARDWRIGHT_APP_ID needs the App\'s key: BOARDWRIGHT_APP_PRIVATE_KEY_FILE or BOARDWRIGHT_APP_PRIVATE_KEY.');
  }

  return {
    appId,
    privateKey: async () => {
      const text = await environment.readFile(keyFile);

      if (text === undefined) {
        throw new Error(`The GitHub App key ${keyFile} does not exist.`);
      }

      return text;
    },
  };
}

function silentLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
  };
}

/** One JSON object per line on stderr, so the report on stdout stays readable. */
function jsonLogger(environment: ProgramEnvironment): Logger {
  const write = (
    level: string,
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    environment.stderr(JSON.stringify({
      level,
      event,
      ...fields,
    }));
  };

  return {
    info: (
      event,
      fields,
    ) => {
      write(
        'info',
        event,
        fields,
      );
    },
    warn: (
      event,
      fields,
    ) => {
      write(
        'warn',
        event,
        fields,
      );
    },
  };
}
