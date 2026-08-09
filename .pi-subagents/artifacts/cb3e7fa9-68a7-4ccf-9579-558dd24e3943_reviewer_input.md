# Task for reviewer

Accuracy audit of JSDoc docstrings vs actual code in two files of the pm-web repo (cwd is the repo root). These docstrings were just added to pass a docstring gate; your job is to verify each one TRUTHFULLY describes its function's actual behavior. Do NOT check style or completeness — only ACCURACY.

Files: public/src/views/graph.ts and public/src/views/items.ts

For every `/** ... */` docstring in these two files, read the function body it documents and check for these specific FALSE-description failure modes (these have caused rejections before):
1. VALIDATION described as TRANSFORMATION: if the body calls trim()/parseInt()/Number()/toLowerCase() only to TEST a value but RETURNS THE ORIGINAL (or a boolean), the docstring must NOT say "returns the trimmed/parsed/lowercased value". It must say what is actually returned.
2. False ORDERING/UNIQUENESS/IMMUTABILITY claims: e.g. claiming Object.fromEntries preserves insertion order (it does NOT for integer-like keys), or that a plain array is deduplicated when it is not. Map preserves insertion order; a Set is unique; Array.push is not.
3. Documented @param or @returns that do not exist in the signature/body.

Also flag any docstring that asserts behavior the code plainly does not do (wrong return type, wrong side effect, invented edge case, claiming a function transforms when it only validates, or vice versa).

Output a concise list: for each PROBLEM found, give `file:line  symbol  —  what the docstring claims vs what the code does, and the one-line fix`. If a docstring is accurate, do not list it. If ALL docstrings in both files are accurate, say so explicitly. Be precise and cite the code.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

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