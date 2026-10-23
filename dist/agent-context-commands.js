import { createPmCliExpectedError, EXIT_CODE } from '@unbrained/pm-cli/sdk';
import { AgentContextClient, AgentContextError } from './agent-context.js';
/** Dispatch an authenticated remote operation; the local tracker needs no git or database. */
export async function runAgentContextCommand(ctx, action) {
    try {
        if (!process.env.PM_WEB_TOKEN || !ctx.options.url || !ctx.options.project)
            throw new AgentContextError('invalid_input', 'Set PM_WEB_TOKEN and pass --url and --project for an authorized pm-web project.', 400);
        const client = new AgentContextClient(String(ctx.options.url), process.env.PM_WEB_TOKEN);
        const project = String(ctx.options.project);
        if (action === 'list')
            return await client.list(project, ctx.options.offset === undefined ? 0 : Number(ctx.options.offset));
        if (action === 'get')
            return await client.get(project, String(ctx.options.id ?? ''), String(ctx.options.revision ?? ''));
        if (action === 'revoke')
            return await client.revoke(project, String(ctx.options.id ?? ''), String(ctx.options.revision ?? ''));
        let input;
        try {
            input = JSON.parse(String(ctx.options.input ?? ''));
        }
        catch {
            throw new AgentContextError('invalid_input', 'Pass --input with a consented packet JSON object.', 400);
        }
        return await client.publish(project, input, ctx.options.id === undefined ? undefined : { id: String(ctx.options.id), revision: String(ctx.options.revision ?? '') });
    }
    catch (error) {
        const refusal = error instanceof AgentContextError ? error : new AgentContextError('unavailable', 'Check the server URL, authentication and network availability.', 503);
        throw createPmCliExpectedError(`${refusal.code}: ${refusal.remedy}`, { exitCode: refusal.status === 409 ? EXIT_CODE.CONFLICT : refusal.status === 404 ? EXIT_CODE.NOT_FOUND : EXIT_CODE.USAGE, context: { code: refusal.code, nextSteps: [refusal.remedy] } });
    }
}
/** Register bounded native TOON/JSON operations through the core extension output renderer. */
export function registerAgentContextCommands(api) {
    for (const action of ['list', 'get', 'publish', 'revoke']) {
        api.registerCommand({ name: action === 'list' ? 'web agent-context' : `web agent-context ${action}`, description: `${action} explicitly consented agent context snapshots.`, intent: 'Inspect current questions, served receipts and unresolved gaps in an authorized scope.', examples: [`pm web agent-context${action === 'list' ? '' : ` ${action}`} --url https://pm.example.test --project <uuid> --json`],
            flags: ['url', 'project', 'id', 'revision', 'input', 'offset'].map(name => ({ long: `--${name}`, value_name: name, description: name === 'input' ? 'Explicitly consented packet JSON (publish)' : `${name} binding; use the authorized list for packet id and revision` })), run: ctx => runAgentContextCommand(ctx, action) });
    }
}
//# sourceMappingURL=agent-context-commands.js.map