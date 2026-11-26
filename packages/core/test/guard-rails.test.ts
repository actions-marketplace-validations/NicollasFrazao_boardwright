import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  canTriage,
  DEFAULT_DENIED_PATHS,
  findDeniedPaths,
  findFutureDatedPaths,
  isAllowedRepository,
} from '../src/index.ts';

describe('canTriage', () => {
  it.each([
    [
      'none',
      false,
    ],
    [
      'read',
      false,
    ],
    [
      'triage',
      true,
    ],
    [
      'write',
      true,
    ],
    [
      'maintain',
      true,
    ],
    [
      'admin',
      true,
    ],
  ] as const)('%s → %s', (
    permission,
    expected,
  ) => {
    expect(canTriage(permission)).toBe(expected);
  });
});

describe('isAllowedRepository', () => {
  it('matches owner/name ignoring case', () => {
    expect(isAllowedRepository(
      'Acme/App',
      ['acme/app'],
    )).toBe(true);
  });

  it('rejects a repository outside the list', () => {
    expect(isAllowedRepository(
      'acme/other',
      ['acme/app'],
    )).toBe(false);
  });
});

describe('findDeniedPaths with the default denylist', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/workflows/nested/release.yml',
    '.env',
    'apps/api/.env',
    'apps/api/.env.production',
    'certs/server.pem',
    'deploy/id.key',
  ])('denies %s', (path) => {
    expect(findDeniedPaths(
      [path],
      DEFAULT_DENIED_PATHS,
    )).toEqual([path]);
  });

  it.each([
    'src/index.ts',
    '.github/dependabot.yml',
    '.github/pull_request_template.md',
    'docs/environment.md',
  ])('allows %s', (path) => {
    expect(findDeniedPaths(
      [path],
      DEFAULT_DENIED_PATHS,
    )).toEqual([]);
  });
});

describe('findFutureDatedPaths', () => {
  it('finds the file names dated after today, in both the Laravel and the dashed form, and nothing else', () => {
    expect(findFutureDatedPaths(
      [
        'database/migrations/2026_11_26_000003_add_role_to_users_table.php',
        'database/migrations/2026_11_27_000000_add_role_to_users_table.php',
        'docs/adr/2026-12-01-decision.md',
        'docs/adr/0010-admin-catalogue.md',
        'src/2026_11_27.ts',
        '2027_01_01_000000_top_level.php',
        'notes/v2026_11_30_draft.md',
      ],
      '2026-11-26',
    )).toEqual([
      'database/migrations/2026_11_27_000000_add_role_to_users_table.php',
      'docs/adr/2026-12-01-decision.md',
      'src/2026_11_27.ts',
      '2027_01_01_000000_top_level.php',
    ]);
  });
});
