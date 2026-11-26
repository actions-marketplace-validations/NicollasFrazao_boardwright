import type {
  AgentProvider,
  StageConfig,
  AgentRequest,
  AgentResult,
  BoardDescription,
  BoardItem,
  BoardPort,
  Clock,
  ContextProvider,
  ContextSelector,
  Feedback,
  Issue,
  IssueComment,
  IssueRef,
  LabelActor,
  Logger,
  MergeFacts,
  MergeRequest,
  MergerPort,
  PipelineConfig,
  PullRequest,
  PullRequestDraft,
  RepoHostPort,
  ReviewDraft,
  RunIdSource,
  StageContext,
  TickDependencies,
  Workspace,
  WorkspacePort,
  WorkspaceRequest,
} from '@boardwright/core';
import { parsePipelineConfig } from '@boardwright/core';

/** `owner/name#number`, the key the fakes store issues under. */
export function keyOf(ref: IssueRef): string {
  return `${ref.repository}#${ref.number}`;
}

/** A clock that only moves when a test moves it. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(iso = '2026-11-24T12:00:00Z') {
    this.current = new Date(iso);
  }

  /** The frozen current time. */
  now(): Date {
    return new Date(this.current);
  }

  /** Moves the clock forward. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** An in-memory board. */
export class FakeBoard implements BoardPort {
  /** Every Status change, in order. */
  readonly moves: {
    itemId: string;
    status: string;
  }[] = [];

  /** The board's Status options; `undefined` plays a board without the Status field. */
  statusOptions: string[] | undefined = [
    'Todo',
    'Ready',
    'In Progress',
    'In review',
    'Done',
  ];

  readonly items: BoardItem[];

  /** The board's single-select fields besides Status, with their options. */
  singleSelectFields: Record<string, string[]> = {};

  /** Every field change, in order. */
  readonly fieldChanges: {
    itemId: string;
    field: string;
    value: string;
  }[] = [];

  /** Issues added, in order. */
  readonly added: IssueRef[] = [];

  /** Item ids whose next change fails, to play a GitHub error. */
  readonly failing = new Set<string>();

  constructor(items: BoardItem[]) {
    this.items = items;
  }

  /** The title, the Status options and the fields the test set. */
  describe(): Promise<BoardDescription> {
    return Promise.resolve({
      title: 'Roadmap',
      statusOptions: this.statusOptions,
      singleSelectFields: {
        ...this.statusOptions === undefined ? {} : { Status: this.statusOptions },
        ...this.singleSelectFields,
      },
    });
  }

  /** Adds the issue as a new item without a Status, or returns the item it already has. */
  addIssue(ref: IssueRef): Promise<string> {
    const existing = this.items.find((item) => keyOf(item.issue) === keyOf(ref));

    if (existing !== undefined) {
      return Promise.resolve(existing.itemId);
    }

    const itemId = `item-${keyOf(ref)}`;

    this.items.push({
      itemId,
      status: null,
      issue: ref,
    });

    this.added.push(ref);

    return Promise.resolve(itemId);
  }

  /** Sets a field of an item, refusing an option the board does not have. */
  setField(
    itemId: string,
    field: string,
    value: string,
  ): Promise<void> {
    const index = this.items.findIndex((item) => item.itemId === itemId);
    const item = this.items[index];

    if (
      item === undefined
      || this.failing.has(itemId)
      || this.singleSelectFields[field]?.includes(value) !== true
    ) {
      return Promise.reject(new Error(`Cannot set ${field} to "${value}" on ${itemId}`));
    }

    this.items[index] = {
      ...item,
      fields: {
        ...item.fields,
        [field]: value,
      },
    };

    this.fieldChanges.push({
      itemId,
      field,
      value,
    });

    return Promise.resolve();
  }

  /** The value of an item's field now. */
  fieldOf(
    itemId: string,
    field: string,
  ): string | undefined {
    return this.items.find((item) => item.itemId === itemId)?.fields?.[field];
  }

  /** A copy of the items. */
  listItems(): Promise<BoardItem[]> {
    return Promise.resolve(this.items.map((item) => ({ ...item })));
  }

  /** Moves an item and records the move. */
  setStatus(
    itemId: string,
    status: string,
  ): Promise<void> {
    const index = this.items.findIndex((item) => item.itemId === itemId);
    const item = this.items[index];

    if (
      item === undefined
      || this.failing.has(itemId)
    ) {
      return Promise.reject(new Error(`No item ${itemId}`));
    }

    this.items[index] = {
      ...item,
      status,
    };

    this.moves.push({
      itemId,
      status,
    });

    return Promise.resolve();
  }

