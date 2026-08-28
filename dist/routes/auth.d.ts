declare const router: import("express-serve-static-core").Router;
/**
 * Validate an email address without a backtracking regular expression.
 *
 * The previous check used `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, whose repeated
 * `[^\s@]+` groups force O(n) backtracking attempts on a long string with no
 * `@`, giving polynomial (quadratic) runtime — the ReDoS CodeQL flagged. This
 * helper splits on the single `@` first and then validates each side with
 * anchored single-class patterns (`[^\s]+`), which are linear and cannot
 * backtrack across a missing delimiter. The 254-character bound (RFC 5321)
 * is applied up front so even the linear checks run over a capped length.
 *
 * @param email - The candidate address to validate.
 * @returns `true` when the address has exactly one `@`, non-empty whitespace-free
 *   local and domain parts, and a dotted domain.
 */
export declare function isValidEmail(email: string): boolean;
export { router as authRouter };
