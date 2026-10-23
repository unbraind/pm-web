import { createPmCliExpectedError, EXIT_CODE, type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
import { ContractExplorerError, contractPageNumber, directoryContractAdapter, exploreContracts, reviewContract } from './contract-explorer.ts';

/** Run local inspection through SDK contracts and delegate output budgets and TOON/JSON to the host. */
export async function runContractExplorerCommand(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const adapter = directoryContractAdapter({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root });
    const action = ctx.options.action === undefined ? undefined : String(ctx.options.action);
    if (ctx.options.input !== undefined) {
      let input: unknown;
      try { input = JSON.parse(String(ctx.options.input)); } catch { throw new ContractExplorerError('invalid_input', 'Pass --input as a JSON object and select --action.', 400); }
      if (!action) throw new ContractExplorerError('invalid_input', 'Select --action from the operation list before reviewing inputs.', 400);
      return await reviewContract(adapter, action, input, 'edit');
    }
    return await exploreContracts(adapter, { action, offset: contractPageNumber(ctx.options.offset), limit: contractPageNumber(ctx.options.limit) });
  } catch (error) {
    const refusal = error instanceof ContractExplorerError ? error : new ContractExplorerError('unavailable', 'Check tracker initialization and provider configuration, then retry.', 503);
    throw createPmCliExpectedError(`${refusal.code}: ${refusal.remedy}`, { exitCode: refusal.code === 'invalid_input' ? EXIT_CODE.USAGE : EXIT_CODE.DEPENDENCY_FAILED, context: { code: refusal.code, nextSteps: [refusal.remedy] } });
  }
}

/** Register a read-only native command; the only input form returns an unexecuted review envelope. */
export function registerContractExplorerCommand(api: ExtensionApi): void {
  api.registerCommand({ name: 'web contracts', description: 'Inspect this project backend and review operation inputs without executing them.', intent: 'Discover provider availability, SDK schemas and actionable refusals.', examples: ['pm web contracts --limit 20 --json', 'pm web contracts --action delete --input \'{"id":"demo-1"}\' --json'],
    flags: [
      { long: '--action', value_name: 'action', description: 'Exact advertised action; includes its SDK input schema' },
      { long: '--offset', value_name: 'offset', description: 'Nonnegative nextOffset from a previous page' },
      { long: '--limit', value_name: 'limit', description: 'Operations per page, 1–50 (default 20)' },
      { long: '--input', value_name: 'json', description: 'JSON object to review; never executes or validates the operation' },
    ], run: runContractExplorerCommand });
}