  /** The Status of an item now. */
  statusOf(itemId: string): string | null | undefined {
    return this.items.find((item) => item.itemId === itemId)?.status;
  }
}

/** An in-memory repository host. */
export class FakeRepoHost implements RepoHostPort {
  readonly issues = new Map<string, Issue>();

  readonly comments = new Map<string, IssueComment[]>();

  readonly labelActors = new Map<string, LabelActor>();

  readonly openPullRequests = new Map<string, PullRequest>();

  readonly drafts: PullRequestDraft[] = [];

  /** Merge facts per pull request number. */
  readonly mergeFacts = new Map<number, MergeFacts>();

  /** Feedback per pull request number; none means nothing to address. */
  readonly feedback = new Map<number, Feedback>();

  /** Review threads the pipeline resolved, in order. */
  readonly resolvedThreads: string[] = [];

  /** Reviews posted, in order. */
  readonly reviews: ReviewDraft[] = [];

  /** Repositories that answer every request with an error. */
  readonly unreachable = new Set<string>();

  /** Labels per repository. */
  readonly labels = new Map<string, Set<string>>();

  /** Files on the default branch, keyed `owner/name:path`. */
  readonly files = new Map<string, string>();

  /** Open issues per repository with when they were created, for `listRecentIssues`. */
  readonly recentIssues = new Map<string, {
    number: number;
    createdAt: string;
  }[]>();

  /** Called after each comment is stored; a test uses it to play a competing runner. */
  afterComment: ((ref: IssueRef, body: string) => void) | undefined;

  private sequence = 0;

  private readonly clock: FakeClock;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  /** The open issues the test set that were created at or after `createdAfter`, newest first. */
  listRecentIssues(
    repository: string,
    createdAfter: Date,
  ): Promise<IssueRef[]> {
    if (this.unreachable.has(repository)) {
      return Promise.reject(new Error(`${repository} is unreachable`));
    }

    return Promise.resolve((this.recentIssues.get(repository) ?? [])
      .filter((issue) => new Date(issue.createdAt) >= createdAfter)
      .toSorted((
        left,
        right,
      ) => right.createdAt.localeCompare(left.createdAt))
      .map((issue) => ({
        repository,
        number: issue.number,
      })));
  }

  /** The merge facts the test set; rejects when there are none. */
  getMergeFacts(
    _repository: string,
    number: number,
  ): Promise<MergeFacts> {
    const facts = this.mergeFacts.get(number);

    return facts === undefined ? Promise.reject(new Error(`No merge facts for #${number}`)) : Promise.resolve(facts);
  }

  /** The feedback the test set for the pull request. */
  getFeedback(
    _repository: string,
    number: number,
  ): Promise<Feedback> {
    return Promise.resolve(this.feedback.get(number) ?? {
      threads: [],
      failingChecks: [],
    });
  }

  /** Records the thread and takes it out of the stored feedback. */
  resolveThread(
    _repository: string,
    threadId: string,
  ): Promise<void> {
    this.resolvedThreads.push(threadId);

    for (const [
      number,
      feedback,
    ] of this.feedback) {
      this.feedback.set(
        number,
        {
          ...feedback,
          threads: feedback.threads.filter((thread) => thread.id !== threadId),
        },
      );
    }

    return Promise.resolve();
  }

  /** Whether a review was posted for this head commit. */
  hasAgentReview(
    repository: string,
    number: number,
    headSha: string,
  ): Promise<boolean> {
    const matches = (review: ReviewDraft): boolean => review.repository === repository
      && review.number === number
      && review.headSha === headSha;

    return Promise.resolve(this.reviews.some(matches));
  }

  /** Records the review. */
  submitReview(review: ReviewDraft): Promise<void> {
    this.reviews.push(review);

    return Promise.resolve();
  }

  /** Whether the test added the label to the repository. */
  hasLabel(
    repository: string,
    label: string,
  ): Promise<boolean> {
    return Promise.resolve(this.labels.get(repository)?.has(label) ?? false);
  }

  /** The stored file. */
  readFile(
    repository: string,
    path: string,
  ): Promise<string | undefined> {
    return Promise.resolve(this.files.get(`${repository}:${path}`));
  }

