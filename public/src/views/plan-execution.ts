type PlanStepInput = {
  id?: string;
  ref?: string;
  title?: string;
  description?: string;
  status?: string;
  blockedReason?: string;
  blocked_reason?: string;
  dependsOn?: string[];
  depends_on?: string[];
};

type PlanInput = {
  id?: string;
  title?: string;
  description?: string;
  scope?: string;
  status?: string;
};

export type AnalyzedPlanStep = {
  ref: string;
  title: string;
  description: string;
  status: string;
  blockedReason: string;
  dependsOn: string[];
  unresolvedDependencies: string[];
  incompleteDependencies: string[];
  isDone: boolean;
  isBlocked: boolean;
  original: PlanStepInput;
};

export type PlanExecutionSnapshot = {
  totalSteps: number;
  completedSteps: number;
  blockedSteps: number;
  waitingSteps: AnalyzedPlanStep[];
  readySteps: AnalyzedPlanStep[];
  blockedStepDetails: AnalyzedPlanStep[];
  allSteps: AnalyzedPlanStep[];
  stepByRef: Record<string, AnalyzedPlanStep>;
  completionPct: number;
  nextReadyStep: AnalyzedPlanStep | null;
};

const DONE_STATUSES = new Set(['done', 'completed', 'closed']);
const BLOCKED_STATUSES = new Set(['blocked']);

function normalizeStatus(status?: string): string {
  const value = (status || 'pending').trim().toLowerCase().replace(/\s+/g, '_');
  return value || 'pending';
}

function normalizeStepRef(step: PlanStepInput, index: number): string {
  const candidate = (step.ref || step.id || '').trim();
  return candidate || `step-${index + 1}`;
}

function normalizeDependsOn(step: PlanStepInput): string[] {
  const raw = Array.isArray(step.dependsOn)
    ? step.dependsOn
    : (Array.isArray(step.depends_on) ? step.depends_on : []);
  const unique = new Set<string>();
  for (const dep of raw) {
    const trimmed = String(dep || '').trim();
    if (trimmed) unique.add(trimmed);
  }
  return Array.from(unique);
}

function formatStepLine(step: AnalyzedPlanStep): string {
  return `- [${step.ref}] ${step.title}`;
}

function formatWaitReason(step: AnalyzedPlanStep): string {
  const blockers = [
    ...step.incompleteDependencies,
    ...step.unresolvedDependencies.map(dep => `${dep} (missing)`),
  ];
  if (blockers.length === 0) return 'waiting';
  return `waiting on ${blockers.join(', ')}`;
}

function stepDependencyBlockers(step: AnalyzedPlanStep): string[] {
  return [
    ...step.incompleteDependencies,
    ...step.unresolvedDependencies.map(dep => `${dep} (missing)`),
  ];
}

export function buildPlanExecutionSnapshot(steps: PlanStepInput[]): PlanExecutionSnapshot {
  const normalized: AnalyzedPlanStep[] = steps.map((step, index) => {
    const status = normalizeStatus(step.status);
    return {
      ref: normalizeStepRef(step, index),
      title: (step.title || '(untitled)').trim() || '(untitled)',
      description: (step.description || '').trim(),
      status,
      blockedReason: (step.blockedReason || step.blocked_reason || '').trim(),
      dependsOn: normalizeDependsOn(step),
      unresolvedDependencies: [],
      incompleteDependencies: [],
      isDone: DONE_STATUSES.has(status),
      isBlocked: BLOCKED_STATUSES.has(status),
      original: step,
    };
  });

  const stepByRef: Record<string, AnalyzedPlanStep> = {};
  for (const step of normalized) {
    if (!stepByRef[step.ref]) stepByRef[step.ref] = step;
  }

  const completedRefs = new Set(normalized.filter(step => step.isDone).map(step => step.ref));

  for (const step of normalized) {
    if (step.isDone || step.isBlocked) continue;
    for (const dep of step.dependsOn) {
      if (!stepByRef[dep]) {
        step.unresolvedDependencies.push(dep);
      } else if (!completedRefs.has(dep)) {
        step.incompleteDependencies.push(dep);
      }
    }
  }

  const readySteps: AnalyzedPlanStep[] = [];
  const waitingSteps: AnalyzedPlanStep[] = [];
  const blockedStepDetails: AnalyzedPlanStep[] = [];

  for (const step of normalized) {
    if (step.isDone) continue;
    if (step.isBlocked) {
      blockedStepDetails.push(step);
      continue;
    }
    if (step.incompleteDependencies.length === 0 && step.unresolvedDependencies.length === 0) {
      readySteps.push(step);
    } else {
      waitingSteps.push(step);
    }
  }

  const totalSteps = normalized.length;
  const completedSteps = normalized.filter(step => step.isDone).length;
  const blockedSteps = blockedStepDetails.length;
  const completionPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  return {
    totalSteps,
    completedSteps,
    blockedSteps,
    waitingSteps,
    readySteps,
    blockedStepDetails,
    allSteps: normalized,
    stepByRef,
    completionPct,
    nextReadyStep: readySteps[0] || null,
  };
}

