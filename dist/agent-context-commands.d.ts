import { type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
/** Dispatch an authenticated remote operation; the local tracker needs no git or database. */
export declare function runAgentContextCommand(ctx: CommandHandlerContext, action: 'list' | 'get' | 'publish' | 'revoke'): Promise<unknown>;
/** Register bounded native TOON/JSON operations through the core extension output renderer. */
export declare function registerAgentContextCommands(api: ExtensionApi): void;
