import { refuseProjectCommand } from './project-command-refusal.ts';
import { type CommandHandlerContext, type ExtensionApi } from '@unbrained/pm-cli/sdk';
import { EvidenceInspectionClient } from './evidence-inspection-client.ts';
import { EvidenceInspectionError, parseEvidenceInspection } from './evidence-inspection.ts';

/** Delegate JSON/TOON rendering and outer output budgets to the host, without a local tracker read. */
export async function runEvidenceInspectionCommand(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const raw: Record<string, unknown> = { item: ctx.options.item };
    for (const name of ['offset', 'limit', 'budget']) if (ctx.options[name] !== undefined) raw[name] = typeof ctx.options[name] === 'string' && /^\d+$/.test(ctx.options[name]) ? Number(ctx.options[name]) : ctx.options[name];
    const input = parseEvidenceInspection(raw);
    if (typeof ctx.options.url !== 'string' || typeof ctx.options.project !== 'string' || !process.env.PM_WEB_TOKEN) throw new EvidenceInspectionError('invalid_input', 'Set PM_WEB_TOKEN and pass --url, --project and --item for an authorized project.');
    return await new EvidenceInspectionClient(ctx.options.url, process.env.PM_WEB_TOKEN).inspect(ctx.options.project, input);
  } catch (error) {
    const refusal = error instanceof EvidenceInspectionError ? error : new EvidenceInspectionError('unavailable', 'Check the explicit server and evidence backend.', 503);
    return refuseProjectCommand(refusal);
  }
}
/** Register the observational agent command with bounded compact rows. */
export function registerEvidenceInspectionCommand(api: ExtensionApi): void {
  api.registerCommand({ name: 'web evidence', description: 'Inspect authorized citation freshness, fragments and criterion bindings.', intent: 'Read pm-evidence facts without schema writes or completion judgments.', examples: ['pm web evidence --url https://pm.example.test --project <uuid> --item task-id --json'], read_output: { row_keys: ['rows'] }, flags: ['url', 'project', 'item', 'offset', 'limit', 'budget'].map(name => ({ long: `--${name}`, value_name: name, description: `${name}: explicit identity or bounded inspection page; see README` })), run: runEvidenceInspectionCommand });
}
