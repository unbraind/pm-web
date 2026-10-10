import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
const bunxCommand = process.platform === "win32" ? "bunx.exe" : "bunx";
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
  if (key.toLowerCase() === "npm_config_allow_scripts") delete cleanEnvironment[key];
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

/** Invoke the scenario-local pm host through the package manager's public launcher. */
function runPm(
  scenario: AcceptanceScenario,
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
): SpawnSyncReturns<string> {
  return scenario.manager === "npm"
    ? run(npxLauncher.command, [...npxLauncher.prefix, "--no-install", "pm", ...args], cwd, env)
    : run(bunxCommand, ["--bun", "--no-install", "pm", ...args], cwd, env);
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
  const scenarios: readonly AcceptanceScenario[] = [
    { name: "npm-current", manager: "npm", port: 61113, hostVersion },
    { name: "bun-current", manager: "bun", port: 61114, hostVersion },
    { name: "npm-minimum", manager: "npm", port: 61115, hostVersion: minimumHostVersion },
    { name: "bun-minimum", manager: "bun", port: 61116, hostVersion: minimumHostVersion },
  ];
  const receipts: AcceptanceReceipt[] = [];

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
    receipts.push({
      scenario: scenario.name,
      host_version: actualVersion,
      standalone_sdk_version: standaloneVersion,
      command_status: result["status"],
      command_port: scenario.port,
      deprecated_diagnostic: false,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
