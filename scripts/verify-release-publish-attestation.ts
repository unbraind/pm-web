/**
 * Require --provenance on every npm publish, including indirect invocations.
 *
 * pm-ops owns tokenization, scalar/array resolution, flag semantics and tracked
 * source discovery. The pinned auditor still misses aliases and publishers
 * forwarding unknown function arguments. This consumer guard rejects those
 * unsupported paths until the canonical auditor can prove their behavior.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import {
  auditPublishAttestation as canonicalAudit,
  FOREIGN_PUBLISHERS,
  publishInvocationsIn,
  report,
  trackedPublishSources,
  type PublishAttestationResult,
} from "pm-ops/attestation";
import {
  commandArguments,
  commandCandidates,
  commandName,
  joinContinuations,
  tokenizeCommands,
  type SourceFile,
} from "pm-ops/shell-scan";
import { isMainInvocation } from "./main-invocation.ts";

/** Non-publishing npm verbs; package runner bodies are audited independently. */
const NON_PUBLISH_VERBS = new Set([
  "add", "audit", "ci", "config", "install", "ls", "pack", "pkg", "run", "test", "version", "view",
]);
/** Shell interpreters whose dynamic command strings cannot be statically proved. */
const EVALUATORS = new Set(["eval", "bash", "sh", "dash", "zsh", "ksh"]);

/**
 * Extract independently executed shell bodies without scanning YAML prose.
 *
 * Manifests and workflows are parsed as data, so a displayed alias or dollar
 * expression cannot become executable evidence. Each manifest script and run
 * step is inspected independently. Parse errors propagate to the caller, which
 * records a failure instead of accepting an unreadable source.
 *
 * @param source - Tracked path and source text.
 * @returns Shell scripts whose indirection must be checked.
 */
function shellBodies(source: SourceFile): string[] {
  if (!/(?:^|\/)package\.json$/u.test(source.file)
      && !/^\.github\/workflows\/.*\.ya?ml$/u.test(source.file)) return [source.text];
  const manifest = /(?:^|\/)package\.json$/u.test(source.file);
  const data: unknown = manifest ? JSON.parse(source.text) : parse(source.text);
  const bodies: string[] = [];
  const pending: unknown[] = [data];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value !== null && typeof value === "object") {
      if (visited.has(value)) continue;
      visited.add(value);
    }
    if (Array.isArray(value)) {
      pending.push(...value as unknown[]);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (manifest && key === "scripts" && child !== null && typeof child === "object") {
          for (const body of Object.values(child as Record<string, unknown>)) {
            if (typeof body !== "string") throw new Error("non-string package script");
            bodies.push(body);
          }
        } else if (!manifest && key === "run") {
          if (typeof child !== "string") throw new Error("non-string workflow run body");
          bodies.push(child);
        } else if (!manifest) {
          pending.push(child);
        }
      }
    }
  }
  return bodies;
}

/**
 * Audit resolved publishes and reject indirection the pinned auditor omits.
 *
 * This adds failures, never removes canonical failures or invents attesting
 * evidence. Aliases and quoted executable expansions are unsupported; dynamic
 * evaluator payloads and npm argument forwarding also fail closed. Literal
 * variables and function bodies continue through the canonical shell model.
 * An unresolved argument on a recognized publish may override provenance at
 * runtime and therefore cannot be accepted merely because a literal flag exists.
 *
 * @param sources - Tracked executable sources, with repository-relative paths.
 * @returns Canonical recognition and notes plus any indirection failures.
 */
