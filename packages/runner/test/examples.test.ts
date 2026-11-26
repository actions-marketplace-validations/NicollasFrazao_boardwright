import {
  readdir,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  describe,
  expect,
  it,
} from 'vitest';
import { readConfigText } from '../src/config-file.ts';

const EXAMPLES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'examples',
);

const files = (await readdir(EXAMPLES)).filter((name) => name.endsWith('.config.yml'));

describe('the example configs', () => {
  it('are the three the README links', () => {
    expect(files.toSorted((
      left,
      right,
    ) => left.localeCompare(right))).toEqual([
      'agentic-merge.config.yml',
      'full-pipeline.config.yml',
      'minimal.config.yml',
    ]);
  });

  it.each(files)('%s is a valid config', async (name) => {
    const path = join(
      EXAMPLES,
      name,
    );

    expect(readConfigText(
      path,
      await readFile(
        path,
        'utf8',
      ),
    ).stages.length).toBeGreaterThan(0);
  });

  it('agentic-merge.config.yml lets the review stage approve', async () => {
    const path = join(
      EXAMPLES,
      'agentic-merge.config.yml',
    );

    const review = readConfigText(
      path,
      await readFile(
        path,
        'utf8',
      ),
    ).stages.find((stage) => stage.id === 'review');

    expect(review).toMatchObject({ approve: true });
  });
});
