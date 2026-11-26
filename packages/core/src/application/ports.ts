import type { RepositoryPermission } from '../domain/guard-rails.ts';
import type { MergeFacts } from '../domain/merge-policy.ts';
import type {
  IssueComment,
  IssueRef,
  PrevcPhase,
} from '../domain/pipeline.ts';

/** A card on the board whose content is an issue. */
export interface BoardItem {
  readonly itemId: string;
  readonly status: string | null;
  readonly issue: IssueRef;

  /** The item's single-select values by field name; absent when the adapter read none. */
  readonly fields?: Readonly<Record<string, string>>;

  /** The issue's parent, when it is a sub-issue. */
  readonly parent?: IssueRef;
}

/** The board: a GitHub Project (v2) and its Status field. */
export interface BoardPort {
  /** The board's title and the options of its Status field. */
  describe(): Promise<BoardDescription>;

  /** Every item of the board whose content is an issue. */
  listItems(): Promise<BoardItem[]>;

  /** Moves an item to a Status option that already exists on the board. */
  setStatus(itemId: string, status: string): Promise<void>;

  /** Adds an issue to the board, or finds its item when it is already there; resolves the item's id. */
  addIssue(ref: IssueRef): Promise<string>;

  /** Sets a single-select field of an item to an option that already exists on the board. */
  setField(itemId: string, field: string, value: string): Promise<void>;
}

/** What `doctor` checks the config against. */
export interface BoardDescription {
  readonly title: string;

  /** The options of the Status field; `undefined` when the board has no field with the configured name. */
  readonly statusOptions: readonly string[] | undefined;

  /** Every single-select field of the board with its options, by name; absent when the adapter read none. */
  readonly singleSelectFields?: Readonly<Record<string, readonly string[]>>;
}

/** An issue as the pipeline needs it. */
export interface Issue {
  readonly ref: IssueRef;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly isOpen: boolean;

  /** The logins of the people the issue is assigned to. */
  readonly assignees: readonly string[];
}

/** Who added a label, and their permission on the repository. */
export interface LabelActor {
  readonly login: string;
  readonly permission: RepositoryPermission;
}

/** A pull request the pipeline opened or found. */
export interface PullRequest {
  readonly number: number;
  readonly url: string;

  /** The commit at the head of the pull request when it was read. */
  readonly headSha: string;
}

/** A line comment of a review, on the new side of the diff. */
export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

/** How the pipeline merges a pull request that passed the policy. */
export interface MergeRequest {
  readonly repository: string;
  readonly number: number;
  readonly pullRequestId: string;
  readonly headSha: string;
  readonly method: 'squash' | 'merge' | 'rebase';
}

/**
 * Merges pull requests, with its own token: the identity that merges is not the one that opened.
 *
 * @remarks
 * It never bypasses the ruleset: a pull request the ruleset still holds gets native auto-merge, which
 * completes only when the required checks pass.
 */
export interface MergerPort {
  /** `merged` when it merged now, `auto-merge` when GitHub will merge once the ruleset allows. */
  merge(request: MergeRequest): Promise<'merged' | 'auto-merge'>;
}

/** An unresolved review thread, with its latest comment. */
export interface ReviewThread {
  readonly id: string;
  readonly path: string;

  /** `null` when the thread is on a line the latest push no longer has. */
  readonly line: number | null;
  readonly body: string;
}

/** What a pull request asks of its author right now. */
export interface Feedback {
  readonly threads: readonly ReviewThread[];

  /** Names of the checks of the head commit that failed; checks still running are not listed. */
  readonly failingChecks: readonly string[];
}

/** What the review stage posts on a pull request: a review that comments, never one that approves. */
export interface ReviewDraft {
  readonly repository: string;
  readonly number: number;
  readonly headSha: string;
  readonly body: string;
  readonly comments: readonly ReviewComment[];

  /** How the review is submitted: a comment, or, when the stage approves, an approval or a change request. */
  readonly event: 'comment' | 'approve' | 'request-changes';
}

/** What the pipeline asks the repository host to open. */
export interface PullRequestDraft {
  readonly repository: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;

  /** The logins to assign: the issue's, so the pull request reaches the same people. */
  readonly assignees: readonly string[];
}

/** Issues, comments and pull requests on the repository host. */
export interface RepoHostPort {
  getIssue(ref: IssueRef): Promise<Issue>;

  /** The open issues of a repository created at or after `createdAfter`, newest first. */
  listRecentIssues(repository: string, createdAfter: Date): Promise<IssueRef[]>;

  /** The person who most recently added `label` to the issue; `undefined` when unknown. */
  findLabelActor(ref: IssueRef, label: string): Promise<LabelActor | undefined>;

  listComments(ref: IssueRef): Promise<IssueComment[]>;

  addComment(ref: IssueRef, body: string): Promise<void>;

  getDefaultBranch(repository: string): Promise<string>;

  findOpenPullRequest(repository: string, head: string): Promise<PullRequest | undefined>;

  openPullRequest(draft: PullRequestDraft): Promise<PullRequest>;

