import { type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
/** Run local inspection through SDK contracts and delegate output budgets and TOON/JSON to the host. */
export declare function runContractExplorerCommand(ctx: CommandHandlerContext): Promise<unknown>;
/** Register a read-only native command; the only input form returns an unexecuted review envelope. */
export declare function registerContractExplorerCommand(api: ExtensionApi): void;
