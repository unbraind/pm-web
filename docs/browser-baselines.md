# Browser evidence build trees

Browser fixture compilation must have the full dependency tree. Frontend type
imports can resolve outside `public/`, including `dist/` declarations and their
transitive imports. Copying a declaration for one view does not cover that contract.

`scripts/browser-build-tree.ts` stages complete inputs for isolated builds:

- `archiveBrowserTree` extracts the whole selected Git commit, including its
  declarations. It links the installed dependencies, without borrowing declarations
  from the current working tree.
- `copyBrowserTree` copies current sources and generated output for behavioral
  reverts, excluding repository metadata and installed dependencies, then links
  the installed dependencies. Use an external scratch destination.

The decision-inbox screenshot script archives the selected ref, compiles all three
frontend TypeScript projects, and bundles the browser brand module. Its before
screen shows the Plan view; its after screen shows the decision inbox. CI selects
`github.sha` for pushes and pull requests so the checked-out tree is compiled in
both cases. Local runs default to `HEAD`; `INBOX_BASE_REF` selects an explicit
historical ref when needed.

The four brand revert builders use complete working copies before restoring one
reviewed behavior. The brand screenshot runner serves already built assets. The
graph-scale runner also copies built assets and intentionally transforms only the
historical graph modules for its before comparison; it does not compile a partial
source tree. Agent-context and contract-explorer browser acceptance use the full
application build. All three CI browser checks and their artifact uploads remain
required on Node 26 for push and pull-request runs.

Run `node --test test/browser-build-tree.test.ts` for actual TypeScript compilation
of an archived tree, same-ref transitive declarations, a plain working copy and
the checked-out application's browser entrypoints, plus workflow/caller wiring.
Full npm and Bun release gates and the three browser checks run in PR CI.

## Without git

Working-tree copying works from a plain directory without a Git executable; its
regression initializes a real non-git tracker. Committed baseline extraction needs
a Git repository and reports that prerequisite directly. Browser runtime and
ordinary tracker operations do not require Git.
