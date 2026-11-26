import { join } from 'node:path';

/** An input of the Action that is missing or not valid. */
export class ActionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionInputError';
  }
}

/** The command line and the environment the Action runs the CLI with. */
export interface ActionCommand {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * The credentials of the Actions runtime itself (cache, artifacts, OIDC). Nothing boardwright runs needs
 * them, so neither the CLI nor the agent it starts receives them.
 */
const RUNTIME_CREDENTIALS: ReadonlySet<string> = new Set([
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_RESULTS_URL',
  'ACTIONS_CACHE_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
]);

/** The runner passes each input as `INPUT_<NAME>`, upper-cased, with dashes kept. */
const INPUT_PREFIX = 'INPUT_';

const TRUE_VALUES: ReadonlySet<string> = new Set([
  'true',
  'True',
  'TRUE',
]);

const FALSE_VALUES: ReadonlySet<string> = new Set([
  'false',
  'False',
  'FALSE',
  '',
]);

/**
 * Turns the Action's inputs into one `once` of the CLI.
 *
 * @remarks
 * The environment is rebuilt rather than inherited: the inputs (which hold the tokens) and the runtime's
 * own credentials are left out, and the tokens go back in only under the names the CLI reads, which the
 * Claude provider removes from the agent's environment.
 *
 * @throws {@link ActionInputError} when `github-token` is empty or `dry-run` is not a boolean.
 */
export function actionCommand(variables: Readonly<Record<string, string | undefined>>): ActionCommand {
  const input = (name: string): string => variables[`${INPUT_PREFIX}${name.toUpperCase()}`]?.trim() ?? '';

  const githubToken = input('github-token');

  if (githubToken === '') {
    throw new ActionInputError('The github-token input is required: a token that can read the board and write to the repositories.');
  }

  const environment: Record<string, string> = {};

  for (const [
    name,
    value,
  ] of Object.entries(variables)) {
    if (
      value !== undefined
      && !name.startsWith(INPUT_PREFIX)
      && !RUNTIME_CREDENTIALS.has(name)
    ) {
      environment[name] = value;
    }
  }

  environment.BOARDWRIGHT_GITHUB_TOKEN = githubToken;

  const mergeToken = input('merge-token');

  if (mergeToken !== '') {
    environment.BOARDWRIGHT_MERGE_TOKEN = mergeToken;
  }

  // The pipeline's GitHub App (ADR 0005); the CLI refuses an id without its key.
  const appId = input('app-id');
  const appKey = input('app-private-key');

  if (appId !== '') {
    environment.BOARDWRIGHT_APP_ID = appId;
  }

  if (appKey !== '') {
    environment.BOARDWRIGHT_APP_PRIVATE_KEY = appKey;
  }

  const runnerTemp = variables.RUNNER_TEMP;

  if (
    environment.BOARDWRIGHT_CACHE_DIR === undefined
    && runnerTemp !== undefined
  ) {
    environment.BOARDWRIGHT_CACHE_DIR = join(
      runnerTemp,
      'boardwright',
    );
  }

  const config = input('config');

  return {
    argv: [
      'once',
      ...config === '' ? [] : [
        '--config',
        config,
      ],
      ...isDryRun(input('dry-run')) ? ['--dry-run'] : [],
    ],
    environment,
  };
}

/**
 * Reads `dry-run` the way the Actions toolkit reads a boolean input; empty means the default, `false`.
 *
 * @throws {@link ActionInputError} when the value is not a boolean.
 */
function isDryRun(value: string): boolean {
  if (TRUE_VALUES.has(value)) {
    return true;
  }

  if (FALSE_VALUES.has(value)) {
    return false;
  }

  throw new ActionInputError(`The dry-run input must be true or false, not "${value}".`);
}
