import { type ReadContext, type SourceSnapshot } from 'pm-evidence';
/** Match pm-evidence's persisted source operand without changing literal filenames. */
export declare function evidenceSourceKey(value: string): string;
/** Apply the same reserved-path policy to linked names and actual descriptor targets. */
export declare function publicEvidenceSource(source: string): boolean;
/** Deterministic filesystem boundaries used by adversarial tests; never populated by request data. */
export interface EvidenceReadBarriers {
    afterDiscovery?: () => Promise<void>;
    afterOpen?: () => Promise<void>;
    beforeRead?: () => Promise<void>;
    afterRead?: () => Promise<void>;
}
/** Supply pm-evidence with a bounded immutable snapshot of an authorized opened object, without schema writes. */
export declare function readApprovedEvidence(source: string, context: ReadContext, barriers?: EvidenceReadBarriers): Promise<SourceSnapshot>;
