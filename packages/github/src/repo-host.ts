import type {
  ChecksState,
  Feedback,
  Issue,
  MergeFacts,
  Mergeability,
  IssueComment,
  IssueRef,
  LabelActor,
  PullRequest,
  PullRequestDraft,
  RepoHostPort,
  RepositoryPermission,
  ReviewDraft,
} from '@boardwright/core';
import { parseReviewMarker } from '@boardwright/core';
import {
  isNotFound,
  isUnprocessable,
  splitRepository,
  type GitHubClient,
} from './client.ts';

const FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved path line comments(last: 1) { nodes { body } } }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  ... on CheckRun { name conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id } }
}`;

const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);

const FAILED_STATES: ReadonlySet<string> = new Set([
  'FAILURE',
  'ERROR',
]);

interface CheckContext {
  readonly name?: string;
  readonly conclusion?: string | null;
  readonly context?: string;
  readonly state?: string;
}

interface CheckRollup {
  readonly contexts: { readonly nodes: readonly CheckContext[] };
}

interface FeedbackQuery {
  readonly repository: {
    readonly pullRequest: {
      readonly reviewThreads: {
        readonly nodes: readonly {
          readonly id: string;
          readonly isResolved: boolean;
          readonly path: string;
          readonly line: number | null;
          readonly comments: { readonly nodes: readonly { readonly body: string }[] };
        }[];
      };
      readonly commits: {
        readonly nodes: readonly {
          readonly commit: { readonly statusCheckRollup: CheckRollup | null };
        }[];
      };
    } | null;
  } | null;
}

const MERGE_FACTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid isDraft mergeable additions deletions
      autoMergeRequest { enabledAt }
      labels(first: 50) { nodes { name } }
      files(first: 100) { nodes { path } }
      reviewThreads(first: 100) { nodes { isResolved } }
      reviews(last: 50) { nodes { body author { login } commit { oid } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

interface Rollup {
  readonly state: string;
}

interface RollupCommit {
  readonly statusCheckRollup: Rollup | null;
}

interface MergeFactsQuery {
  readonly repository: {
    readonly pullRequest: {
      readonly id: string;
      readonly headRefOid: string;
      readonly isDraft: boolean;
      readonly mergeable: string;
      readonly additions: number;
      readonly deletions: number;
      readonly autoMergeRequest: { readonly enabledAt: string } | null;
      readonly labels: { readonly nodes: readonly { readonly name: string }[] };
      readonly files: { readonly nodes: readonly { readonly path: string }[] };
      readonly reviewThreads: { readonly nodes: readonly { readonly isResolved: boolean }[] };
      readonly reviews: {
        readonly nodes: readonly {
          readonly body: string;
          readonly author: { readonly login: string } | null;
          readonly commit: { readonly oid: string } | null;
        }[];
      };
      readonly commits: { readonly nodes: readonly { readonly commit: RollupCommit }[] };
    };
  };
}

function checksStateOf(state: string | undefined): ChecksState {
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case undefined:
      return 'none';
    default:
      return 'pending';
  }
}

function mergeabilityOf(mergeable: string): Mergeability {
  switch (mergeable) {
    case 'MERGEABLE':
      return 'mergeable';
    case 'CONFLICTING':
      return 'conflicting';
    default:
      return 'unknown';
  }
}

/** The name of a check run or a commit status that failed; nothing for one that passed or is running. */
function failingCheckName(context: CheckContext): string[] {
  if (
    context.name !== undefined
    && FAILED_CONCLUSIONS.has(context.conclusion ?? '')
  ) {
    return [context.name];
  }

  if (
    context.context !== undefined
    && FAILED_STATES.has(context.state ?? '')
  ) {
    return [context.context];
  }

  return [];
}

/** GitHub ids grow with time; padding keeps their string order equal to their creation order. */
const COMMENT_ID_WIDTH = 20;

const ROLE_PERMISSIONS: ReadonlySet<string> = new Set<RepositoryPermission>([
  'read',
  'triage',
  'write',
  'maintain',
  'admin',
]);

const RECENT_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number createdAt }
    }
  }
}`;

interface RecentIssuesQuery {
  readonly repository: {
    readonly issues: {
      readonly pageInfo: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
      readonly nodes: readonly {
        readonly number: number;
        readonly createdAt: string;
      }[];
    };
  } | null;
}

/** Who else acts on the repository host. */
export interface GitHubRepoHostOptions {
  /**
   * The client the pipeline writes as, per repository: a GitHub App's installation (ADR 0005). It posts the
   * comments and the run markers, submits the reviews (so one can approve a pull request the main token
   * opened) and resolves threads. Without it, all of that goes out on the main client.
   */
  readonly actor?: (repository: string) => Promise<GitHubClient>;