export function auditPublishAttestation(sources: SourceFile[]): PublishAttestationResult {
  const result = canonicalAudit(sources);
  const failures = [...result.failures];
  for (const source of sources) {
    const reasons = new Set<string>();
    try {
      for (const invocation of publishInvocationsIn(source)) {
        if (commandArguments(invocation.command).some((token) => token.unresolved)) {
          reasons.add("unresolved publish arguments may change provenance");
        }
      }
      for (const body of shellBodies(source)) {
        const isolated = { file: "scripts/indirection-body.sh", text: body };
        const bodyAudit = canonicalAudit([isolated]);
        if (bodyAudit.recognition.kind === "recognized" && bodyAudit.failures.length > 0
            && !result.failures.some((failure) => failure.startsWith(`${source.file}:`))) {
          reasons.add("an independent shell body cannot prove every publish attested");
        }
        for (const invocation of publishInvocationsIn(isolated)) {
          if (commandArguments(invocation.command).some((token) => token.unresolved)) {
            reasons.add("unresolved publish arguments may change provenance");
          }
        }
        const commands = tokenizeCommands(joinContinuations(body));
        const opaqueVariables = new Set<string>();
        for (const command of commands) {
          const assignmentOnly = commandName(command) === undefined;
          for (const token of command) {
            const binding = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su.exec(token.value);
            if (binding === null || token.startsQuoted) {
              if (assignmentOnly) continue;
              break;
            }
            if (tokenizeCommands(binding[2]).some((bound) => {
              const name = commandName(bound);
              return name === "alias" || (name !== undefined && EVALUATORS.has(name));
            })) opaqueVariables.add(binding[1]);
          }
        }
        for (const command of commands) {
          for (const candidate of commandCandidates(command)) {
            const program = commandName(candidate);
            const args = commandArguments(candidate);
            const primary = program === commandName(command);
            const publisher = program === "npm" || (program !== undefined && FOREIGN_PUBLISHERS.has(program));
            if (primary && program?.startsWith("$")) {
              const reference = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(program);
              if (reference === null) {
                reasons.add("compound executable expansion cannot be proved");
              }
              if (reference !== null && opaqueVariables.has(reference[1])) {
                reasons.add("variable-routed alias or evaluator cannot be proved");
              }
              if (args.some((token) => token.unresolved)) {
                reasons.add("variable-routed publisher arguments cannot be proved");
              }
            }
            if (program === "alias") reasons.add("shell aliases are not a provable publish path");
            if (primary && (program?.startsWith("$") || program === "")
                && candidate.some((token) => commandName([token]) === program && token.quoted && token.unresolved)) {
              reasons.add("quoted executable expansion has unproven word boundaries");
            }
            if (primary && program !== undefined && !program.startsWith("$") && !program.includes("\n")
                && candidate.some((token) => commandName([token]) === program && token.unresolved)) {
              reasons.add("partially expanded executable cannot be proved");
            }
            if ((primary && program?.startsWith("$") && /\[[ @*]*\]/u.test(program))
                || (publisher && args.some((token) => token.unresolved && /\[[ @*]*\]/u.test(token.value)))) {
              reasons.add("array expansion in a publisher path cannot be proved");
            }
            if (program !== undefined && EVALUATORS.has(program)
                && args.some((token) => token.unresolved)) {
              reasons.add("dynamic shell evaluator payload cannot be proved");
            }
            if (publisher
                && args.some((token) => token.unresolved)
                && !NON_PUBLISH_VERBS.has(args[0]?.value ?? "")) {
              // Resolved ordinary publishes are checked above. A raw publisher
              // with a literal publish verb has a canonical invocation; one with
              // unknown subcommand/forwarded arguments can disappear entirely.
              if (!args.some((token) => token.value === "publish")) {
                reasons.add("publisher subcommand or function arguments cannot be proved");
              }
            }
          }
        }
      }
    } catch {
      reasons.add("executable source cannot be parsed for indirection");
    }
    for (const reason of reasons) failures.push(`${source.file}: ${reason}; refusing an unresolvable publish-like invocation`);
  }
  return { ...result, failures, notes: failures.length > 0 ? [] : result.notes };
}

/**
 * Apply both checks to every executable source discovered by the canonical gate.
 *
 * @param root - Repository root to verify.
 * @returns Audit result, retaining the canonical non-vacuity check.
 */
export function verify(root: string): PublishAttestationResult {
  return auditPublishAttestation(trackedPublishSources(root).map((file) => ({
    file,
    text: readFileSync(resolve(root, file), "utf8"),
  })));
}

/**
 * Run the gate only when this module is the process entry point.
 *
 * @param argv - Process arguments used to locate the entry point.
 * @param moduleUrl - This module's URL.
 * @param root - Repository root to verify.
 * @returns Whether the verifier ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  report(verify(root), (line) => process.stdout.write(`${line}\n`), (code) => { process.exitCode = code; });
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
