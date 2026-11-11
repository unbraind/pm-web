import { refuseProjectCommand } from './project-command-refusal.js';
import { PermissionImpactError, parsePermissionImpact } from './permission-impact.js';
import { PermissionImpactClient } from './permission-impact-client.js';
/** Delegate rendering and output budgets to the host; no local tracker or database is acquired. */
export async function runPermissionImpactCommand(ctx) {
    try {
        const input = parsePermissionImpact({ shareId: ctx.options.share, permission: ctx.options.permission,
            ...(ctx.options.offset === undefined ? {} : { offset: typeof ctx.options.offset === 'string' && /^\d+$/.test(ctx.options.offset) ? Number(ctx.options.offset) : ctx.options.offset }),
            ...(ctx.options.limit === undefined ? {} : { limit: typeof ctx.options.limit === 'string' && /^\d+$/.test(ctx.options.limit) ? Number(ctx.options.limit) : ctx.options.limit }) });
        if (typeof ctx.options.url !== 'string' || typeof ctx.options.project !== 'string' || !ctx.options.project || !process.env.PM_WEB_TOKEN)
            throw new PermissionImpactError('invalid_input', 'Set PM_WEB_TOKEN and pass --url, --project, --share and --permission for an owned project.', 400);
        return await new PermissionImpactClient(ctx.options.url, process.env.PM_WEB_TOKEN).preview(ctx.options.project, input);
    }
    catch (error) {
        const refusal = error instanceof PermissionImpactError ? error : new PermissionImpactError('unavailable', 'Check the explicit server URL, authentication and backend availability.', 503);
        return refuseProjectCommand(refusal);
    }
}
/** Register one read-only command supporting native compact TOON and JSON output. */
export function registerPermissionImpactCommand(api) {
    api.registerCommand({ name: 'web permission-impact', description: 'Preview caller-visible access losses for an explicit project share change.', intent: 'Review packets, pending decisions and backend agent operations before a separately authorized ACL change.',
        examples: ['pm web permission-impact --url https://pm.example.test --project <uuid> --share <uuid> --permission view --json'], read_output: { row_keys: ['losses'] },
        flags: ['url', 'project', 'share', 'permission', 'offset', 'limit'].map(name => ({ long: `--${name}`, value_name: name, description: name === 'permission' ? 'Proposed edit, view or none; never applied' : `${name} binding; limit 1–50, offset from nextOffset` })), run: runPermissionImpactCommand });
}
//# sourceMappingURL=permission-impact-commands.js.map