  /** The names under a directory, derived from the stored files. */
  listDirectory(
    repository: string,
    path: string,
  ): Promise<string[]> {
    const prefix = `${repository}:${path}/`;
    const names = new Set<string>();

    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        names.add(key.slice(prefix.length).split('/')[0] ?? '');
      }
    }

    return Promise.resolve([...names].sort((
      left,
      right,
    ) => left.localeCompare(right)));
  }

  /** The stored issue; rejects when there is none. */
  getIssue(ref: IssueRef): Promise<Issue> {
    const issue = this.issues.get(keyOf(ref));

    return issue === undefined ? Promise.reject(new Error(`No issue ${keyOf(ref)}`)) : Promise.resolve(issue);
  }

  /** The stored labeller of the issue. */
  findLabelActor(ref: IssueRef): Promise<LabelActor | undefined> {
    return Promise.resolve(this.labelActors.get(keyOf(ref)));
  }

  /** A copy of the issue's comments. */
  listComments(ref: IssueRef): Promise<IssueComment[]> {
    return Promise.resolve([...(this.comments.get(keyOf(ref)) ?? [])]);
  }

  /** Stores the comment, then calls `afterComment`. */
  addComment(
    ref: IssueRef,
    body: string,
  ): Promise<void> {
    this.store(
      ref,
      body,
    );

    this.afterComment?.(
      ref,
      body,
    );

    return Promise.resolve();
  }

  /** Stores a comment as if someone else wrote it, at the clock's current time. */
  store(
    ref: IssueRef,
    body: string,
    createdAt = this.clock.now(),
  ): void {
    this.sequence += 1;

    const list = this.comments.get(keyOf(ref)) ?? [];

    list.push({
      id: `c${String(this.sequence).padStart(
        4,
        '0',
      )}`,
      body,
      createdAt,
    });

    this.comments.set(
      keyOf(ref),
      list,
    );
  }

  /** The bodies of an issue's comments. */
  bodies(ref: IssueRef): string[] {
    return (this.comments.get(keyOf(ref)) ?? []).map((comment) => comment.body);
  }

  /** `master`; rejects for a repository the test made unreachable. */
  getDefaultBranch(repository: string): Promise<string> {
    return this.unreachable.has(repository) ? Promise.reject(new Error('Not Found')) : Promise.resolve('master');
  }

  /** The open pull request stored for the branch. */
  findOpenPullRequest(
    repository: string,
    head: string,
  ): Promise<PullRequest | undefined> {
    return Promise.resolve(this.openPullRequests.get(`${repository}:${head}`));
  }

  /** Records the draft and stores a new open pull request. */
  openPullRequest(draft: PullRequestDraft): Promise<PullRequest> {
    const pullRequest = {
      number: 100 + this.drafts.length,
      url: `https://github.com/${draft.repository}/pull/${100 + this.drafts.length}`,
      headSha: 'abc1234',
    };

    this.drafts.push(draft);

    this.openPullRequests.set(
      `${draft.repository}:${draft.head}`,
      pullRequest,
    );

    return Promise.resolve(pullRequest);
  }
}

/** Workspaces that record what was done with them. */
export class FakeWorkspaces implements WorkspacePort {
  changed: string[] = ['src/feature.ts'];

  /** Whether the branch has commits; a test clears it to play an agent that forgot to commit. */
  committed = true;

  readonly prepared: Workspace[] = [];

  readonly pushed: Workspace[] = [];

  readonly disposed: Workspace[] = [];

  /** The value the test set in `committed`. */
  hasCommits(): Promise<boolean> {
    return Promise.resolve(this.committed);
  }

  /** Records a worktree under a fixed path. */
  prepare(request: WorkspaceRequest): Promise<Workspace> {
    const workspace = {
      ...request,
      path: `/work/worktrees/${request.branch}`,
      startSha: 'start00',
    };

    this.prepared.push(workspace);

    return Promise.resolve(workspace);
  }

  /** The paths the test set in `changed`. */
  changedPaths(): Promise<string[]> {
    return Promise.resolve([...this.changed]);
  }

  /** Records the push. */
  push(workspace: Workspace): Promise<void> {
    this.pushed.push(workspace);

    return Promise.resolve();
  }

  /** Records the disposal. */
  dispose(workspace: Workspace): Promise<void> {
    this.disposed.push(workspace);

    return Promise.resolve();
  }
}

/** An agent that returns a fixed result, or throws. */
export class FakeAgent implements AgentProvider {
  result: AgentResult = {
    status: 'completed',
    summary: 'Done.',
    pullRequest: {
      title: 'feat(app): add the feature',
      body: 'Adds the feature.',
    },
    review: undefined,
    addressedThreadIds: [],
    plan: undefined,
  };

  error: Error | undefined;

  readonly requests: AgentRequest[] = [];

  /** Records the request; returns `result` or rejects with `error`. */
  run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);

    return this.error === undefined ? Promise.resolve(this.result) : Promise.reject(this.error);
  }
}

