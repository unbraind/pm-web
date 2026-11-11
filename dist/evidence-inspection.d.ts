import { z } from 'zod';
/** Stable refusals shared by inspection transports; operands never enter diagnostics. */
export declare class EvidenceInspectionError extends Error {
    /** Machine discriminant independent of transport status and message wording. */
    readonly code: 'invalid_input' | 'not_found' | 'unsupported' | 'unavailable' | 'conflict' | 'budget';
    /** Public recovery action containing no source bytes or local storage identities. */
    readonly remedy: string;
    /** HTTP status retained by authenticated SDK consumers. */
    readonly status: number;
    /** Construct an actionable public-safe refusal. */
    constructor(code: EvidenceInspectionError['code'], remedy: string, status?: number);
}
/** The sole strict request schema for SDK, HTTP and CLI inspection. */
export declare const evidenceInspectionInputSchema: z.ZodObject<{
    item: z.ZodString;
    offset: z.ZodDefault<z.ZodNumber>;
    limit: z.ZodDefault<z.ZodNumber>;
    budget: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
/** Explicit item and bounded pagination, with no caller-selected root or source. */
export type EvidenceInspectionInput = z.input<typeof evidenceInspectionInputSchema>;
/** Producer-derived citation and criterion schemas keep the panel aligned with pm-evidence. */
export declare const evidenceInspectionRowSchema: z.ZodObject<{
    citation: z.ZodString;
    source: z.ZodNullable<z.ZodString>;
    selector: z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"lines">;
        start: z.ZodNumber;
        end: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"heading">;
        heading: z.ZodString;
        paragraph: z.ZodNumber;
    }, z.core.$strict>, z.ZodObject<{
        kind: z.ZodLiteral<"pointer">;
        pointer: z.ZodString;
    }, z.core.$strict>], "kind">>;
    resolution: z.ZodEnum<{
        ambiguous: "ambiguous";
        inaccessible: "inaccessible";
        missing: "missing";
        resolved: "resolved";
        unsupported: "unsupported";
    }>;
    freshness: z.ZodEnum<{
        changed: "changed";
        current: "current";
        unknown: "unknown";
    }>;
    cited: z.ZodObject<{
        text: z.ZodNullable<z.ZodString>;
        omittedCharacters: z.ZodNumber;
        reason: z.ZodNullable<z.ZodEnum<{
            "not-allowed": "not-allowed";
            "not-retained": "not-retained";
            unavailable: "unavailable";
        }>>;
    }, z.core.$strict>;
    current: z.ZodObject<{
        text: z.ZodNullable<z.ZodString>;
        omittedCharacters: z.ZodNumber;
        reason: z.ZodNullable<z.ZodEnum<{
            "not-allowed": "not-allowed";
            "not-retained": "not-retained";
            unavailable: "unavailable";
        }>>;
    }, z.core.$strict>;
    bindings: z.ZodArray<z.ZodObject<{
        item: z.ZodString;
        criterion: z.ZodString;
        revision: z.ZodNullable<z.ZodString>;
        boundRevision: z.ZodNullable<z.ZodString>;
        citation: z.ZodNullable<z.ZodString>;
        support: z.ZodEnum<{
            "ambiguous-criterion": "ambiguous-criterion";
            "criterion-changed": "criterion-changed";
            "current-source": "current-source";
            "lost-source": "lost-source";
            unbound: "unbound";
            unknown: "unknown";
        }>;
        resolution: z.ZodNullable<z.ZodEnum<{
            ambiguous: "ambiguous";
            inaccessible: "inaccessible";
            missing: "missing";
            resolved: "resolved";
            unsupported: "unsupported";
        }>>;
        freshness: z.ZodNullable<z.ZodEnum<{
            changed: "changed";
            current: "current";
            unknown: "unknown";
        }>>;
        truthAssessed: z.ZodLiteral<false>;
        code: z.ZodOptional<z.ZodEnum<{
            ambiguous: "ambiguous";
            boundary: "boundary";
            budget: "budget";
            canceled: "canceled";
            conflict: "conflict";
            inaccessible: "inaccessible";
            integrity: "integrity";
            invalid: "invalid";
            missing: "missing";
            race: "race";
            schema: "schema";
            sdk: "sdk";
            size: "size";
            timeout: "timeout";
            unsupported: "unsupported";
        }>>;
        remedy: z.ZodOptional<z.ZodString>;
        citationIndex: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
    code: z.ZodNullable<z.ZodString>;
    remedy: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
/** One observational row carries fragments, ambiguity and exact criterion generations. */
export type EvidenceInspectionRow = z.infer<typeof evidenceInspectionRowSchema>;
/** Validate every emitted count and bounded collection before an ok response. */
export declare const evidenceInspectionPageSchema: z.ZodObject<{
    protocol: z.ZodLiteral<"pm-web-evidence/v1">;
    item: z.ZodString;
    truthAssessed: z.ZodLiteral<false>;
    mutation: z.ZodLiteral<"unsupported">;
    criterionGaps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        item: z.ZodString;
        criterion: z.ZodString;
        revision: z.ZodNullable<z.ZodString>;
        boundRevision: z.ZodNullable<z.ZodString>;
        citation: z.ZodNullable<z.ZodString>;
        support: z.ZodEnum<{
            "ambiguous-criterion": "ambiguous-criterion";
            "criterion-changed": "criterion-changed";
            "current-source": "current-source";
            "lost-source": "lost-source";
            unbound: "unbound";
            unknown: "unknown";
        }>;
        resolution: z.ZodNullable<z.ZodEnum<{
            ambiguous: "ambiguous";
            inaccessible: "inaccessible";
            missing: "missing";
            resolved: "resolved";
            unsupported: "unsupported";
        }>>;
        freshness: z.ZodNullable<z.ZodEnum<{
            changed: "changed";
            current: "current";
            unknown: "unknown";
        }>>;
        truthAssessed: z.ZodLiteral<false>;
        code: z.ZodOptional<z.ZodEnum<{
            ambiguous: "ambiguous";
            boundary: "boundary";
            budget: "budget";
            canceled: "canceled";
            conflict: "conflict";
            inaccessible: "inaccessible";
            integrity: "integrity";
            invalid: "invalid";
            missing: "missing";
            race: "race";
            schema: "schema";
            sdk: "sdk";
            size: "size";
            timeout: "timeout";
            unsupported: "unsupported";
        }>>;
        remedy: z.ZodOptional<z.ZodString>;
        citationIndex: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>>;
    omittedCriterionGaps: z.ZodNumber;
    rows: z.ZodDefault<z.ZodArray<z.ZodObject<{
        citation: z.ZodString;
        source: z.ZodNullable<z.ZodString>;
        selector: z.ZodNullable<z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"lines">;
            start: z.ZodNumber;
            end: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"heading">;
            heading: z.ZodString;
            paragraph: z.ZodNumber;
        }, z.core.$strict>, z.ZodObject<{
            kind: z.ZodLiteral<"pointer">;
            pointer: z.ZodString;
        }, z.core.$strict>], "kind">>;
        resolution: z.ZodEnum<{
            ambiguous: "ambiguous";
            inaccessible: "inaccessible";
            missing: "missing";
            resolved: "resolved";
            unsupported: "unsupported";
        }>;
        freshness: z.ZodEnum<{
            changed: "changed";
            current: "current";
            unknown: "unknown";
        }>;
        cited: z.ZodObject<{
            text: z.ZodNullable<z.ZodString>;
            omittedCharacters: z.ZodNumber;
            reason: z.ZodNullable<z.ZodEnum<{
                "not-allowed": "not-allowed";
                "not-retained": "not-retained";
                unavailable: "unavailable";
            }>>;
        }, z.core.$strict>;
        current: z.ZodObject<{
            text: z.ZodNullable<z.ZodString>;
            omittedCharacters: z.ZodNumber;
            reason: z.ZodNullable<z.ZodEnum<{
                "not-allowed": "not-allowed";
                "not-retained": "not-retained";
                unavailable: "unavailable";
            }>>;
        }, z.core.$strict>;
        bindings: z.ZodArray<z.ZodObject<{
            item: z.ZodString;
            criterion: z.ZodString;
            revision: z.ZodNullable<z.ZodString>;
            boundRevision: z.ZodNullable<z.ZodString>;
            citation: z.ZodNullable<z.ZodString>;
            support: z.ZodEnum<{
                "ambiguous-criterion": "ambiguous-criterion";
                "criterion-changed": "criterion-changed";
                "current-source": "current-source";
                "lost-source": "lost-source";
                unbound: "unbound";
                unknown: "unknown";
            }>;
            resolution: z.ZodNullable<z.ZodEnum<{
                ambiguous: "ambiguous";
                inaccessible: "inaccessible";
                missing: "missing";
                resolved: "resolved";
                unsupported: "unsupported";
            }>>;
            freshness: z.ZodNullable<z.ZodEnum<{
                changed: "changed";
                current: "current";
                unknown: "unknown";
            }>>;
            truthAssessed: z.ZodLiteral<false>;
            code: z.ZodOptional<z.ZodEnum<{
                ambiguous: "ambiguous";
                boundary: "boundary";
                budget: "budget";
                canceled: "canceled";
                conflict: "conflict";
                inaccessible: "inaccessible";
                integrity: "integrity";
                invalid: "invalid";
                missing: "missing";
                race: "race";
                schema: "schema";
                sdk: "sdk";
                size: "size";
                timeout: "timeout";
                unsupported: "unsupported";
            }>>;
            remedy: z.ZodOptional<z.ZodString>;
            citationIndex: z.ZodOptional<z.ZodNumber>;
        }, z.core.$strict>>;
        code: z.ZodNullable<z.ZodString>;
        remedy: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>>>;
    total: z.ZodNumber;
    offset: z.ZodNumber;
    nextOffset: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
    omitted: z.ZodNumber;
    estimatedTokens: z.ZodNumber;
    sourceReads: z.ZodNumber;
    remedy: z.ZodString;
}, z.core.$strict>;
/** Identical UI and machine response; freshness is independent of criterion truth. */
export type EvidenceInspectionPage = z.infer<typeof evidenceInspectionPageSchema>;
/** Refuse invalid requests at the boundary before acquiring a tracker or making requests. */
export declare function parseEvidenceInspection(raw: unknown): z.output<typeof evidenceInspectionInputSchema>;
/** Validate remote and locally produced pages through exactly the same contract. */
export declare function parseEvidenceInspectionPage(raw: unknown): EvidenceInspectionPage;
