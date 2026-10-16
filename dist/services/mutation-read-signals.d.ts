/** Register one active replay loop and release its callback when it stops or restarts. */
export declare function onMutationReadSignal(projectId: string, listener: () => void): () => void;
/** Force the next poll after an HTTP write or a validated cross-instance notification. */
export declare function signalMutationRead(projectId: string): void;
