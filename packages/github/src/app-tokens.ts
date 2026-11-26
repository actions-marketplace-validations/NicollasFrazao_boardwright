import { createSign } from 'node:crypto';
import type {
  AppInstallation,
  AppInstallationsPort,
} from '@boardwright/core';
import {
  createGitHubClient,
  isNotFound,
  splitRepository,
  type GitHubClient,
} from './client.ts';

/** A GitHub App's id and a way to read its private key, read once, on first use. */
export interface GitHubAppCredentials {
  readonly appId: string;
  readonly privateKey: () => Promise<string>;
}

/** How the App's tokens reach GitHub and tell the time. */
export interface GitHubAppTokensOptions {
  /** Replaces the global `fetch`; tests pass a replay. */
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** GitHub accepts an App's JWT for at most ten minutes; issue it a minute in the past against clock drift. */
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

/** An installation token is renewed this long before it expires, so no request carries an expiring one. */
const RENEW_BEFORE_MINUTES = 5;
const RENEW_BEFORE_MS = RENEW_BEFORE_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * The installation tokens of a GitHub App: one installation per repository owner, each token kept until
 * shortly before it expires.
 *
 * @remarks
 * Neither the key nor a token is logged or written anywhere; Octokit holds them only for its requests.
 */
export class GitHubAppTokens implements AppInstallationsPort {
  private readonly credentials: GitHubAppCredentials;

  private readonly fetch: typeof fetch | undefined;

  private readonly now: () => Date;

  private readonly installations = new Map<string, number>();

  private readonly tokens = new Map<number, CachedToken>();

  private key: Promise<string> | undefined;

  constructor(
    credentials: GitHubAppCredentials,
    options: GitHubAppTokensOptions = {},
  ) {
    this.credentials = credentials;
    this.fetch = options.fetch;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** A client that acts as the App's installation on the repository's owner. */
  async clientFor(repository: string): Promise<GitHubClient> {
    return createGitHubClient({
      token: await this.tokenFor(repository),
      ...this.fetch === undefined ? {} : { fetch: this.fetch },
    });
  }

  /**
   * An installation token for the repository's owner.
   *
   * @throws when the App is not installed on the repository (GitHub's 404).
   */
  async tokenFor(repository: string): Promise<string> {
    const installation = await this.installationIdOf(repository);
    const cached = this.tokens.get(installation);

    if (
      cached !== undefined
      && cached.expiresAt - RENEW_BEFORE_MS > this.now().getTime()
    ) {
      return cached.token;
    }

    const app = await this.appClient();
    const { data } = await app.rest.apps.createInstallationAccessToken({ installation_id: installation });

    this.tokens.set(
      installation,
      {
        token: data.token,
        expiresAt: Date.parse(data.expires_at),
      },
    );

    return data.token;
  }

  /**
   * The App's installation on the repository, with its permissions; `undefined` when it is not installed.
   * `doctor` reads it.
   */
  async installationOf(repository: string): Promise<AppInstallation | undefined> {
    const app = await this.appClient();

    try {
      const { data } = await app.rest.apps.getRepoInstallation(splitRepository(repository));

      const permissions: Record<string, string> = {};

      for (const [
        name,
        level,
      ] of Object.entries(data.permissions)) {
        if (typeof level === 'string') {
          permissions[name] = level;
        }
      }

      return { permissions };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  /** The login the App acts as, `<slug>[bot]`: the author of what it writes. */
  async botLogin(): Promise<string> {
    const app = await this.appClient();
    const { data } = await app.rest.apps.getAuthenticated();

    return `${data?.slug ?? ''}[bot]`;
  }

  private async installationIdOf(repository: string): Promise<number> {
    const { owner } = splitRepository(repository);
    const known = this.installations.get(owner);

    if (known !== undefined) {
      return known;
    }

    const { data } = await (await this.appClient()).rest.apps.getRepoInstallation(splitRepository(repository));

    this.installations.set(
      owner,
      data.id,
    );

    return data.id;
  }

  /** A client authenticated as the App itself, with a fresh JWT. */
  private async appClient(): Promise<GitHubClient> {
    this.key ??= this.credentials.privateKey();

    return createGitHubClient({
      token: appJwt(
        this.credentials.appId,
        await this.key,
        this.now(),
      ),
      ...this.fetch === undefined ? {} : { fetch: this.fetch },
    });
  }
}

/** The App's JWT (RS256), as GitHub expects it: issued by the App id, valid for under ten minutes. */
export function appJwt(
  appId: string,
  privateKey: string,
  now: Date,
): string {
  const seconds = Math.floor(now.getTime() / MS_PER_SECOND);

  const unsigned = [
    {
      alg: 'RS256',
      typ: 'JWT',
    },
    {
      iat: seconds - JWT_BACKDATE_SECONDS,
      exp: seconds + JWT_LIFETIME_SECONDS,
      iss: appId,
    },
  ].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');

  const signature = createSign('RSA-SHA256').update(unsigned).sign(
    privateKey,
    'base64url',
  );

  return `${unsigned}.${signature}`;
}
