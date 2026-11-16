/** Validate harness scale on import, before callers can spawn any children. */
const scale = Number(process.env.PM_TEST_TIME_SCALE ?? "1");
if (!Number.isFinite(scale) || scale <= 0) throw new Error("PM_TEST_TIME_SCALE must be finite and greater than zero");

/** Scale a harness watchdog to integer milliseconds; never use for product budgets. */
export function testTime(milliseconds: number): number {
  const scaled = Math.ceil(milliseconds * scale);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new Error("Scaled test timeout must be a positive safe integer");
  return scaled;
}