  /**
   * The logins of the pipeline's other identities, such as its GitHub App's bot. Markers count only when the
   * main token's account or one of these wrote them.
   */
  readonly trustedAuthors?: () => Promise<readonly string[]>;
}

const VIEWER_QUERY = 'query { viewer { login } }';

/** A login as both APIs give it: REST names a bot `app[bot]`, GraphQL `app`; case does not matter. */
function normalizeLogin(login: string): string {
  return login.replace(
    /\[bot\]$/u,
    '',
  ).toLowerCase();
}

const REVIEW_EVENTS = {
  comment: 'COMMENT',
  approve: 'APPROVE',
  'request-changes': 'REQUEST_CHANGES',
} as const;

/** Issues, comments, labels, files and pull requests through the GitHub REST API. */
export class GitHubRepoHost implements RepoHostPort {
  private readonly client: GitHubClient;

  private readonly actor: GitHubRepoHostOptions['actor'];

  private readonly trustedAuthors: GitHubRepoHostOptions['trustedAuthors'];

  private trusted: Promise<ReadonlySet<string>> | undefined;

  constructor(
    client: GitHubClient,
    options: GitHubRepoHostOptions = {},
  ) {
    this.client = client;
    this.actor = options.actor;
    this.trustedAuthors = options.trustedAuthors;
  }

  /** The client the pipeline writes as on the repository: its App's installation, else the main client. */
  private async actorFor(repository: string): Promise<GitHubClient> {
    return this.actor === undefined ? this.client : await this.actor(repository);
  }

  /**
   * Whether a comment or a review by this login may carry the pipeline's markers: only the pipeline's own
   * identities may, so nobody else can forge a run's history or a review's verdict.
   */
  private async isTrusted(login: string | undefined): Promise<boolean> {
    if (login === undefined) {
      return false;
    }

    this.trusted ??= this.loadTrusted();

    return (await this.trusted).has(normalizeLogin(login));
  }

  private async loadTrusted(): Promise<ReadonlySet<string>> {
    const { viewer } = await this.client.graphql<{ viewer: { login: string } }>(VIEWER_QUERY);

    return new Set([
      viewer.login,
      ...await this.trustedAuthors?.() ?? [],
    ].map(normalizeLogin));
  }

  /** The items whose author is one of the pipeline's identities, in their order. */
  private async byPipeline<T>(
    items: readonly T[],
    authorOf: (item: T) => string | undefined,
  ): Promise<T[]> {
    const kept: T[] = [];

    for (const item of items) {
      if (await this.isTrusted(authorOf(item))) {
        kept.push(item);
      }
    }

    return kept;
  }

  /** The issue's title, body, label names and whether it is open. */
  async getIssue(ref: IssueRef): Promise<Issue> {
    const { data } = await this.client.rest.issues.get({
      ...splitRepository(ref.repository),
      issue_number: ref.number,
    });

    return {
      ref,
      title: data.title,
      body: data.body ?? '',
      labels: data.labels.map((label) => typeof label === 'string' ? label : label.name ?? ''),
      isOpen: data.state === 'open',
      assignees: (data.assignees ?? []).map((user) => user.login),
    };
  }

  /**
   * The open issues created at or after `createdAfter`, newest first.
   *
   * @remarks
   * Reads the newest open issues a page at a time and stops at the first one older than the window, so a
   * repository with a long backlog costs one request per tick.
   */
  async listRecentIssues(
    repository: string,
    createdAfter: Date,
  ): Promise<IssueRef[]> {
    const {
      owner,
      repo,
    } = splitRepository(repository);

    const recent: IssueRef[] = [];
    let after: string | null = null;

    do {
      const data: RecentIssuesQuery = await this.client.graphql<RecentIssuesQuery>(
        RECENT_ISSUES_QUERY,
        {
          owner,
          name: repo,
          after,
        },
      );

      const issues = data.repository?.issues;

      for (const issue of issues?.nodes ?? []) {
        if (new Date(issue.createdAt) < createdAfter) {
          return recent;
        }

        recent.push({
          repository,
          number: issue.number,
        });
      }

      after = issues?.pageInfo.hasNextPage === true ? issues.pageInfo.endCursor : null;
    } while (after !== null);

    return recent;
  }

  /**
   * The person who most recently added the label, read from the issue's events, with their role.
   *
   * @remarks
   * The latest `labeled` event decides: if a stranger adds the label and a maintainer re-adds it, the
   * maintainer is who released the issue. Someone who is not a collaborator has no permission (`none`).
   */
  async findLabelActor(
    ref: IssueRef,
    label: string,
  ): Promise<LabelActor | undefined> {
    const repository = splitRepository(ref.repository);

    const events = await this.client.paginate(
      this.client.rest.issues.listEvents,
      {
        ...repository,
        issue_number: ref.number,
        per_page: 100,
      },
    );

    const login = events.findLast((event) => isLabeledWith(
      event,
      label,
    ))?.actor.login;

    if (login === undefined) {
      return undefined;
    }

    return {
      login,
      permission: await this.permissionOf(
        repository,
        login,
      ),
    };
  }

