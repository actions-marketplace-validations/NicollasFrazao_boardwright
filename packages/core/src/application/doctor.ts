import type {
  PipelineConfig,
  StageConfig,
} from './config.ts';
import type {
  AppInstallation,
  AppInstallationsPort,
  BoardPort,
  ContextProvider,
  RepoHostPort,
} from './ports.ts';

/** How one check came out. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** One line of a `doctor` report. */
export interface DoctorCheck {
  readonly subject: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Everything `doctor` checked, in order. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly hasFailures: boolean;
}

/** What `doctor` reads. Nothing here is written to. */
export interface DoctorDependencies {
  readonly config: PipelineConfig;
  readonly board: BoardPort;
  readonly repoHost: RepoHostPort;

  /** A context provider whose `root` is a repository name (`owner/name`), read remotely. */
  readonly context: ContextProvider;

  /** The pipeline's GitHub App, when one is configured (ADR 0005). */
  readonly app?: AppInstallationsPort;
}

/** What the App needs on every repository: it merges and reviews. */
const APP_REQUIRED_PERMISSIONS: Readonly<Record<string, string>> = {
  contents: 'write',
  pull_requests: 'write',
};

/** What the App will need to write the pipeline's comments and to read checks (ADR 0005). */
const APP_RECOMMENDED_PERMISSIONS: Readonly<Record<string, string>> = {
  issues: 'write',
  checks: 'read',
};

const PERMISSION_RANK: Readonly<Record<string, number>> = {
  read: 1,
  write: 2,
};

/**
 * Checks a config against the board and the repositories without changing anything.
 *
 * @remarks
 * A missing Status option is a failure: the pipeline never creates one, so a stage that needs it
 * cannot move a card. A missing label or playbook is a warning: the pipeline still runs, with less.
 */
export async function diagnose(dependencies: DoctorDependencies): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(...await checkBoard(dependencies));

  for (const repository of dependencies.config.repositories) {
    checks.push(...await checkRepository(
      dependencies,
      repository,
    ));

    if (dependencies.app !== undefined) {
      checks.push(await checkApp(
        dependencies.app,
        repository,
      ));
    }
  }

  return {
    checks,
    hasFailures: checks.some((check) => check.status === 'fail'),
  };
}

/**
 * Whether the App is installed on the repository with what it needs: a missing installation or a missing
 * required permission fails, a missing recommended one warns.
 */
async function checkApp(
  app: AppInstallationsPort,
  repository: string,
): Promise<DoctorCheck> {
  const subject = `${repository} GitHub App`;

  try {
    const installation = await app.installationOf(repository);

    if (installation === undefined) {
      return check(
        subject,
        'fail',
        'The App is not installed on this repository; add it to the installation\'s repositories.',
      );
    }

    const required = missingPermissions(
      installation,
      APP_REQUIRED_PERMISSIONS,
    );

    if (required.length > 0) {
      return check(
        subject,
        'fail',
        `The App lacks ${required.join(', ')}; it cannot merge or review.`,
      );
    }

    const recommended = missingPermissions(
      installation,
      APP_RECOMMENDED_PERMISSIONS,
    );

    return recommended.length > 0 ? check(
      subject,
      'warn',
      `The App lacks ${recommended.join(', ')}; add them for the pipeline's comments as the App (ADR 0005).`,
    ) : check(
      subject,
      'ok',
      'Installed with the permissions it needs.',
    );
  } catch (error) {
    return check(
      subject,
      'fail',
      messageOf(error),
    );
  }
}

/** The permissions below the wanted level, as `name: level`. */
function missingPermissions(
  installation: AppInstallation,
  wanted: Readonly<Record<string, string>>,
): string[] {
  return Object.entries(wanted)
    .filter(([
      name,
      level,
    ]) => (PERMISSION_RANK[installation.permissions[name] ?? ''] ?? 0) < (PERMISSION_RANK[level] ?? 0))
    .map(([
      name,
      level,
    ]) => `${name}: ${level}`);
}

async function checkBoard(dependencies: DoctorDependencies): Promise<DoctorCheck[]> {
  const { config } = dependencies;
  const subject = `board ${config.project.owner}#${config.project.number}`;

  try {
    const board = await dependencies.board.describe();

    if (board.statusOptions === undefined) {
      return [check(
        subject,
        'fail',
        `"${board.title}" has no single-select field named "${config.project.statusField}".`,
      )];
    }

    const options = new Set(board.statusOptions);
    const missing = requiredStatuses(config.stages).filter((status) => !options.has(status));

    return [
      check(
        subject,
        'ok',
        `"${board.title}", ${config.project.statusField}: ${board.statusOptions.join(', ')}.`,
      ),
      ...missing.map((status) => check(
        subject,
        'fail',
        `The Status "${status}" is not an option of the board; add it, or change the stage.`,
      )),
      ...checkHygiene(
        config,
        options,
        board.singleSelectFields ?? {},
      ).map((problem) => check(
        subject,
        problem.status,
        problem.detail,
      )),
    ];
  } catch (error) {
    return [check(
      subject,
      'fail',
      messageOf(error),
    )];
  }
}

