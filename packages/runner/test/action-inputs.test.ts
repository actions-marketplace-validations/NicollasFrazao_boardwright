import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  actionCommand,
  ActionInputError,
} from '../src/action-inputs.ts';

const BASE = {
  'INPUT_GITHUB-TOKEN': 'ghp_board',
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-test',
};

describe('actionCommand', () => {
  it('runs one tick with the default config when only the token is given', () => {
    expect(actionCommand(BASE)).toEqual({
      argv: ['once'],
      environment: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-test',
        BOARDWRIGHT_GITHUB_TOKEN: 'ghp_board',
      },
    });
  });

  it('passes the config and the dry run, and the merge token under the name the CLI reads', () => {
    const command = actionCommand({
      ...BASE,
      INPUT_CONFIG: ' .github/pipeline.config.yml ',
      'INPUT_DRY-RUN': 'TRUE',
      'INPUT_MERGE-TOKEN': 'ghp_merge',
    });

    expect(command.argv).toEqual([
      'once',
      '--config',
      '.github/pipeline.config.yml',
      '--dry-run',
    ]);

    expect(command.environment.BOARDWRIGHT_MERGE_TOKEN).toBe('ghp_merge');
  });

  it('passes the GitHub App\'s id and key under the names the CLI reads', () => {
    const command = actionCommand({
      ...BASE,
      'INPUT_APP-ID': ' 5925672 ',
      'INPUT_APP-PRIVATE-KEY': '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n',
    });

    expect(command.environment).toMatchObject({
      BOARDWRIGHT_APP_ID: '5925672',
      BOARDWRIGHT_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
    });

    expect(command.environment).not.toHaveProperty('INPUT_APP-PRIVATE-KEY');
    expect(actionCommand(BASE).environment).not.toHaveProperty('BOARDWRIGHT_APP_ID');
  });

  it('leaves out every input and the credentials of the Actions runtime', () => {
    const command = actionCommand({
      ...BASE,
      'INPUT_MERGE-TOKEN': 'ghp_merge',
      ACTIONS_RUNTIME_TOKEN: 'runtime',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc',
      ACTIONS_CACHE_URL: 'https://cache',
      ACTIONS_RESULTS_URL: 'https://results',
      ACTIONS_RUNTIME_URL: 'https://runtime',
      GITHUB_REPOSITORY: 'acme/app',
      UNSET: undefined,
    });

    expect(Object.keys(command.environment).sort((
      left,
      right,
    ) => left.localeCompare(right))).toEqual([
      'ANTHROPIC_API_KEY',
      'BOARDWRIGHT_GITHUB_TOKEN',
      'BOARDWRIGHT_MERGE_TOKEN',
      'GITHUB_REPOSITORY',
      'PATH',
    ]);
  });

  it('keeps the clones in the job\'s temporary directory unless a cache directory is set', () => {
    expect(actionCommand({
      ...BASE,
      RUNNER_TEMP: '/runner/_temp',
    }).environment.BOARDWRIGHT_CACHE_DIR).toBe('/runner/_temp/boardwright');

    expect(actionCommand({
      ...BASE,
      RUNNER_TEMP: '/runner/_temp',
      BOARDWRIGHT_CACHE_DIR: '/cache',
    }).environment.BOARDWRIGHT_CACHE_DIR).toBe('/cache');
  });

  it('reads an empty dry-run as false', () => {
    expect(actionCommand({
      ...BASE,
      'INPUT_DRY-RUN': '',
    }).argv).toEqual(['once']);

    expect(actionCommand({
      ...BASE,
      'INPUT_DRY-RUN': 'False',
    }).argv).toEqual(['once']);
  });

  it('refuses a missing token and a dry-run that is not a boolean', () => {
    expect(() => actionCommand({ 'INPUT_GITHUB-TOKEN': '  ' })).toThrow(ActionInputError);

    expect(() => actionCommand({
      ...BASE,
      'INPUT_DRY-RUN': 'yes',
    })).toThrow('The dry-run input must be true or false, not "yes".');
  });
});