  hasLabel(repository: string, label: string): Promise<boolean>;

  /** A file on the default branch; `undefined` when it does not exist. */
  readFile(repository: string, path: string): Promise<string | undefined>;

  /** The names in a directory on the default branch; empty when it does not exist. */
  listDirectory(repository: string, path: string): Promise<string[]>;

  /** The unresolved review threads and the failing checks of the head commit of a pull request. */
  getFeedback(repository: string, number: number): Promise<Feedback>;

  /** Marks a review thread of the repository resolved; only the pipeline does this, for threads the agent addressed. */
  resolveThread(repository: string, threadId: string): Promise<void>;

  /** What the merge policy looks at, read fresh from the pull request. */
  getMergeFacts(repository: string, number: number): Promise<MergeFacts>;

  /** Whether the pipeline already reviewed the pull request at this head commit. */
  hasAgentReview(repository: string, number: number, headSha: string): Promise<boolean>;

  /** Posts a review that only comments; it never approves or requests changes. */
  submitReview(review: ReviewDraft): Promise<void>;
}

/** A checkout prepared for one run. */
export interface Workspace {
  readonly repository: string;
  readonly path: string;
  readonly branch: string;
  readonly base: string;

  /** The commit the worktree started at; the run's own commits are the ones after it. */
  readonly startSha: string;
}

/** What a run needs checked out. */
export interface WorkspaceRequest {
  readonly repository: string;
  readonly branch: string;
  readonly base: string;
}

/** Git checkouts, one per run. */
export interface WorkspacePort {
  /** Checks out `branch`, continuing it when it already exists on the remote, else creating it from `base`. */
  prepare(request: WorkspaceRequest): Promise<Workspace>;

  /** Paths changed on the branch relative to `base`, committed or not, using `/` separators. */
  changedPaths(workspace: Workspace): Promise<string[]>;

  /** Whether the run committed anything: commits after `startSha`. */
  hasCommits(workspace: Workspace): Promise<boolean>;

  /** Pushes the branch without force. */
  push(workspace: Workspace): Promise<void>;

  dispose(workspace: Workspace): Promise<void>;
}

/** What a stage asks an agent to do. */
export interface AgentRequest {
  readonly stage: string;

  /** `change` edits and commits; `review` reads and reports a verdict; `plan` reads and reports a plan. */
  readonly task: 'change' | 'review' | 'plan';
  readonly cwd: string;
  readonly prompt: string;
  readonly maxTurns: number;
  readonly timeoutMs: number;
  readonly deniedPaths: readonly string[];
  readonly model: string | undefined;
}

/** A GitHub App's installation on a repository: the permissions it was granted, by name. */
export interface AppInstallation {
  readonly permissions: Readonly<Record<string, string>>;
}

/** The pipeline's GitHub App (ADR 0005), as `doctor` reads it. */
export interface AppInstallationsPort {
  /** The App's installation on the repository; `undefined` when it is not installed there. */
  installationOf(repository: string): Promise<AppInstallation | undefined>;
}

/** How an agent session ended. */
export interface AgentResult {
  /** `blocked` means the agent stopped to ask a person something, as the prompt tells it to. */
  readonly status: 'completed' | 'blocked' | 'failed';
  readonly summary: string;
  readonly pullRequest: {
    readonly title: string;
    readonly body: string;
  } | undefined;

  /** The verdict and line comments of a `review` task. */
  readonly review: {
    readonly verdict: 'approve' | 'changes';
    readonly comments: readonly ReviewComment[];
  } | undefined;

  /** For a `change` task on feedback: the ids of the review threads the agent says it addressed. */
  readonly addressedThreadIds: readonly string[];

  /** The plan of a `plan` task, in Markdown. */
  readonly plan: string | undefined;
}

/** An agent runtime (Claude first). */
export interface AgentProvider {
  run(request: AgentRequest): Promise<AgentResult>;
}

/** Which playbook and skills a stage wants. */
export interface ContextSelector {
  readonly phase: PrevcPhase;
  readonly agent: string;
}

/** A playbook file of the target repository, relative to its root. */
export interface PlaybookReference {
  readonly agentType: string;
  readonly path: string;
}

/** A skill file of the target repository, relative to its root. */
export interface SkillReference {
  readonly slug: string;
  readonly description: string;
  readonly path: string;
}

/** The repository's own guidance for a stage. */
export interface StageContext {
  readonly source: 'dotcontext' | 'plain';
  readonly playbook: PlaybookReference | undefined;
  readonly skills: readonly SkillReference[];

  /** Files the agent reads first (a context index, `AGENTS.md`), relative to the root. */
  readonly instructionFiles: readonly string[];

  /** What was asked for and not found, for `doctor` and the logs. */
  readonly warnings: readonly string[];
}

/** Reads a checked-out repository's guidance for agents. */
export interface ContextProvider {
  load(root: string, selector: ContextSelector): Promise<StageContext>;
}

/** The current time. */
export interface Clock {
  now(): Date;
}

/** New run ids. */
export interface RunIdSource {
  next(): string;
}

/** Structured logs; the fields never carry tokens. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
}
