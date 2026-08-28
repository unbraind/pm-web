declare const router: import("express-serve-static-core").Router;
/**
 * Build the GitHub issues-list URL for a linked repo from untrusted query
 * parameters, without interpolating any of them into the URL string.
 *
 * `owner` and `repo` come from the database (they were already validated
 * against the user's token when linked), but `state`, `per_page` and `page`
 * come straight from the request query, so interpolating them raw — as the
 * previous template literal did — let a caller inject extra query components
 * or path segments into the `api.github.com` request (the SSRF CodeQL
 * flagged). This constructs the URL with `URL`/`URLSearchParams`, which encode
 * every value, whitelists `state`, and clamps `per_page`/`page` to safe integer
 * ranges, so the request can only ever target the one issues endpoint.
 *
 * @param owner - The linked repository owner (from the database).
 * @param repo - The linked repository name (from the database).
 * @param query - The incoming request's query object.
 * @returns The canonical `https://api.github.com/repos/.../issues?...` URL.
 */
export declare function buildGitHubIssuesUrl(owner: string, repo: string, query: Record<string, unknown> | undefined): string;
export { router as githubRouter };
