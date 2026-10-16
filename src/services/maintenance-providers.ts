import { getProjectDir, readProjectCommandOwners } from "./pm-runner.ts";

/** Maintenance actions and the bundled commands that implement them. */
const PROVIDERS = {
  "comments-audit": { provider: "pm-governance-audit", command: "item audit-comments", owner: "builtin-governance-audit" },
  normalize: { provider: "pm-governance-audit", command: "normalize", owner: "builtin-governance-audit" },
  reindex: { provider: "pm-search-advanced", command: "reindex", owner: "builtin-search-advanced" },
} as const;

/** The supported maintenance action names. */
export type MaintenanceAction = keyof typeof PROVIDERS;

/** Role-aware availability returned by the extensions endpoint and refusals. */
export interface MaintenanceCapability {
  available: boolean;
  provider: string;
  hint: string;
  installAction?: { method: "POST"; url: string };
}

const CACHE_TTL_MS = 5_000;
const CACHE_LIMIT = 256;
const capabilityCache = new Map<string, { expires: number; value: Promise<Set<string>> }>();

/** Forget capabilities after an explicit package mutation in this project. */
export function invalidateMaintenanceCapabilities(projectDir: string): void {
  capabilityCache.delete(projectDir);
}

/** Cache only command availability, never caller permissions or install URLs. */
async function availableActions(projectDir: string): Promise<Set<string>> {
  const cached = capabilityCache.get(projectDir);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = readProjectCommandOwners(projectDir).then((owners) => new Set(
    Object.entries(PROVIDERS).filter(([, spec]) => {
      const claims = owners.filter((row) => row.command === spec.command);
      return claims.length > 0 && claims.every((row) => row.claimants.some((claim) => claim.winner && claim.name === spec.owner));
    }).map(([action]) => action),
  ));
  if (capabilityCache.size >= CACHE_LIMIT) capabilityCache.delete(capabilityCache.keys().next().value!);
  capabilityCache.set(projectDir, { expires: Date.now() + CACHE_TTL_MS, value });
  try { return await value; } catch (error) {
    if (capabilityCache.get(projectDir)?.value === value) capabilityCache.delete(projectDir);
    throw error;
  }
}

/** Inspect available provider commands without installing or enabling packages. */
export async function readMaintenanceCapabilities(
  project: { ownerUserId: string; slug: string; permission: string },
  projectId: string,
): Promise<Record<MaintenanceAction, MaintenanceCapability>> {
  const actions = await availableActions(getProjectDir(project.ownerUserId, project.slug));
  return Object.fromEntries(Object.entries(PROVIDERS).map(([action, spec]) => [action, {
    available: actions.has(action), provider: spec.provider,
    hint: project.permission === "edit"
      ? `Open Packages and install or enable ${spec.provider} for this project.`
      : `Ask a project owner or editor to install or enable ${spec.provider} in Packages.`,
    ...(project.permission === "edit" ? { installAction: {
      method: "POST", url: `/api/projects/${projectId}/extensions/${spec.provider}/install`,
    } } : {}),
  }])) as Record<MaintenanceAction, MaintenanceCapability>;
}
