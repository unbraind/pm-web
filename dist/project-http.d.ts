/** Send an authenticated project request with a deadline and no credential-forwarding redirects. */
export declare function requestProjectJson<T>(endpoint: string, token: string, method: string, body?: unknown): Promise<{
    response: Response;
    data: T;
}>;
