/** Clear the signing secret for one assertion and restore it even when that assertion fails. */
export async function withEmptySigningSecret<T>(run: () => Promise<T>): Promise<T> {
  const signingSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = "";
  try {
    return await run();
  } finally {
    if (signingSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = signingSecret;
  }
}
