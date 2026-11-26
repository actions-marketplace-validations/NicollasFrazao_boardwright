import { fileURLToPath } from 'node:url';
import {
  buildImplementPrompt,
  DEFAULT_DENIED_PATHS,
} from '@boardwright/core';
import {
  describe,
  expect,
  it,
} from 'vitest';
import { RepositoryContextProvider } from '../src/index.ts';

const root = fileURLToPath(new URL(
  'fixtures/atena',
  import.meta.url,
));

describe('the implement prompt built from a real base', () => {
  it('names the bug-fixer playbook and only the execute-phase skills of the repository', async () => {
    const context = await new RepositoryContextProvider().load(
      root,
      {
        phase: 'E',
        agent: 'bug-fixer',
      },
    );

    const prompt = buildImplementPrompt({
      issue: {
        ref: {
          repository: 'NicollasFrazao/atena',
          number: 12,
        },
        title: 'Fix the incident filter',
        body: 'The filter drops resolved incidents.',
        labels: [
          'boardwright:agent',
          'bug',
        ],
        isOpen: true,
        assignees: [],
      },
      workspace: {
        repository: 'NicollasFrazao/atena',
        path: root,
        branch: 'agent/issue-12',
        base: 'master',
        startSha: 'start00',
      },
      context,
      deniedPaths: DEFAULT_DENIED_PATHS,
      today: '2026-11-26',
    });

    expect(prompt).toMatchSnapshot();
    expect(prompt).not.toContain('api-design');
  });
});