async function checkRepository(
  dependencies: DoctorDependencies,
  repository: string,
): Promise<DoctorCheck[]> {
  try {
    const defaultBranch = await dependencies.repoHost.getDefaultBranch(repository);
    const label = dependencies.config.trigger.label;

    const hasLabel = await dependencies.repoHost.hasLabel(
      repository,
      label,
    );

    const checks = [
      check(
        repository,
        'ok',
        `Reachable; default branch ${defaultBranch}.`,
      ),
      hasLabel
        ? check(
            repository,
            'ok',
            `The trigger label "${label}" exists.`,
          )
        : check(
            repository,
            'warn',
            `The trigger label "${label}" does not exist; create it to release issues to the pipeline.`,
          ),
    ];

    checks.push(...await checkMergeLabels(
      dependencies,
      repository,
    ));

    for (const stage of dependencies.config.stages.filter(runsAnAgent)) {
      checks.push(...await checkContext(
        dependencies,
        repository,
        stage,
      ));
    }

    return checks;
  } catch (error) {
    return [check(
      repository,
      'fail',
      messageOf(error),
    )];
  }
}

/** The merge stage's opt-in and opt-out labels must exist for people to use them. */
async function checkMergeLabels(
  dependencies: DoctorDependencies,
  repository: string,
): Promise<DoctorCheck[]> {
  const labels = dependencies.config.stages.flatMap((stage) => stage.id === 'merge'
    ? [
        {
          name: stage.require.optInLabel,
          purpose: 'to let a pull request opt in to the agentic merge',
        },
        {
          name: stage.require.optOutLabel,
          purpose: 'to let a person hold a pull request back',
        },
      ]
    : []);

  const checks: DoctorCheck[] = [];

  for (const label of labels) {
    if (
      label.name !== null
      && !await dependencies.repoHost.hasLabel(
        repository,
        label.name,
      )
    ) {
      checks.push(check(
        repository,
        'warn',
        `The merge label "${label.name}" does not exist; create it ${label.purpose}.`,
      ));
    }
  }

  return checks;
}

function runsAnAgent(stage: StageConfig): boolean {
  return stage.id !== 'merge' || stage.mode === 'agent';
}

async function checkContext(
  dependencies: DoctorDependencies,
  repository: string,
  stage: StageConfig,
): Promise<DoctorCheck[]> {
  const subject = `${repository} ${stage.id}`;

  const agents = new Set([
    stage.context.agent,
    ...Object.values(stage.context.agentByLabel),
  ]);

  const checks: DoctorCheck[] = [];

  for (const agent of agents) {
    const context = await dependencies.context.load(
      repository,
      {
        phase: stage.context.phase,
        agent,
      },
    );

    checks.push(...context.warnings.map((warning) => check(
      subject,
      'warn',
      warning,
    )));

    if (context.playbook !== undefined) {
      checks.push(check(
        subject,
        'ok',
        `${context.source}: playbook ${context.playbook.path}, ${context.skills.length} skills for phase ${stage.context.phase}.`,
      ));
    } else if (context.instructionFiles.length > 0) {
      checks.push(check(
        subject,
        'ok',
        `${context.source}: the agent reads ${context.instructionFiles.join(', ')}.`,
      ));
    }
  }

  return checks;
}

function requiredStatuses(stages: readonly StageConfig[]): string[] {
  const statuses = stages.flatMap((stage) => statusesOf(stage));

  return [...new Set(statuses)];
}

/** The Status options a stage reads or moves cards to. */
function statusesOf(stage: StageConfig): string[] {
  switch (stage.id) {
    case 'implement':
      return [
        stage.when.status,
        stage.claim.status,
        stage.done.status,
        stage.blocked.status,
      ];
    case 'refine':
      return [
        stage.when.status,
        stage.done.status,
        stage.blocked.status,
      ];
    case 'review':
    case 'address-feedback':
    case 'merge':
      return [stage.when.status];
  }
}

/**
 * What board hygiene needs of the board: the Status a parent moves to (without it, every move fails),
 * the statuses it compares with, and the fields it infers (without them, it skips that field).
 */
function checkHygiene(
  config: PipelineConfig,
  statuses: ReadonlySet<string>,
  fields: Readonly<Record<string, readonly string[]>>,
): Omit<DoctorCheck, 'subject'>[] {
  const problems: Omit<DoctorCheck, 'subject'>[] = [];
  const hygiene = config.board;

  if (hygiene.followSubIssues) {
    if (!statuses.has(hygiene.parents.status)) {
      problems.push({
        status: 'fail',
        detail: `board.parents.status "${hygiene.parents.status}" is not a Status option of the board.`,
      });
    }

    for (const status of [
      ...hygiene.parents.notStarted,
      ...hygiene.parents.started,
    ].filter((name) => !statuses.has(name))) {
      problems.push({
        status: 'warn',
        detail: `board.parents lists "${status}", which is not a Status option of the board; no item can match it.`,
      });
    }
  }

  for (const field of hygiene.inferFields.filter((name) => !(name in fields))) {
    problems.push({
      status: 'warn',
      detail: `board.inferFields names "${field}", which is not a single-select field of the board; it is skipped.`,
    });
  }

  return problems;
}

function check(
  subject: string,
  status: CheckStatus,
  detail: string,
): DoctorCheck {
  return {
    subject,
    status,
    detail,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
