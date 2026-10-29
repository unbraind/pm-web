import { z } from 'zod';
import { citationSchema, criterionFactSchema } from 'pm-evidence';
/** Stable refusals shared by inspection transports; operands never enter diagnostics. */
export class EvidenceInspectionError extends Error {
    /** Machine discriminant independent of transport status and message wording. */
    code;
    /** Public recovery action containing no source bytes or local storage identities. */
    remedy;
    /** HTTP status retained by authenticated SDK consumers. */
    status;
    /** Construct an actionable public-safe refusal. */
    constructor(code, remedy, status = 400) {
        super(code.replaceAll('_', ' '));
        this.name = 'EvidenceInspectionError';
        this.code = code;
        this.remedy = remedy;
        this.status = status;
    }
}
const count = z.number().int().min(0).max(1_000_000);
const itemId = z.string().min(1).max(160).regex(/^[\p{L}\p{N}_.:-]+$/u);
/** The sole strict request schema for SDK, HTTP and CLI inspection. */
export const evidenceInspectionInputSchema = z.strictObject({ item: itemId, offset: count.default(0), limit: z.number().int().min(1).max(20).default(10), budget: z.number().int().min(400).max(16000).default(2400) });
const fragment = z.strictObject({ text: z.string().max(512).nullable(), omittedCharacters: z.number().int().min(0).max(16_777_216), reason: z.enum(['not-retained', 'unavailable', 'not-allowed']).nullable() });
/** Producer-derived citation and criterion schemas keep the panel aligned with pm-evidence. */
export const evidenceInspectionRowSchema = z.strictObject({
    citation: z.string().min(1).max(160), source: z.string().max(4096).nullable(), selector: citationSchema.shape.descriptor.shape.selector.nullable(),
    resolution: z.enum(['resolved', 'missing', 'inaccessible', 'ambiguous', 'unsupported']), freshness: z.enum(['current', 'changed', 'unknown']),
    cited: fragment, current: fragment, bindings: z.array(criterionFactSchema).max(64),
    code: z.string().max(40).nullable(), remedy: z.string().max(500).nullable(),
});
/** Validate every emitted count and bounded collection before an ok response. */
export const evidenceInspectionPageSchema = z.strictObject({
    protocol: z.literal('pm-web-evidence/v1'), item: itemId, truthAssessed: z.literal(false), mutation: z.literal('unsupported'),
    criterionGaps: z.array(criterionFactSchema).max(20).default([]), omittedCriterionGaps: count,
    rows: z.array(evidenceInspectionRowSchema).max(20).default([]), total: count, offset: count, nextOffset: count.nullable().default(null), omitted: count,
    estimatedTokens: count, sourceReads: count, remedy: z.string().max(500),
}).superRefine((page, ctx) => {
    const end = page.offset + page.rows.length, next = end < page.total ? end : null;
    if (page.rows.length > page.total || page.omitted !== page.total - page.rows.length || page.nextOffset !== next || (next !== null && page.rows.length === 0))
        ctx.addIssue({ code: 'custom', message: 'Invalid pagination receipt' });
});
/** Refuse invalid requests at the boundary before acquiring a tracker or making requests. */
export function parseEvidenceInspection(raw) {
    const result = evidenceInspectionInputSchema.safeParse(raw);
    if (!result.success)
        throw new EvidenceInspectionError('invalid_input', 'Supply item, offset 0–1000000, limit 1–20 and budget 400–16000; no source, root or mutation fields are accepted.');
    return result.data;
}
/** Validate remote and locally produced pages through exactly the same contract. */
export function parseEvidenceInspectionPage(raw) {
    const result = evidenceInspectionPageSchema.safeParse(raw);
    if (!result.success)
        throw new EvidenceInspectionError('unavailable', 'Refresh after the backend returns a valid evidence inspection response.', 503);
    return result.data;
}
//# sourceMappingURL=evidence-inspection.js.map