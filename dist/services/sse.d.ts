import type { Response } from "express";
export interface SSEClient {
    id: string;
    projectId: string;
    userId: string;
    displayName: string;
    currentView: string;
    res: Response;
    connectedAt: Date;
}
export interface PresenceUser {
    userId: string;
    displayName: string;
    currentView: string;
    connectedAt: string;
}
export declare function configureProjectEventPublisher(publisher: ((projectId: string, event: SSEEvent) => Promise<void>) | null): void;
export declare function addSSEClient(client: SSEClient): () => void;
export declare function broadcastProjectEvent(projectId: string, event: SSEEvent): void;
export declare function deliverProjectEvent(projectId: string, event: SSEEvent): void;
export declare function broadcastPresence(projectId: string): void;
export declare function updateClientView(clientId: string, userId: string, projectId: string, currentView: string): boolean;
export declare function getProjectPresence(projectId: string): PresenceUser[];
export declare function setupSSEHeaders(res: Response): void;
export declare function getSSEClientCount(): number;
export declare function cleanupStaleClients(): void;
export interface SSEEvent {
    type: string;
    data: unknown;
}
