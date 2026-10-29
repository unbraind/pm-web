import { createPmCliExpectedError, EXIT_CODE } from '@unbrained/pm-cli/sdk';

/** Translate transport-independent project refusals into the host's typed error and recovery contract. */
export function refuseProjectCommand(refusal: { code: string; remedy: string; status: number }): never {
  const exitCode = refusal.status === 404 ? EXIT_CODE.NOT_FOUND : refusal.status === 503 ? EXIT_CODE.DEPENDENCY_FAILED : EXIT_CODE.USAGE;
  throw createPmCliExpectedError(`${refusal.code}: ${refusal.remedy}`, { exitCode, context: { code: refusal.code, nextSteps: [refusal.remedy] } });
}
