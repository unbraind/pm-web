import { type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
/** Dispatch the same typed operations used by HTTP without requiring a server, database or git. */
export declare function runInboxCommand(ctx: CommandHandlerContext, action: 'list' | 'request' | 'respond'): Promise<unknown>;
/** Register compact host-rendered TOON/JSON commands using the established extension API. */
export declare function registerInboxCommands(api: ExtensionApi): void;
