import { type EvidenceInspectionInput, type EvidenceInspectionPage } from './evidence-inspection.ts';
/** Explicit remote inspection client stores no source snapshots or project defaults. */
export declare class EvidenceInspectionClient {
    private readonly origin;
    private readonly token;
    /** Bind one trusted server origin and explicit caller token without redirect forwarding. */
    constructor(baseUrl: string, token: string);
    /** Inspect the same authorized page the item panel consumes. */
    inspect(project: string, raw: EvidenceInspectionInput): Promise<EvidenceInspectionPage>;
}
