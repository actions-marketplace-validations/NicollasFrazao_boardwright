import {
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import {
  GitHubReplay,
  type ReplayRoute,
} from '@boardwright/testing';
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  appJwt,
  appMerger,
  GitHubAppTokens,
} from '../src/index.ts';

const KEYS = generateKeyPairSync(
  'rsa',
  {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  },
);

const NOW = new Date('2026-11-25T20:00:00Z');

const INSTALLATION: ReplayRoute = {
  method: 'GET',
  path: '/repos/acme/app/installation',
  body: { id: 7 },
};

function accessToken(
  token: string,
  expiresAt: string,
): ReplayRoute {
  return {
    method: 'POST',
    path: '/app/installations/7/access_tokens',
    status: 201,
    body: {
      token,
      expires_at: expiresAt,
    },
  };
}

/** A replay that also records the authorization header of each request. */
function recording(routes: ReplayRoute[]): {
  replay: GitHubReplay;
  authorizations: string[];
  fetch: typeof fetch;
} {
  const replay = new GitHubReplay(routes);
  const authorizations: string[] = [];

  return {
    replay,
    authorizations,
    fetch: (
      input,
      init,
    ) => {
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');

      return replay.fetch(
        input,
        init,
      );
    },
  };
}

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(
    part,
    'base64url',
  ).toString('utf8'));
}

describe('appJwt', () => {
  it('signs a JWT issued by the App, valid for under ten minutes and backdated a minute', () => {
    const [
      header = '',
      payload = '',
      signature = '',
    ] = appJwt(
      '5925672',
      KEYS.privateKey,
      NOW,
    ).split('.');

    expect(decode(header)).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const seconds = NOW.getTime() / 1000;

    expect(decode(payload)).toEqual({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: '5925672',
    });

    expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(
      KEYS.publicKey,
      signature,
      'base64url',
    )).toBe(true);
  });
});

describe('GitHubAppTokens', () => {
  it('finds the installation with the App JWT, then reuses its token until shortly before it expires', async () => {
    let now = NOW;
    let keyReads = 0;

    const {
      replay,
      authorizations,
      fetch,
    } = recording([
      INSTALLATION,
      accessToken(
        'ghs_first',
        '2026-11-25T21:00:00Z',
      ),
    ]);

    const tokens = new GitHubAppTokens(
      {
        appId: '5925672',
        privateKey: () => {
          keyReads += 1;

          return Promise.resolve(KEYS.privateKey);
        },
      },
      {
        fetch,
        now: () => now,
      },
    );

    expect(await tokens.tokenFor('acme/app')).toBe('ghs_first');
    expect(await tokens.tokenFor('acme/other')).toBe('ghs_first');

    // The App's own requests carry its JWT, never an installation token.
    expect(authorizations.every((value) => value.startsWith('bearer ey'))).toBe(true);
    expect(replay.requests).toHaveLength(2);

    // Five minutes before it expires, the token is renewed.
    now = new Date('2026-11-25T20:56:00Z');
    await tokens.tokenFor('acme/app');

    expect(replay.to(
      'POST',
      '/app/installations/7/access_tokens',
    )).toHaveLength(2);

    expect(replay.to(
      'GET',
      '/repos/acme/app/installation',
    )).toHaveLength(1);

    expect(keyReads).toBe(1);
  });

  it('fails when the App is not installed on the repository', async () => {
    const tokens = new GitHubAppTokens(
      {
        appId: '1',
        privateKey: () => Promise.resolve(KEYS.privateKey),
      },
      {
        fetch: new GitHubReplay([
          {
            ...INSTALLATION,
            status: 404,
            body: { message: 'Not Found' },
          },
        ]).fetch,
        now: () => NOW,
      },
    );

    await expect(tokens.tokenFor('acme/app')).rejects.toThrow('Not Found');
  });
});

describe('GitHubAppTokens: installations', () => {
  it('reads the installation\'s permissions, and says when the App is not installed', async () => {
    const tokens = new GitHubAppTokens(
      {
        appId: '1',
        privateKey: () => Promise.resolve(KEYS.privateKey),
      },
      {
        fetch: new GitHubReplay([
          {
            ...INSTALLATION,
            body: {
              id: 7,
              permissions: {
                contents: 'write',
                pull_requests: 'write',
                metadata: 'read',
              },
            },
          },
          {
            method: 'GET',
            path: '/repos/acme/other/installation',
            status: 404,
            body: { message: 'Not Found' },
          },
          {
            method: 'GET',
            path: '/repos/acme/down/installation',
            status: 500,
            body: { message: 'Server Error' },
          },
        ]).fetch,
        now: () => NOW,
      },
    );

    expect(await tokens.installationOf('acme/app')).toEqual({
      permissions: {
        contents: 'write',
        pull_requests: 'write',
        metadata: 'read',
      },
    });

    expect(await tokens.installationOf('acme/other')).toBeUndefined();
    await expect(tokens.installationOf('acme/down')).rejects.toMatchObject({ status: 500 });
  });
});

describe('GitHubAppTokens: the bot', () => {
  it('names the App\'s bot from its slug', async () => {
    const tokens = new GitHubAppTokens(
      {
        appId: '1',
        privateKey: () => Promise.resolve(KEYS.privateKey),
      },
      {
        fetch: new GitHubReplay([
          {
            method: 'GET',
            path: '/app',
            body: { slug: 'boardwright-agent' },
          },
        ]).fetch,
        now: () => NOW,
      },
    );

    expect(await tokens.botLogin()).toBe('boardwright-agent[bot]');
  });
});

describe('appMerger', () => {
  it('merges with the installation token of the pull request\'s repository', async () => {
    const {
      authorizations,
      fetch,
    } = recording([
      INSTALLATION,
      accessToken(
        'ghs_merge',
        '2026-11-25T21:00:00Z',
      ),
      {
        method: 'PUT',
        path: '/repos/acme/app/pulls/16/merge',
        body: { merged: true },
      },
    ]);

    const merger = appMerger(new GitHubAppTokens(
      {
        appId: '5925672',
        privateKey: () => Promise.resolve(KEYS.privateKey),
      },
      {
        fetch,
        now: () => NOW,
      },
    ));

    expect(await merger.merge({
      repository: 'acme/app',
      number: 16,
      pullRequestId: 'PR_16',
      headSha: 'def5678',
      method: 'squash',
    })).toBe('merged');

    expect(authorizations.at(-1)).toBe('token ghs_merge');
  });
});
