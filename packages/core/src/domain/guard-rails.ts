import { posix } from 'node:path';

/** A person's permission on a repository, as GitHub reports it. */
export type RepositoryPermission = 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin';

const PERMISSION_ORDER: readonly RepositoryPermission[] = [
  'none',
  'read',
  'triage',
  'write',
  'maintain',
  'admin',
];

/**
 * Whether a permission includes triage, the right needed to release an issue to the pipeline.
 *
 * @remarks
 * Only people who could label the issue themselves may start an agent on it; an issue's text
 * becomes the agent's instructions.
 */
export function canTriage(permission: RepositoryPermission): boolean {
  return PERMISSION_ORDER.indexOf(permission) >= PERMISSION_ORDER.indexOf('triage');
}

/** Whether `owner/name` is in the allowlist, ignoring case as GitHub does. */
export function isAllowedRepository(
  repository: string,
  allowlist: readonly string[],
): boolean {
  const wanted = repository.toLowerCase();

  return allowlist.some((allowed) => allowed.toLowerCase() === wanted);
}

/** The changed paths that match a denied pattern, in the order they were given. */
export function findDeniedPaths(
  changedPaths: readonly string[],
  deniedPatterns: readonly string[],
): string[] {
  return changedPaths.filter((path) => deniedPatterns.some((pattern) => posix.matchesGlob(
    path,
    pattern,
  )));
}

/** A date at the start of a file name, as migrations and decision records write it: `2026_11_26_` or `2026-11-26-`. */
const LEADING_DATE = /^(?<year>\d{4})[-_](?<month>\d{2})[-_](?<day>\d{2})(?=[-_.])/u;

/**
 * The changed paths whose file name starts with a date later than `today` (an ISO `YYYY-MM-DD`), in the
 * order they were given.
 *
 * @remarks
 * An agent ordering a new migration after one of the same day must raise its sequence, not its date: a
 * file dated in the future is wrong the day it is written.
 */
export function findFutureDatedPaths(
  paths: readonly string[],
  today: string,
): string[] {
  return paths.filter((path) => {
    const groups = LEADING_DATE.exec(path.split('/').at(-1) ?? '')?.groups;

    return groups !== undefined && `${groups.year}-${groups.month}-${groups.day}` > today;
  });
}