export function buildPlanAgentBrief(plan: PlanInput, snapshot: PlanExecutionSnapshot): string {
  const title = (plan.title || plan.id || '(untitled)').trim();
  const lines: string[] = [
    '# Plan execution brief',
    `Plan: ${title}`,
  ];
  if (plan.id) lines.push(`Plan ID: ${plan.id}`);
  if (plan.status) lines.push(`Status: ${plan.status}`);
  if (plan.scope) lines.push(`Scope: ${plan.scope}`);
  if (plan.description) lines.push('', 'Description:', plan.description.trim());

  lines.push(
    '',
    'Execution summary:',
    `- Completed: ${snapshot.completedSteps}/${snapshot.totalSteps} (${snapshot.completionPct}%)`,
    `- Ready now: ${snapshot.readySteps.length}`,
    `- Waiting on dependencies: ${snapshot.waitingSteps.length}`,
    `- Explicitly blocked: ${snapshot.blockedStepDetails.length}`
  );

  if (snapshot.readySteps.length > 0) {
    lines.push('', `Ready now (${snapshot.readySteps.length}):`);
    for (const step of snapshot.readySteps) lines.push(formatStepLine(step));
  } else {
    lines.push('', 'Ready now: none');
  }

  if (snapshot.waitingSteps.length > 0) {
    lines.push('', `Waiting (${snapshot.waitingSteps.length}):`);
    for (const step of snapshot.waitingSteps) {
      lines.push(`${formatStepLine(step)} (${formatWaitReason(step)})`);
    }
  }

  if (snapshot.blockedStepDetails.length > 0) {
    lines.push('', `Blocked (${snapshot.blockedStepDetails.length}):`);
    for (const step of snapshot.blockedStepDetails) {
      const reason = step.blockedReason ? `: ${step.blockedReason}` : '';
      lines.push(`${formatStepLine(step)}${reason}`);
    }
  }

  lines.push(
    '',
    'Instruction:',
    'Pick the top ready step, execute it end-to-end, and report tests/evidence before moving to the next.'
  );

  return lines.join('\n');
}

export function buildNextStepPrompt(
  plan: PlanInput,
  snapshot: PlanExecutionSnapshot,
  stepRef?: string
): string {
  const step = stepRef ? snapshot.stepByRef[stepRef] : snapshot.nextReadyStep;
  if (!step) {
    const planName = (plan.title || plan.id || '(untitled)').trim();
    return [
      `No ready step is currently available for plan "${planName}".`,
      'Please inspect waiting and blocked steps, resolve dependencies, and refresh the plan.',
    ].join('\n');
  }

  const planName = (plan.title || plan.id || '(untitled)').trim();
  const dependencyBlockers = stepDependencyBlockers(step);
  const isWaiting = dependencyBlockers.length > 0 && !step.isBlocked;
  const readinessLabel = step.isBlocked ? 'blocked' : (isWaiting ? 'waiting' : 'ready');
  const lines: string[] = [
    '# Next step execution prompt',
    `You are working on plan "${planName}"${plan.id ? ` (${plan.id})` : ''}.`,
    `Current progress: ${snapshot.completedSteps}/${snapshot.totalSteps} complete.`,
    `Step readiness: ${readinessLabel}.`,
    '',
    `Execute step [${step.ref}] ${step.title}.`,
  ];

  if (step.description) {
    lines.push(`Step details: ${step.description}`);
  }

  if (step.isBlocked) {
    lines.push(
      `Blocked reason: ${step.blockedReason || 'No reason provided.'}`,
      'This step is explicitly blocked. Resolve the blocker before implementation.'
    );
  } else if (isWaiting) {
    lines.push(
      `Pending dependencies: ${dependencyBlockers.join(', ')}`,
      'This step is waiting on dependencies. Do not start implementation until dependencies are complete.'
    );
  } else if (step.dependsOn.length > 0) {
    lines.push(`Dependencies already satisfied: ${step.dependsOn.join(', ')}`);
  }

  lines.push('', 'Execution requirements:');
  if (step.isBlocked || isWaiting) {
    lines.push(
      '- Resolve blockers/dependencies first, then refresh this plan snapshot.',
      '- Once ready, execute the step in production-ready quality.',
      '- Report exact commands/outcomes and evidence collected.',
      '- Update dependency and step status notes after each change.'
    );
  } else {
    lines.push(
      '- Implement in production-ready quality.',
      '- Add or update tests where feasible.',
      '- Report the exact commands and outcomes.',
      '- Update the step status when done.'
    );
  }

  return lines.join('\n');
}
