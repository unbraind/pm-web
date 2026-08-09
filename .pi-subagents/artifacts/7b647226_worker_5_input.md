# Task for worker

[Read from: /tmp/pi-worktree-7b647226-5/context.md, /tmp/pi-worktree-7b647226-5/plan.md]

Add accurate JSDoc docstrings to TypeScript files in the pm-web repo (a PUBLIC package — NEVER add tokens, secrets, domains, or hosted data). You are in an isolated git worktree; the repo already has a docstring gate wired up. Your sole job: bring your ASSIGNED FILES to ZERO docstring-gate violations by adding accurate docstrings. Do NOT change logic, signatures, imports, or any non-comment code — purely additive `/** */` documentation.

WORKFLOW:
1. `npm install` (installs pm-ops so the gate runs). Ignore any .gitattributes/package-lock churn it causes; do not commit those.
2. `npm run docstring` exits 1 and prints ~326 violations across public/ (src/ and scripts/ already pass — do not touch them). Filter to YOUR files with an appropriate grep.
3. For each violation `file:line symbol - reason` in YOUR files: read the declaration AND its body, then write an accurate `/** ... */` JSDoc block immediately above it (directly above the `export` keyword for exported decls; above the declaration otherwise).
4. Re-run `npm run docstring` and confirm ZERO violations for your files (other files' violations are NOT yours — leave them).
5. `git add` your exact files then commit (do NOT `git add -A`). Message: "Document public root and component modules for docstring gate". Print `git rev-parse HEAD` and `git diff --stat HEAD~1`.

GATE RULES (lexer-backed, not regex — cannot be tricked):
- Every EXPORTED declaration (function/class/interface/type/const/let/var) needs a JSDoc directly above the `export`.
- Every non-private/non-protected/non-`#` member of an EXPORTED class needs a JSDoc.
- Every NON-exported function whose body is >4 lines needs a JSDoc.
- The JSDoc needs >=4 meaningful words AND >=2 words NOT already in the symbol name. "Gets the name." on `getName` FAILS; "Returns the user's display name from the cached profile." passes.

ACCURACY IS THE CRITICAL PART — false docstrings get rejected. READ THE BODY of every symbol and describe what it ACTUALLY does. FORBIDDEN failure modes (caught before):
- Do NOT describe validation as transformation. If the body calls trim()/parseInt()/Number() only to TEST a value but RETURNS THE ORIGINAL, do NOT write "returns the trimmed/parsed value". Say what it actually returns.
- Do NOT claim ordering/uniqueness/immutability the code does not provide. (Map preserves insertion order; Object.fromEntries does NOT for integer-like keys; a Set is unique; a plain array push is not.)
- Do NOT document params or return values that do not exist.
For each function: real purpose, real @param (only when params are worth naming), real @returns (only when it returns something), real throws/edge cases. Prefer a short TRUE docstring over a long speculative one. For UI render/DOM/event-handler functions, say what they render or do.

QUIRK (do not "fix" it): an exported interface/type alias WITHOUT a trailing semicolon makes the analyzer skip some following declarations in that file. Only document symbols the gate REPORTS for your files; never restructure code.

CONSTRAINTS: no `any`; no dynamic `await import()`; erasable TypeScript only; no wrapper helpers; do not modify logic; keep docstrings valid JSDoc.

REPORT at the end: commit SHA, files changed, number of docstrings added, and the exact `npm run docstring` output line proving your files are at 0.

ASSIGNED FILES (touch ONLY these): public/src/app.ts, public/src/utils.ts, public/src/constants.ts, public/src/theme.ts, public/src/filters.ts, public/src/i18n.ts, public/src/sw.ts, public/src/types.ts, public/src/state.ts, public/src/components/modals.ts, public/src/components/toast.ts

## Acceptance Contract
Acceptance level: checked
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope

Required evidence: changed-files, tests-added, commands-run, residual-risks, no-staged-files

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```