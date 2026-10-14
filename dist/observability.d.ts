import type { ErrorRequestHandler, RequestHandler } from "express";
/** Severity threshold accepted by LOG_LEVEL; unknown values fall back to info. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
/** Pseudonymize identifiers with domain separation; never emit the original value. */
export declare function opaqueHash(domain: "user" | "project", value: string): string;
/** Emit one JSON stdout line, taking only explicitly selected scalar fields. */
export declare function logEvent(event: string, fields?: Record<string, string | number | boolean | null>, level?: LogLevel): void;
/** Log safe error diagnostics without serializing arbitrary error messages or properties.
 * Messages can contain SQL values, filenames, URLs or body-parser request data.
 * Retain the error category and stack locations while replacing free-form text.
 */
export declare function logError(event: string, error: unknown): void;
/** Remember a router's literal mount template without reading its expanded base URL. */
export declare function logRoutePrefix(template: string): RequestHandler;
/** Log every completed or aborted HTTP request; stream durations end at disconnect.
 * Only registered route templates are read. Static and pre-routing failures use
 * fixed labels. Request ids are generated here rather than trusting input headers.
 */
export declare function requestLogging(): RequestHandler;
/** Last-resort Express error response; no error object or request data is serialized. */
export declare const unhandledErrorLogging: ErrorRequestHandler;
