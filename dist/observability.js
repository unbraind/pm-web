import { createHmac, randomBytes, randomUUID } from "node:crypto";
const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const secret = process.env.LOG_HMAC_SECRET || process.env.JWT_SECRET || randomBytes(32).toString("hex");
/** Pseudonymize identifiers with domain separation; never emit the original value. */
export function opaqueHash(domain, value) {
    return createHmac("sha256", secret).update(`${domain}\0${value}`).digest("hex");
}
/** Emit one JSON stdout line, taking only explicitly selected scalar fields. */
export function logEvent(event, fields = {}, level = "info") {
    const configured = process.env.LOG_LEVEL ?? "info";
    const threshold = Object.hasOwn(levels, configured) ? levels[configured] : levels.info;
    if (levels[level] < threshold)
        return;
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}
/** Log safe error diagnostics without serializing arbitrary error messages or properties.
 * Messages can contain SQL values, filenames, URLs or body-parser request data.
 * Retain the error category and stack locations while replacing free-form text.
 */
export function logError(event, error) {
    const name = error instanceof Error && ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "URIError", "AggregateError"].includes(error.name)
        ? error.name : "Error";
    const stack = error instanceof Error ? (error.stack ?? "").split("\n").slice(1)
        .map((line) => {
        const module = /\/(?:src|dist)\/((?:routes\/(?:admin|auth|extensions|github|groups|oidc|pm|projects|sharing)|services\/(?:sse|project-watcher|mutation-event-watcher|pm-runner|realtime-bus)|app|server|db|auth|health|observability))\.(?:ts|js):(\d+):(\d+)/.exec(line);
        if (module)
            return `at ${module[1]}:${module[2]}:${module[3]}`;
        const location = /:(\d+):(\d+)\)?$/.exec(line);
        return location ? `at server:${location[1]}:${location[2]}` : null;
    })
        .filter((line) => line !== null).join("\n") : "";
    logEvent(event, { name, message: "Server operation failed (private details redacted)", stack }, "error");
}
/** Remember a router's literal mount template without reading its expanded base URL. */
export function logRoutePrefix(template) {
    return (_req, res, next) => { res.locals.logRoutePrefix = template; next(); };
}
/** Log every completed or aborted HTTP request; stream durations end at disconnect.
 * Only registered route templates are read. Static and pre-routing failures use
 * fixed labels. Request ids are generated here rather than trusting input headers.
 */
export function requestLogging() {
    return (req, res, next) => {
        const started = performance.now();
        const requestId = randomUUID();
        res.setHeader("X-Request-Id", requestId);
        let logged = false;
        /** Coalesce finish/close so each request has exactly one log line. */
        const complete = () => {
            if (logged)
                return;
            logged = true;
            const route = req.route;
            const suffix = typeof route?.path === "string" ? route.path : "/unmatched";
            if (suffix === "/healthz")
                return;
            const prefix = typeof res.locals.logRoutePrefix === "string" ? res.locals.logRoutePrefix : "";
            const template = suffix.startsWith("/api/") || suffix === "/{*splat}" ? suffix : prefix + suffix;
            const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"].includes(req.method) ? req.method : "OTHER";
            logEvent("request", {
                method, route: template, status: res.writableFinished ? res.statusCode : 499,
                duration_ms: Math.round(performance.now() - started), request_id: requestId,
                user_hash: req.user ? opaqueHash("user", req.user.userId) : null,
            });
        };
        res.once("finish", complete);
        res.once("close", complete);
        next();
    };
}
/** Last-resort Express error response; no error object or request data is serialized. */
export const unhandledErrorLogging = (error, _req, res, _next) => {
    logError("unhandled_error", error);
    if (res.headersSent) {
        res.destroy();
        return;
    }
    const candidate = error;
    const status = typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status < 500 ? candidate.status : 500;
    res.status(status).json({ error: "Request failed" });
};
//# sourceMappingURL=observability.js.map