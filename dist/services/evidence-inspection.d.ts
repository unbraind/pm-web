import type { PmClient } from '@unbrained/pm-cli/sdk';
import { type EvidenceInspectionInput, type EvidenceInspectionPage } from '../evidence-inspection.ts';
/** Authority is supplied by the host after authorization, never accepted from an HTTP body. */
export interface EvidenceInspectionHost {
    client: PmClient;
    workspace: string;
    root: string;
}
/** Inspect a single native item without schema activation, observation writes, git or persistent caches. */
export declare function inspectEvidence(host: EvidenceInspectionHost, raw: EvidenceInspectionInput): Promise<EvidenceInspectionPage>;