/** A context provider that returns a fixed context. */
export class FakeContext implements ContextProvider {
  context: StageContext = {
    source: 'dotcontext',
    playbook: {
      agentType: 'feature-developer',
      path: '.context/agents/feature-developer.md',
    },
    skills: [
      {
        slug: 'commit-message',
        description: 'Write Conventional Commits.',
        path: '.context/skills/commit-message/SKILL.md',
      },
    ],
    instructionFiles: ['.context/docs/README.md'],
    warnings: [],
  };

  readonly selectors: ContextSelector[] = [];

  /** Records the selector; returns `context`. */
  load(
    _root: string,
    selector: ContextSelector,
  ): Promise<StageContext> {
    this.selectors.push(selector);

    return Promise.resolve(this.context);
  }
}

/** A merger that records requests and answers with `result`. */
export class FakeMerger implements MergerPort {
  result: 'merged' | 'auto-merge' = 'merged';

  readonly requests: MergeRequest[] = [];

  /** Records the request; returns `result`. */
  merge(request: MergeRequest): Promise<'merged' | 'auto-merge'> {
    this.requests.push(request);

    return Promise.resolve(this.result);
  }
}

/** Run ids `run-1`, `run-2`, … */
export class SequentialRunIds implements RunIdSource {
  private count = 0;

  /** The next sequential id. */
  next(): string {
    this.count += 1;

    return `run-${this.count}`;
  }
}

/** A logger that keeps what it was given. */
export class MemoryLogger implements Logger {
  readonly entries: {
    level: 'info' | 'warn';
    event: string;
    fields: unknown;
  }[] = [];

  /** Keeps an info entry. */
  info(
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.entries.push({
      level: 'info',
      event,
      fields,
    });
  }

  /** Keeps a warning entry. */
  warn(
    event: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void {
    this.entries.push({
      level: 'warn',
      event,
      fields,
    });
  }
}

/** The issue every scenario starts from: open, labelled `boardwright:agent` by a maintainer. */
export const ISSUE: IssueRef = {
  repository: 'acme/app',
  number: 7,
};

/**
 * The first stage of a config.
 *
 * @throws {@link Error} when the config has no stage, which fails the test.
 */
export function firstStage(config: PipelineConfig): StageConfig {
  const [stage] = config.stages;

  if (
    stage === undefined
    || stage.id === 'merge'
  ) {
    throw new Error('The config has no agent stage first');
  }

  return stage;
}

/** A minimal valid config with the implement stage and every default. */
export function baseConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
  return parsePipelineConfig({
    project: {
      owner: 'acme',
      number: 3,
    },
    repositories: ['acme/app'],
    stages: [{ id: 'implement' }],
    ...overrides,
  });
}

/** Every fake, wired as tick dependencies, around one issue in Ready. */
export interface Scenario {
  readonly dependencies: TickDependencies;
  readonly board: FakeBoard;
  readonly repoHost: FakeRepoHost;
  readonly workspaces: FakeWorkspaces;
  readonly agent: FakeAgent;
  readonly context: FakeContext;
  readonly clock: FakeClock;
  readonly logger: MemoryLogger;
  readonly merger: FakeMerger;
}

/** A scenario with one triggered issue in Ready; the config can be overridden. */
export function scenario(config: PipelineConfig = baseConfig()): Scenario {
  const clock = new FakeClock();

  const board = new FakeBoard([
    {
      itemId: 'item-7',
      status: 'Ready',
      issue: ISSUE,
    },
  ]);

  const repoHost = new FakeRepoHost(clock);
  const workspaces = new FakeWorkspaces();
  const agent = new FakeAgent();
  const context = new FakeContext();
  const logger = new MemoryLogger();
  const merger = new FakeMerger();

  repoHost.issues.set(
    keyOf(ISSUE),
    {
      ref: ISSUE,
      title: 'Add the feature',
      body: 'The app needs the feature.',
      labels: ['boardwright:agent'],
      isOpen: true,
      assignees: ['maintainer'],
    },
  );

  repoHost.labelActors.set(
    keyOf(ISSUE),
    {
      login: 'maintainer',
      permission: 'maintain',
    },
  );

  repoHost.labels.set(
    ISSUE.repository,
    new Set(['boardwright:agent']),
  );

  return {
    dependencies: {
      config,
      board,
      repoHost,
      workspaces,
      agent,
      context,
      clock,
      runIds: new SequentialRunIds(),
      logger,
      merger,
    },
    board,
    repoHost,
    workspaces,
    agent,
    context,
    clock,
    logger,
    merger,
  };
}
