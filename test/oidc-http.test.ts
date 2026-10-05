import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureSchema, uniqueEmail, uniqueSlug } from "./helpers/pg-harness.ts";
import { pool } from "../src/db.ts";
import { OIDC_STATE_COOKIE } from "../src/oidc.ts";

/** Start the real app in a process that trusts only the disposable provider's extra CA. */
async function oidcApp(t: test.TestContext, issuer: string, certificate: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", NODE_EXTRA_CA_CERTS: certificate,
    OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "http-test-client", OIDC_CLIENT_SECRET: "synthetic-client-secret",
    OIDC_COOKIE_SECRET: "synthetic-cookie-secret-at-least-thirty-two-bytes", OIDC_REDIRECT_URI: "http://127.0.0.1/api/auth/oidc/callback",
  };
  delete env.NODE_TEST_CONTEXT;
  const source = `
    import http from 'node:http';
    import {createApp} from ${JSON.stringify(new URL("../src/app.ts", import.meta.url).href)};
    import {pool} from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
    const server = http.createServer(createApp());
    server.listen(0, '127.0.0.1', () => {
      process.env.OIDC_REDIRECT_URI = 'http://127.0.0.1:' + server.address().port + '/api/auth/oidc/callback';
      process.send(server.address().port);
    });
    process.on('message', async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await pool.end();
      process.disconnect();
    });
  `;
  const child: ChildProcess = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.send("stop");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timeout);
    }
  });
  const result = await Promise.race([
    once(child, "message"), once(child, "exit").then(() => { throw new Error(diagnostic); }),
  ]);
  assert.equal(typeof result[0], "number", diagnostic);
  return `http://127.0.0.1:${String(result[0])}`;
}

test("real OIDC discovery, PKCE token exchange, signed identity and returning login traverse HTTP and PostgreSQL", { timeout: 20_000 }, async (t) => {
  await ensureSchema();
  const root = await mkdtemp(path.join(tmpdir(), "pm-web-oidc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const certFile = path.join(root, "provider.crt");
  const keyFile = path.join(root, "provider.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile,
  ], { stdio: "ignore" });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = { ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
  const email = uniqueEmail("oidc-http");
  const subject = uniqueSlug("oidc-subject");
  const grants = new Map<string, { nonce: string; challenge: string }>();
  const exchanges: Array<{ form: URLSearchParams; authorization: string | undefined }> = [];
  let issuer = "";
  let discoveries = 0;
  const provider = createServer({ cert: await readFile(certFile), key: await readFile(keyFile) }, async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration") {
      discoveries += 1;
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_basic"],
      }));
    } else if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [publicKey] }));
    } else if (req.url === "/token") {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const form = new URLSearchParams(body);
      exchanges.push({ form, authorization: req.headers.authorization });
      const grant = grants.get(form.get("code") ?? "");
      if (!grant || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== grant.challenge) {
        res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      grants.delete(form.get("code") ?? "");
      const now = Math.floor(Date.now() / 1_000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: issuer, sub: subject, aud: "http-test-client", iat: now, exp: now + 300,
        nonce: grant.nonce, email, email_verified: true, name: "HTTP identity",
      })).toString("base64url");
      const token = `${header}.${claims}`;
      const signature = sign("RSA-SHA256", Buffer.from(token), keys.privateKey).toString("base64url");
      res.end(JSON.stringify({ access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 300, id_token: `${token}.${signature}` }));
    } else {
      res.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    }
  });
  await new Promise<void>((resolve) => { provider.listen(0, "127.0.0.1", resolve); });
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  issuer = `https://127.0.0.1:${address.port}`;
  t.after(() => new Promise<void>((resolve) => { provider.closeAllConnections(); provider.close(() => resolve()); }));
  const app = await oidcApp(t, issuer, certFile);
  const config = await fetch(`${app}/api/auth/oidc/config`);
  assert.deepEqual(await config.json(), { enabled: true, label: "OpenID Connect" });
  const missingCookie = await fetch(`${app}/api/auth/oidc/callback?code=unrequested&state=unrequested`);
  assert.equal(missingCookie.status, 400);
  assert.ok(missingCookie.headers.getSetCookie().some((value) => value.startsWith(`${OIDC_STATE_COOKIE}=;`)));
  assert.equal(discoveries, 0, "invalid login flow must fail before contacting the provider");
  for (const attempt of [0, 1]) {
    const start = await fetch(`${app}/api/auth/oidc/start`, { redirect: "manual" });
    assert.equal(start.status, 302, await start.clone().text());
    const authorization = new URL(start.headers.get("location") ?? "");
    assert.equal(authorization.origin, issuer);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("client_id"), "http-test-client");
    const state = authorization.searchParams.get("state");
    const nonce = authorization.searchParams.get("nonce");
    const challenge = authorization.searchParams.get("code_challenge");
    assert.ok(state && nonce && challenge);
    const code = `code-${attempt}`;
    grants.set(code, { nonce, challenge });
    const cookie = start.headers.getSetCookie().find((value) => value.startsWith(`${OIDC_STATE_COOKIE}=`))?.split(";")[0];
    assert.ok(cookie);
    if (attempt === 0) {
      for (const [query, status, expectedCode] of [
        [`code=${code}&state=wrong-state`, 400, "state_mismatch"],
        [`state=${state}&error=access_denied`, 403, "provider_access_denied"],
        [`state=${state}`, 400, "missing_code"],
      ] as const) {
        const rejected: Response = await fetch(`${app}/api/auth/oidc/callback?${query}`, { headers: { cookie } });
        assert.equal(rejected.status, status);
        assert.equal((await rejected.json() as { code: string }).code, expectedCode);
      }
      assert.equal(exchanges.length, 0);
    }
    const callback = await fetch(`${app}/api/auth/oidc/callback?code=${code}&state=${state}`, { headers: { cookie }, redirect: "manual" });
    assert.equal(callback.status, 303, await callback.clone().text());
    assert.equal(callback.headers.get("location"), "/");
    const session = callback.headers.getSetCookie().find((value) => value.startsWith("pm_token="))?.split(";")[0];
    assert.ok(session);
    const me = await fetch(`${app}/api/auth/me`, { headers: { cookie: session } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { user: { email: string } }).user.email, email);
    const replay = await fetch(`${app}/api/auth/oidc/callback?code=${code}&state=${state}`, { headers: { cookie } });
    assert.equal(replay.status, 400, "a redeemed authorization code cannot log in twice");
    assert.deepEqual(await replay.json(), { error: "OpenID Connect login failed." });
  }
  assert.equal(discoveries, 1, "returning login reuses discovery");
  assert.equal(exchanges.length, 4);
  for (const exchange of exchanges) {
    const authorization = exchange.authorization;
    assert.ok(authorization);
    assert.match(authorization, /^Basic /);
    const credentials = Buffer.from(authorization.slice(6), "base64").toString().split(":").map(decodeURIComponent);
    assert.deepEqual(credentials, ["http-test-client", "synthetic-client-secret"]);
    assert.equal(exchange.form.get("client_secret"), null, "basic-auth provider must not receive a post secret");
  }
  assert.ok(exchanges.every((exchange) => exchange.form.get("grant_type") === "authorization_code"));
  const users = await pool.query<{ id: string }>("SELECT id FROM pm_users WHERE email = $1", [email]);
  assert.equal(users.rows.length, 1, "returning identity must not create another account");
  const identities = await pool.query<{ user_id: string }>("SELECT user_id FROM pm_external_identities WHERE issuer = $1 AND subject = $2", [issuer, subject]);
  assert.deepEqual(identities.rows, [{ user_id: users.rows[0].id }]);
});
