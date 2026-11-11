/** Translate transport-independent project refusals into the host's typed error and recovery contract. */
export declare function refuseProjectCommand(refusal: {
    code: string;
    remedy: string;
    status: number;
}): never;
