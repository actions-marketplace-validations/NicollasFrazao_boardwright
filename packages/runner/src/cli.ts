#!/usr/bin/env node
import { constants } from 'node:fs';
import {
  access,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  delimiter,
  join,
} from 'node:path';
import { ClaudeAgentProvider } from '@boardwright/agent-claude';
import { GitWorkspaces } from '@boardwright/git';
import {
  appMerger,
  createGitHubClient,
  GitHubAppTokens,
  GitHubMerger,
  GitHubRepoHost,
  ProjectBoard,
} from '@boardwright/github';
import { sleep } from './daemon.ts';
import { acquireFileLock } from './lock.ts';
import {
  runProgram,
  type AppCredentials,
} from './program.ts';
// The root manifest carries the release version. esbuild inlines its version only (scripts/version-only-manifest.mjs), so dist/ prints the version it was built from.
import manifest from '../../../package.json' with { type: 'json' };

function hasCode(
  error: unknown,
  code: string,
): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Where the clones and worktrees live: BOARDWRIGHT_CACHE_DIR, else the XDG cache directory. */
function cacheDirectory(): string {
  return process.env.BOARDWRIGHT_CACHE_DIR ?? join(
    process.env.XDG_CACHE_HOME ?? join(
      homedir(),
      '.cache',
    ),
    'boardwright',
  );
}

/** Whether an executable named `name` is in one of the `PATH`'s directories. */
async function onPath(name: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory === '') {
      continue;
    }

    try {
      await access(
        join(
          directory,
          name,
        ),
        constants.X_OK,
      );

      return true;
    } catch {
      // Not in this directory; the next one may have it.
    }
  }

  return false;
}

const tokensByApp = new WeakMap<AppCredentials, GitHubAppTokens>();

/** One token cache per App, shared by the reviews and the merges of a run. */
function appTokens(credentials: AppCredentials): GitHubAppTokens {
  let tokens = tokensByApp.get(credentials);

  if (tokens === undefined) {
    tokens = new GitHubAppTokens(credentials);

    tokensByApp.set(
      credentials,
      tokens,
    );
  }

  return tokens;
}

// SIGINT or SIGTERM lets the current tick finish and stops the runner.
const shutdown = new AbortController();

for (const signal of [
  'SIGINT',
  'SIGTERM',
] as const) {
  process.once(
    signal,
    () => {
      process.stderr.write(`${JSON.stringify({
        level: 'info',
        event: 'daemon.shutdown',
        signal,
      })}\n`);

      shutdown.abort();
    },
  );
}

// The composition root: the only module that touches the process, the file system and the token.
process.exitCode = await runProgram(
  process.argv.slice(2),
  {
    version: manifest.version,
    // Live: a variable loadEnvFile adds is seen here and by the adapters, which strip the tokens from the agent's environment.
    variables: process.env,
    loadEnvFile: (path) => {
      process.loadEnvFile(path);
    },
    readFile: (path) => readFile(
      path,
      'utf8',
    ).catch((error: unknown) => {
      if (hasCode(
        error,
        'ENOENT',
      )) {
        return undefined;
      }

      throw error;
    }),
    createFile: (
      path,
      text,
    ) => writeFile(
      path,
      text,
      { flag: 'wx' },
    ).then(
      () => true,
      (error: unknown) => {
        if (hasCode(
          error,
          'EEXIST',
        )) {
          return false;
        }

        throw error;
      },
    ),
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    connect: (
      config,
      token,
      app,
    ) => {
      const client = createGitHubClient({ token });

      return {
        board: new ProjectBoard(
          client,
          config.project,
        ),
        repoHost: new GitHubRepoHost(
          client,
          app === undefined ? {} : {
            actor: (repository) => appTokens(app).clientFor(repository),
            trustedAuthors: async () => [await appTokens(app).botLogin()],
          },
        ),
      };
    },
    shutdownSignal: () => shutdown.signal,
    sleep,
    acquireLock: (name) => acquireFileLock(join(
      cacheDirectory(),
      'locks',
      `${name}.lock`,
    )),
    connectMerger: (token) => new GitHubMerger(createGitHubClient({ token })),
    connectAppMerger: (credentials) => appMerger(appTokens(credentials)),
    inspectApp: appTokens,
    platform: process.platform,
    hasCommand: (name) => onPath(name),
    connectAgents: (
      config,
      token,
    ) => ({
      workspaces: new GitWorkspaces({
        directory: cacheDirectory(),
        remoteUrl: (repository) => `https://github.com/${repository}.git`,
        token,
        author: config.git.author,
      }),
      agent: new ClaudeAgentProvider({ sandbox: config.provider.sandbox }),
    }),
  },
);
