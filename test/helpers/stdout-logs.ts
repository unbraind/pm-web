import type test from "node:test";

/** Capture exactly what the stdout writer emits; restore through the test context. */
export function captureLogs(t: test.TestContext): string[] {
  const output: string[] = [];
  const original = process.stdout.write;
  t.mock.method(process.stdout, "write", (...args: Parameters<typeof process.stdout.write>) => {
    const chunk = args[0];
    if (typeof chunk === "string" && chunk.startsWith("{")) { output.push(chunk); return true; }
    return Reflect.apply(original, process.stdout, args);
  });
  return output;
}