  /** Every comment of the issue, oldest first. */
  async listComments(ref: IssueRef): Promise<IssueComment[]> {
    const comments = await this.client.paginate(
      this.client.rest.issues.listComments,
      {
        ...splitRepository(ref.repository),
        issue_number: ref.number,
        per_page: 100,
      },
    );

    const ours = await this.byPipeline(
      comments,
      (comment) => comment.user?.login,
    );

    return ours.map((comment) => ({
      id: String(comment.id).padStart(
        COMMENT_ID_WIDTH,
        '0',
      ),
      body: comment.body ?? '',
      createdAt: new Date(comment.created_at),
    }));
  }

  /** Posts a comment on the issue, as the pipeline's actor. */
  async addComment(
    ref: IssueRef,
    body: string,
  ): Promise<void> {
    const client = await this.actorFor(ref.repository);

    await client.rest.issues.createComment({
      ...splitRepository(ref.repository),
      issue_number: ref.number,
      body,
    });
  }

  /** The repository's default branch. */
  async getDefaultBranch(repository: string): Promise<string> {
    const { data } = await this.client.rest.repos.get(splitRepository(repository));

    return data.default_branch;
  }

  /** The open pull request whose head is `head` in the same repository. */
  async findOpenPullRequest(
    repository: string,
    head: string,
  ): Promise<PullRequest | undefined> {
    const name = splitRepository(repository);

    const { data } = await this.client.rest.pulls.list({
      ...name,
      state: 'open',
      head: `${name.owner}:${head}`,
      per_page: 1,
    });

    const [pullRequest] = data;

    return pullRequest === undefined ? undefined : {
      number: pullRequest.number,
      url: pullRequest.html_url,
      headSha: pullRequest.head.sha,
    };
  }

  /**
   * Opens a pull request and assigns the draft's assignees.
   *
   * @remarks
   * The create endpoint takes no assignees, so they are a second request; GitHub silently drops a login
   * that cannot be assigned.
   */
  async openPullRequest(draft: PullRequestDraft): Promise<PullRequest> {
    const { data } = await this.client.rest.pulls.create({
      ...splitRepository(draft.repository),
      head: draft.head,
      base: draft.base,
      title: draft.title,
      body: draft.body,
    });

    if (draft.assignees.length > 0) {
      await this.client.rest.issues.addAssignees({
        ...splitRepository(draft.repository),
        issue_number: data.number,
        assignees: [...draft.assignees],
      });
    }

    return {
      number: data.number,
      url: data.html_url,
      headSha: data.head.sha,
    };
  }

  /**
   * The unresolved review threads and the failing checks of the head commit, in one GraphQL query.
   *
   * @remarks
   * Reads the first 100 threads and 100 checks; a pull request with more is beyond what one round fixes.
   * Checks still running are not failing yet.
   */
  async getFeedback(
    repository: string,
    number: number,
  ): Promise<Feedback> {
    const {
      owner,
      repo,
    } = splitRepository(repository);

    const data = await this.client.graphql<FeedbackQuery>(
      FEEDBACK_QUERY,
      {
        owner,
        name: repo,
        number,
      },
    );

    const pullRequest = data.repository?.pullRequest;
    const contexts = pullRequest?.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];

