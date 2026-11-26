## Description

<!-- What changes and why. If it fixes a defect, say what happened before. -->

## Issue

<!--
The keyword must be one GitHub recognizes: `Closes`, `Fixes` or `Resolves`
(or `closed` / `fixed` / `resolved`). Anything else is a plain mention, and the
issue stays open after the merge without anyone noticing.

Pasting the issue URL does not link it either. Use the number: `Closes #123`.

Check after opening, because the failure is silent:
  gh pr view <N> --json closingIssuesReferences
-->

Closes #

## Verification

<!-- Results, not "tested": "95/95 tests, coverage 99/91/96/99". -->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run check:architecture`
- [ ] `npm run check:unused`
- [ ] `npm run test:coverage`
- [ ] `npm run check:context`
- [ ] `npm run build:action` (commit `dist/` if it changed)

## Risks and caveats

<!--
What the review must look at closely, and what was left out on purpose.
If it touches a stage rule, a guard rail or the merge policy, say what an agent
can now do that it could not before, and what happens when two runners see the
same board item.
-->
