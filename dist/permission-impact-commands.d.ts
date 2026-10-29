import { type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
/** Delegate rendering and output budgets to the host; no local tracker or database is acquired. */
export declare function runPermissionImpactCommand(ctx: CommandHandlerContext): Promise<unknown>;
/** Register one read-only command supporting native compact TOON and JSON output. */
export declare function registerPermissionImpactCommand(api: ExtensionApi): void;