    return {
      threads: (pullRequest?.reviewThreads.nodes ?? [])
        .filter((thread) => !thread.isResolved)
        .map((thread) => ({
          id: thread.id,
          path: thread.path,
          line: thread.line,
          body: thread.comments.nodes[0]?.body ?? '',
        })),
      failingChecks: contexts.flatMap((context) => failingCheckName(context)),
    };
  }

  /** Marks a review thread resolved. */
  async resolveThread(
    repository: string,
    threadId: string,
  ): Promise<void> {
    const client = await this.actorFor(repository);

    await client.graphql(
      RESOLVE_THREAD_MUTATION,
      { id: threadId },
    );
  }

  /**
   * What the merge policy needs, read in one GraphQL query right before it decides.
   *
   * @remarks
   * Reads the first 100 files, threads and reviews; a pull request beyond that is past the size limit a
   * merge policy should allow anyway. The changed lines are GitHub's additions plus deletions.
   */
  async getMergeFacts(
    repository: string,
    number: number,
  ): Promise<MergeFacts> {
    const {
      owner,
      repo,
    } = splitRepository(repository);

    const data = await this.client.graphql<MergeFactsQuery>(
      MERGE_FACTS_QUERY,
      {
        owner,
        name: repo,
        number,
      },
    );

    const pullRequest = data.repository.pullRequest;
    const headSha = pullRequest.headRefOid;

    const ours = await this.byPipeline(
      pullRequest.reviews.nodes,
      (review) => review.author?.login,
    );

    const verdicts = ours
      .filter((review) => review.commit?.oid === headSha)
      .map((review) => parseReviewMarker(review.body))
      .filter((marker) => marker?.headSha === headSha);

    return {
      pullRequestId: pullRequest.id,
      headSha,
      isDraft: pullRequest.isDraft,
      labels: pullRequest.labels.nodes.map((label) => label.name),
      checks: checksStateOf(pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.state),
      mergeability: mergeabilityOf(pullRequest.mergeable),
      unresolvedThreads: pullRequest.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
      agentVerdict: verdicts.at(-1)?.verdict,
      changedLines: pullRequest.additions + pullRequest.deletions,
      changedPaths: pullRequest.files.nodes.map((file) => file.path),
      isAutoMergeEnabled: pullRequest.autoMergeRequest !== null,
    };
  }

  /** Whether a review carrying the pipeline's marker was posted for this head commit. */
  async hasAgentReview(
    repository: string,
    number: number,
    headSha: string,
  ): Promise<boolean> {
    const reviews = await this.client.paginate(
      this.client.rest.pulls.listReviews,
      {
        ...splitRepository(repository),
        pull_number: number,
        per_page: 100,
      },
    );

    const ours = await this.byPipeline(
      reviews,
      (review) => review.user?.login,
    );

    return ours.some((review) => review.commit_id === headSha
      && parseReviewMarker(review.body)?.headSha === headSha);
  }

  /**
   * Posts a review with its line comments, as a comment, an approval or a change request, as the pipeline's
   * actor.
   *
   * @remarks
   * GitHub rejects the whole review (422) when one comment points at a line outside the diff; the review is
   * then posted again with the comments in its body, so no finding is lost.
   */
  async submitReview(review: ReviewDraft): Promise<void> {
    const client = await this.actorFor(review.repository);

    const target = {
      ...splitRepository(review.repository),
      pull_number: review.number,
      commit_id: review.headSha,
      event: REVIEW_EVENTS[review.event],
    };

    try {
      await client.rest.pulls.createReview({
        ...target,
        body: review.body,
        comments: review.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT' as const,
          body: comment.body,
        })),
      });
    } catch (error) {
      if (
        !isUnprocessable(error)
        || review.comments.length === 0
      ) {
        throw error;
      }

      await client.rest.pulls.createReview({
        ...target,
        body: [
          review.body,
          '',
          '**Line comments** (GitHub could not place them on the diff):',
          '',
          ...review.comments.map((comment) => `- \`${comment.path}:${comment.line}\` ${comment.body}`),
        ].join('\n'),
      });
    }
  }

  /** Whether the repository has a label with this exact name. */
  async hasLabel(
    repository: string,
    label: string,
  ): Promise<boolean> {
    try {
      await this.client.rest.issues.getLabel({
        ...splitRepository(repository),
        name: label,
      });

      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }

      throw error;
    }
  }

  /** A file on the default branch, as text; `undefined` when it does not exist or is a directory. */
  async readFile(
    repository: string,
    path: string,
  ): Promise<string | undefined> {
    try {
      const { data } = await this.client.rest.repos.getContent({
        ...splitRepository(repository),
        path,
        mediaType: { format: 'raw' },
      });

      return typeof data === 'string' ? data : undefined;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }
  }

  /** The names in a directory on the default branch, sorted; empty when it does not exist. */
  async listDirectory(
    repository: string,
    path: string,
  ): Promise<string[]> {
    try {
      const { data } = await this.client.rest.repos.getContent({
        ...splitRepository(repository),
        path,
      });

      return Array.isArray(data) ? data.map((entry) => entry.name).sort((
        left,
        right,
      ) => left.localeCompare(right)) : [];
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw error;
    }
  }

  private async permissionOf(
    repository: {
      owner: string;
      repo: string;
    },
    username: string,
  ): Promise<RepositoryPermission> {
    try {
      const { data } = await this.client.rest.repos.getCollaboratorPermissionLevel({
        ...repository,
        username,
      });

      return toPermission(data.role_name) ?? toPermission(data.permission) ?? 'none';
    } catch (error) {
      if (isNotFound(error)) {
        return 'none';
      }

      throw error;
    }
  }
}

function toPermission(value: string | undefined): RepositoryPermission | undefined {
  return value !== undefined && ROLE_PERMISSIONS.has(value) ? value as RepositoryPermission : undefined;
}

function isLabeledWith(
  event: object,
  label: string,
): boolean {
  return 'event' in event
    && event.event === 'labeled'
    && 'label' in event
    && typeof event.label === 'object'
    && event.label !== null
    && 'name' in event.label
    && event.label.name === label;
}
