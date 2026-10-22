import { createPmCliExpectedError, EXIT_CODE } from '@unbrained/pm-cli/sdk';
import { DecisionInboxError, decisionInboxNumber, listDecisionInbox, requestDecision, respondToDecision } from './services/decision-inbox.js';
/** Dispatch the same typed operations used by HTTP without requiring a server, database or git. */
export async function runInboxCommand(ctx, action) {
    const actor = { author: String(ctx.options.actor ?? process.env.PM_AUTHOR ?? 'local-user'), permission: 'edit' };
    try {
        if (action === 'list')
            return await listDecisionInbox(ctx.pm_root, { limit: decisionInboxNumber(ctx.options.limit, 20), offset: decisionInboxNumber(ctx.options.offset, 0) });
        let input;
        try {
            input = JSON.parse(String(ctx.options.input ?? ''));
        }
        catch {
            throw new DecisionInboxError('invalid_input', 'Pass --input containing the documented request or response JSON object.', 400);
        }
        if (action === 'request')
            return await requestDecision(ctx.pm_root, actor, input);
        return await respondToDecision(ctx.pm_root, actor, input);
    }
    catch (error) {
        if (!(error instanceof DecisionInboxError))
            throw error;
        throw createPmCliExpectedError(`${error.code}: ${error.remedy}`, { exitCode: error.status === 409 ? EXIT_CODE.CONFLICT : error.status === 404 ? EXIT_CODE.NOT_FOUND : error.status === 503 ? EXIT_CODE.DEPENDENCY_FAILED : EXIT_CODE.USAGE, context: { code: error.code, nextSteps: [error.remedy] } });
    }
}
/** Register compact host-rendered TOON/JSON commands using the established extension API. */
export function registerInboxCommands(api) {
    for (const action of ['list', 'request', 'respond']) {
        api.registerCommand({
            name: action === 'list' ? 'web inbox' : `web inbox ${action}`,
            description: action === 'list' ? 'List pending human-agent decisions with bounded output.' : `${action === 'request' ? 'Request' : 'Respond to'} a decision through audited plan mutations.`,
            intent: 'Collaborate on explicit decisions without granting review or completion.',
            examples: [action === 'list' ? 'pm web inbox --limit 10 --json' : `pm web inbox ${action} --input '<JSON>' --json`],
            flags: action === 'list' ? [
                { long: '--limit', value_name: 'count', description: 'Page size from 1 to 50 (default 20)' },
                { long: '--offset', value_name: 'count', description: 'Offset returned by the previous page' },
            ] : [
                { long: '--input', value_name: 'json', description: 'Typed request or revision-bound response JSON object' },
                { long: '--actor', value_name: 'author', description: 'Local tracker audit author (default PM_AUTHOR)' },
            ],
            run: ctx => runInboxCommand(ctx, action),
        });
    }
}
//# sourceMappingURL=decision-commands.js.map