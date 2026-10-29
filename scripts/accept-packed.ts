import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { ExtensionManifest } from "@unbrained/pm-cli/sdk";

/** Package fields that define the packed standalone-host acceptance contract. */
interface PackageContract {
  readonly dependencies: Readonly<Record<string, string>>;
}

/** One package-manager launcher exercised in a fresh project. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly port: number;
  readonly hostVersion: string;
}

/** Machine-readable proof emitted for a successful packed installation. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly standalone_sdk_version: string;
  readonly command_status: "up" | "down";
  readonly command_port: number;
  readonly deprecated_diagnostic: false;
  readonly unpublished_npm_link_omitted: true;
  readonly inbox_snapshot: true;
}

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const hostVersion = manifest.dependencies[cliPackage];
const extension = JSON.parse(readFileSync(join(repoRoot, "manifest.json"), "utf8")) as ExtensionManifest;
const minimumHostVersion = extension.pm_min_version;
if (!/^\d+\.\d+\.\d+$/u.test(hostVersion ?? "")) {
  throw new Error(`package.json must exact-pin ${cliPackage} as a runtime dependency`);
}
if (!minimumHostVersion || !/^\d+\.\d+\.\d+$/u.test(minimumHostVersion)) {
  throw new Error("manifest.json must declare an exact minimum host version for packed acceptance");
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const npmCli = process.env.npm_execpath?.endsWith(".js") ? process.env.npm_execpath : undefined;
const npmLauncher = npmCli === undefined
  ? { command: npmCommand, prefix: [] as string[] }
  : { command: process.execPath, prefix: [npmCli] };
const npxLauncher = npmCli === undefined
  ? { command: npxCommand, prefix: [] as string[] }
  : { command: process.execPath, prefix: [resolve(dirname(npmCli), "npx-cli.js")] };
const cleanEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  npm_config_userconfig: devNull,
  NPM_CONFIG_USERCONFIG: devNull,
  PM_TELEMETRY_DISABLED: "1",
};
// PM-linked tests select a sandbox through PM_PATH. Packed scenarios must
// initialize their own tracker and never inherit that ancestor workspace.
delete cleanEnvironment.PM_PATH;
delete cleanEnvironment.PM_SOURCE_PM_PATH;
delete cleanEnvironment.PM_SOURCE_WORKSPACE_ROOT;
for (const key of Object.keys(cleanEnvironment)) {
  if (key.toLowerCase() === "npm_config_allow_scripts" || /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER/i.test(key)) delete cleanEnvironment[key];
}
const commandTimeoutMs = 5 * 60 * 1000;

/** Run one shell-free command and fail with bounded diagnostics. */
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = cleanEnvironment,
): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: commandTimeoutMs,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} exceeded ${String(commandTimeoutMs)}ms`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${String(result.status)}: ${(result.stderr || result.error?.message || result.stdout).trim()}`,
    );
  }
  return result;
}

/** Invoke the installed host with npm's launcher or directly in the native Bun runtime. */
function runPm(
  scenario: AcceptanceScenario,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): SpawnSyncReturns<string> {
  if (scenario.manager === "npm") {
    return run(npxLauncher.command, [...npxLauncher.prefix, "--no-install", "pm", ...args], cwd, env);
  }
  const installedRequire = createRequire(join(cwd, "package.json"));
  const packagePath = installedRequire.resolve(`${cliPackage}/package.json`);
  const installed = JSON.parse(readFileSync(packagePath, "utf8")) as { bin?: { pm?: string } };
  if (typeof installed.bin?.pm !== "string") throw new Error("Installed host does not declare its pm binary");
  // bunx --bun also redirects child `node` commands to Bun, including npm.
  // Execute the genuine PM entry with Bun while retaining Node for its npm child.
  return run(bunCommand, [resolve(dirname(packagePath), installed.bin.pm), ...args], cwd, env);
}

