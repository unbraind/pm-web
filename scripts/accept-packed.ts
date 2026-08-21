import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Package fields that define the packed standalone-host acceptance contract. */
interface PackageContract {
  readonly dependencies: Readonly<Record<string, string>>;
}

/** One package-manager launcher exercised in a fresh project. */
interface AcceptanceScenario {
  readonly name: string;
  readonly manager: "npm" | "bun";
  readonly port: number;
}

/** Machine-readable proof emitted for a successful packed installation. */
interface AcceptanceReceipt {
  readonly scenario: string;
  readonly host_version: string;
  readonly command_status: "up" | "down";
  readonly command_port: number;
  readonly deprecated_diagnostic: false;
}

const repoRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageContract;
const cliPackage = "@unbrained/pm-cli";
const hostVersion = manifest.dependencies[cliPackage];
if (!/^\d+\.\d+\.\d+$/u.test(hostVersion ?? "")) {
  throw new Error(`package.json must exact-pin ${cliPackage} as a runtime dependency`);
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
    : run(bunxCommand, ["--no-install", "pm", ...args], cwd, env);
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
    { name: "npm-current", manager: "npm", port: 61113 },
    { name: "bun-current", manager: "bun", port: 61114 },
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
        [...npmLauncher.prefix, "install", "--ignore-scripts", tarball],
        scenarioRoot,
        scenarioEnvironment,
      );
    } else {
      run(bunCommand, ["init", "-y"], scenarioRoot, scenarioEnvironment);
      run(bunCommand, ["add", "--ignore-scripts", tarball], scenarioRoot, scenarioEnvironment);
    }

    const actualVersion = runPm(scenario, scenarioRoot, scenarioEnvironment, ["--version"]).stdout.trim();
    if (actualVersion !== hostVersion) {
      throw new Error(`${scenario.name} resolved pm ${actualVersion}, expected ${hostVersion}`);
    }
    runPm(scenario, scenarioRoot, scenarioEnvironment, [
      "init",
      "--defaults",
      "--agent-guidance",
      "skip",
      "--prefix",
      "accept",
    ]);
    runPm(scenario, scenarioRoot, scenarioEnvironment, ["install", tarball, "--project"]);
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
      command_status: result["status"],
      command_port: scenario.port,
      deprecated_diagnostic: false,
    });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, receipts })}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
