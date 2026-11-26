import type {
  MergeRequest,
  MergerPort,
} from '@boardwright/core';
import type { GitHubAppTokens } from './app-tokens.ts';
import {
  splitRepository,
  type GitHubClient,
} from './client.ts';

const HTTP_METHOD_NOT_ALLOWED = 405;

const ENABLE_AUTO_MERGE_MUTATION = `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod, expectedHeadOid: $head }) {
    pullRequest { id }
  }
}`;

/**
 * Merges through the GitHub API with the merge token, never bypassing the ruleset.
 *
 * @remarks
 * It merges at the evaluated head commit (`sha`), so a push after the evaluation makes the merge fail
 * instead of merging unchecked commits. When the ruleset still holds the pull request (405), it turns on
 * native auto-merge, pinned to the same head, which GitHub completes once the required checks pass.
 */
export class GitHubMerger implements MergerPort {
  private readonly client: GitHubClient;

  constructor(client: GitHubClient) {
    this.client = client;
  }

  /** Merges now, or turns on auto-merge when the ruleset is not satisfied yet. */
  async merge(request: MergeRequest): Promise<'merged' | 'auto-merge'> {
    try {
      await this.client.rest.pulls.merge({
        ...splitRepository(request.repository),
        pull_number: request.number,
        sha: request.headSha,
        merge_method: request.method,
      });

      return 'merged';
    } catch (error) {
      if (!isMethodNotAllowed(error)) {
        throw error;
      }

      await this.client.graphql(
        ENABLE_AUTO_MERGE_MUTATION,
        {
          id: request.pullRequestId,
          mergeMethod: request.method.toUpperCase(),
          head: request.headSha,
        },
      );

      return 'auto-merge';
    }
  }
}

/**
 * Merges as a GitHub App: each merge runs on the installation token of the pull request's repository,
 * so the App, not the person who opened the pull request, is the one that merges.
 */
export function appMerger(tokens: Pick<GitHubAppTokens, 'clientFor'>): MergerPort {
  return {
    merge: async (request) => new GitHubMerger(await tokens.clientFor(request.repository)).merge(request),
  };
}

function isMethodNotAllowed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === HTTP_METHOD_NOT_ALLOWED;
}