/** Exercise the packed command's typed boundary under a real launcher, without contacting a server. */
function permissionCommandProbe(command: string, prefix: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  for (const probe of [
    ['permission-impact', '--share', '12345678-1234-1234-1234-123456789abc', '--permission', 'view'],
    ['evidence', '--item', 'example-task'],
  ]) {
    const result = spawnSync(command, [...prefix, '--pm-path', join(cwd, '.agents', 'pm'), 'web', ...probe, '--url', 'https://example.test', '--project', '12345678-1234-1234-1234-123456789abc', '--json'], { cwd, env, encoding: 'utf8', timeout: commandTimeoutMs });
    if (result.status === 0 || !/invalid_input/.test(result.stdout + result.stderr) || !/PM_WEB_TOKEN/.test(result.stdout + result.stderr)) throw new Error('Packed inspection command did not reach its typed credential boundary');
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "pm-web-packed-acceptance-"));
try {
  const packRoot = join(temporaryRoot, "pack");
  mkdirSync(packRoot);
  run(
    npmLauncher.command,
    [...npmLauncher.prefix, "pack", "--ignore-scripts", "--pack-destination", packRoot],
    repoRoot,
    { ...cleanEnvironment, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
  );
  const packedNames = readdirSync(packRoot).filter((name) => name.endsWith(".tgz"));
  if (packedNames.length !== 1) {
    throw new Error(`npm pack must create exactly one tarball, got ${String(packedNames.length)}`);
  }
  const tarball = join(packRoot, packedNames[0]!);
  const packedSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const scenarios: readonly AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", port: 61113, hostVersion },
    { name: "bun-current", manager: "bun", port: 61114, hostVersion },
    { name: "npm-minimum", manager: "npm", port: 61115, hostVersion: minimumHostVersion },
    { name: "bun-minimum", manager: "bun", port: 61116, hostVersion: minimumHostVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];
  const permissionLaunchers: string[] = [];

  for (const scenario of scenarios) {
    const scenarioRoot = join(temporaryRoot, scenario.name);
    const configRoot = join(scenarioRoot, "xdg-config");
    const dataRoot = join(scenarioRoot, "xdg-data");
    mkdirSync(scenarioRoot);
    mkdirSync(configRoot);
    mkdirSync(dataRoot);
    const scenarioEnvironment: NodeJS.ProcessEnv = {
      ...cleanEnvironment,
      PM_GLOBAL_PATH: join(scenarioRoot, "global-pm"),
      XDG_CONFIG_HOME: configRoot,
      XDG_DATA_HOME: dataRoot,
      npm_config_cache: join(scenarioRoot, "npm-cache"),
      BUN_INSTALL_CACHE_DIR: join(scenarioRoot, "bun-cache"),
    };

    if (scenario.manager === "npm") {
      run(npmLauncher.command, [...npmLauncher.prefix, "init", "-y"], scenarioRoot, scenarioEnvironment);
      run(
        npmLauncher.command,
        [...npmLauncher.prefix, "install", "--omit=dev", "--ignore-scripts", tarball, `${cliPackage}@${scenario.hostVersion}`],
        scenarioRoot,
        scenarioEnvironment,
      );
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(bunCommand, ["add", "--ignore-scripts", tarball, `${cliPackage}@${scenario.hostVersion}`], scenarioRoot, scenarioEnvironment);
    }

    const actualVersion = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--version"]).stdout.trim();
    if (actualVersion !== scenario.hostVersion) {
      throw new Error(`${scenario.name} resolved pm ${actualVersion}, expected ${scenario.hostVersion}`);
    }
    // Resolve from the installed server, not the consumer's host. A minimum
    // host install may intentionally carry a separate, newer standalone SDK.
    const serverRequire = createRequire(join(scenarioRoot, "node_modules", "@unbrained", "pm-web", "package.json"));
    const standaloneCli = resolve(dirname(serverRequire.resolve(`${cliPackage}/sdk`)), "..", "cli.js");
    const standaloneVersion = run(scenario.manager === "bun" ? bunCommand : process.execPath,
      [standaloneCli, "--version"], scenarioRoot, scenarioEnvironment).stdout.trim();
    if (standaloneVersion !== hostVersion) {
      throw new Error(`${scenario.name} standalone SDK resolved ${standaloneVersion}, expected ${hostVersion}`);
    }
    runPm(scenario, scenarioRoot, scenarioEnvironment, [
      "init",
      "--defaults",
      "--agent-guidance",
      "skip",
      "--prefix",
      "accept",
    ]);
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["package", "install", tarball, "--project"]);
    const localBin = join(scenarioRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'pm.cmd' : 'pm');
    if (process.platform !== 'win32') {
      permissionCommandProbe(localBin, [], scenarioRoot, scenarioEnvironment);
      permissionLaunchers.push(`${scenario.name}:project-local`);
    }
    if (scenario.name === 'npm-current') {
      permissionCommandProbe(npxLauncher.command, [...npxLauncher.prefix, '--no-install', 'pm'], scenarioRoot, scenarioEnvironment);
      permissionLaunchers.push('npx');
      const globalPrefix = join(temporaryRoot, 'npm-global');
      run(npmLauncher.command, [...npmLauncher.prefix, 'install', '--global', '--prefix', globalPrefix, '--ignore-scripts', `${cliPackage}@${hostVersion}`], scenarioRoot, scenarioEnvironment);
      if (process.platform !== 'win32') {
        permissionCommandProbe(join(globalPrefix, 'bin', 'pm'), [], scenarioRoot, scenarioEnvironment);
        permissionLaunchers.push('npm-global');
      }
    }
    if (scenario.name === 'bun-current') {
      permissionCommandProbe(bunCommand, ['x', '--no-install', 'pm'], scenarioRoot, scenarioEnvironment);
      permissionLaunchers.push('bunx');
      const globalPrefix = join(temporaryRoot, 'bun-global');
      const globalEnv = { ...scenarioEnvironment, BUN_INSTALL: globalPrefix, BUN_INSTALL_GLOBAL_DIR: join(globalPrefix, 'install', 'global'), BUN_INSTALL_BIN: join(globalPrefix, 'bin') };
      run(bunCommand, ['add', '--global', '--ignore-scripts', `${cliPackage}@${hostVersion}`], scenarioRoot, globalEnv);
      if (process.platform !== 'win32') {
        permissionCommandProbe(join(globalPrefix, 'bin', 'pm'), [], scenarioRoot, globalEnv);
        permissionLaunchers.push('bun-global');
      }
    }
    const status = runPm(scenario, scenarioRoot, scenarioEnvironment, [
      "web",
      "status",
      "--json",
      "--port",
      String(scenario.port),
    ]);
    const result = JSON.parse(status.stdout) as Record<string, unknown>;
    if ((result["status"] !== "up" && result["status"] !== "down") || result["port"] !== scenario.port) {
      throw new Error(`${scenario.name} packed web status returned an invalid contract`);
    }
    if (/deprecated|list-all|list-open/iu.test(status.stderr)) {
      throw new Error(`${scenario.name} emitted a deprecated-command diagnostic: ${status.stderr.trim()}`);
    }
    // Exercise the shipped catalog and browser card under the consumer's real
    // runtime, after installation; local build imports cannot prove tarball contents.
    run(scenario.manager === "bun" ? bunCommand : process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { join } from "node:path";
      import { PmClient } from "@unbrained/pm-cli/sdk";
      import { readDecisionInboxSnapshot, listDecisionInbox, requestDecision, respondToDecision } from "@unbrained/pm-web";
      const pmRoot = join(process.cwd(), ".agents", "pm");
      const author = "packed-agent";
      const client = new PmClient({ cwd: process.cwd(), pmRoot, noExtensions: true, author });
      const plan = await client.create({ type: "Plan", title: "Packed snapshot", unset: ["parent", "goal", "objective", "sprint", "release"] });
      const actor = { author, permission: "edit" };
      const request = await requestDecision(pmRoot, actor, { planId: plan.item.id, question: "Which path?", alternatives: ["A", "B"], evidence: "Synthetic packed evidence" });
      const captured = await readDecisionInboxSnapshot(pmRoot);
      assert.equal(captured.length, 1);
      assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured[0]) && Object.isFrozen(captured[0].alternatives));
      await respondToDecision(pmRoot, actor, { planId: request.planId, requestId: request.id, revision: request.revision, action: "approve", alternative: 0, reason: "Selected A" });
      assert.equal(captured[0].id, request.id);
      assert.equal(captured[0].status, "pending");
      assert.deepEqual(await readDecisionInboxSnapshot(pmRoot), []);
      assert.equal((await listDecisionInbox(pmRoot)).total, 0);
      import { findCatalogEntry } from "@unbrained/pm-web/dist/services/package-catalog.js";
      import { renderPackageCard } from "@unbrained/pm-web/public/src/views/packages.js";
      const jev = findCatalogEntry("pm-jev");
      assert.equal(jev.availability, "unreleased");
      assert.equal(jev.links.npm, undefined);
      const html = renderPackageCard({ ...jev, installed: false });
      assert.ok(!html.includes("npmjs.com"));
      for (const url of Object.values(jev.links)) assert.ok(html.includes(url));
    `], scenarioRoot, scenarioEnvironment);
    receipts.push({
      scenario: scenario.name,
      host_version: actualVersion,
      standalone_sdk_version: standaloneVersion,
      command_status: result["status"],
      command_port: scenario.port,
      deprecated_diagnostic: false,
      unpublished_npm_link_omitted: true,
      inbox_snapshot: true,
    });
  }

  if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== packedSha256) throw new Error('Packed artifact changed during acceptance');
  process.stdout.write(`${JSON.stringify({ ok: true, receipts, permissionLaunchers, packedSha256 })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
