import type { NextFunction, Request, RequestHandler, Response } from "express";
/**
 * Read a route parameter as a single string.
 *
 * Express types a param as `string | string[]`, because a repeated capture can
 * produce an array. Routes here always want one value, so an array collapses to
 * its first element and a missing param becomes the empty string rather than
 * `undefined`, which keeps every call site free of null handling.
 *
 * @param req Request carrying the matched route parameters.
 * @param name Parameter name to read.
 * @returns The parameter value, or `""` when absent.
 */
export declare function routeParam(req: Pick<Request, "params">, name: string): string;
/**
 * Report whether a value is shaped like a UUID.
 *
 * @param value Candidate identifier, typically straight from the URL.
 * @returns True when the value can be cast to `uuid` by PostgreSQL.
 */
export declare function isUuid(value: string): boolean;
/**
 * Reject malformed UUID path parameters with 400 before they reach SQL.
 *
 * Without this guard a non-UUID path segment travels all the way into a query
 * such as `WHERE id = $1`, where PostgreSQL raises `invalid input syntax for
 * type uuid`. The surrounding `catch` then reports 500 — telling a client that
 * the server failed when in fact the request was malformed, and writing a
 * stack trace to the logs for what is ordinary bad input. Validating the shape
 * first turns that into an accurate 400 and keeps the logs meaningful.
 *
 * Only the listed names are checked, and only when present on the matched
 * route. That matters because not every identifier in this API is a UUID: pm
 * item ids (`itemId`), plan and step refs, and extension keys are opaque
 * strings, so a blanket guard would reject valid requests.
 *
 * Use this form for routers whose parameter arrives from the *mount path* (for
 * example `sharesRouter`, mounted at `/api/projects/:id/shares` with
 * `mergeParams: true`), where router-level middleware does see the merged
 * params. For a router's own route parameters, prefer `router.param(name, …)`,
 * which Express invokes only once the route has matched.
 *
 * @param names Parameter names to validate when present.
 * @returns Middleware that answers 400 on a malformed identifier.
 */
export declare function requireUuidParams(...names: readonly string[]): RequestHandler;
/**
 * Build an Express `router.param` handler that rejects a malformed UUID with 400.
 *
 * The `router.param` hook is the right place for a router's own path
 * parameters: it fires after the route matches and before the handler runs, so
 * a single registration covers every route using that parameter without each
 * handler repeating the check.
 *
 * @param name Parameter name, used in the error message.
 * @returns A `router.param` callback answering 400 on a malformed identifier.
 */
export declare function uuidParamGuard(name: string): (req: Request, res: Response, next: NextFunction, value: string) => void;
