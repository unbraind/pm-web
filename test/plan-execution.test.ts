import assert from 'node:assert/strict';
import test from 'node:test';

const moduleUrl = new URL('../public/src/views/plan-execution.js', import.meta.url).href;
const mod: {
  buildPlanExecutionSnapshot: (steps: Array<Record<string, unknown>>) => {
    totalSteps: number;
    completedSteps: number;
    blockedSteps: number;
    readySteps: Array<{ ref: string }>;
    waitingSteps: Array<{ ref: string; unresolvedDependencies: string[]; incompleteDependencies: string[] }>;
    blockedStepDetails: Array<{ ref: string }>;
    nextReadyStep: { ref: string } | null;
  };
  buildPlanAgentBrief: (plan: Record<string, unknown>, snapshot: unknown) => string;
  buildNextStepPrompt: (plan: Record<string, unknown>, snapshot: unknown, stepRef?: string) => string;
} = await import(moduleUrl);

test('buildPlanExecutionSnapshot classifies ready, waiting, and blocked steps', () => {
  const snapshot = mod.buildPlanExecutionSnapshot([
    { ref: 'step-001', title: 'Foundation', status: 'done' },
    { ref: 'step-002', title: 'API wiring', status: 'open', dependsOn: ['step-001'] },
    { ref: 'step-003', title: 'UI integration', status: 'open', dependsOn: ['step-002'] },
    { ref: 'step-004', title: 'External dependency', status: 'blocked', blockedReason: 'Awaiting vendor key' },
    { ref: 'step-005', title: 'Finalize docs', status: 'pending', dependsOn: ['missing-step'] },
    { ref: 'step-006', title: 'Smoke pass', status: 'pending' },
  ]);

  assert.equal(snapshot.totalSteps, 6);
  assert.equal(snapshot.completedSteps, 1);
  assert.equal(snapshot.blockedSteps, 1);
  assert.deepEqual(snapshot.readySteps.map((s) => s.ref), ['step-002', 'step-006']);
  assert.deepEqual(snapshot.waitingSteps.map((s) => s.ref), ['step-003', 'step-005']);
  assert.deepEqual(snapshot.blockedStepDetails.map((s) => s.ref), ['step-004']);
  assert.equal(snapshot.nextReadyStep?.ref, 'step-002');

  const waitingOnDependency = snapshot.waitingSteps.find((s) => s.ref === 'step-003');
  assert.deepEqual(waitingOnDependency?.incompleteDependencies, ['step-002']);

  const waitingOnMissing = snapshot.waitingSteps.find((s) => s.ref === 'step-005');
  assert.deepEqual(waitingOnMissing?.unresolvedDependencies, ['missing-step']);
});

test('buildPlanAgentBrief includes execution summary and queues', () => {
  const snapshot = mod.buildPlanExecutionSnapshot([
    { ref: 'step-1', title: 'Bootstrap', status: 'done' },
    { ref: 'step-2', title: 'Ship UX update', status: 'pending' },
    { ref: 'step-3', title: 'Notify stakeholders', status: 'pending', dependsOn: ['step-2'] },
    { ref: 'step-4', title: 'Get legal signoff', status: 'blocked', blockedReason: 'Pending review' },
  ]);

  const brief = mod.buildPlanAgentBrief(
    { id: 'PLAN-77', title: 'Agent UX uplift', status: 'in_progress', scope: 'web-ui' },
    snapshot
  );

  assert.match(brief, /Plan execution brief/);
  assert.match(brief, /Plan ID: PLAN-77/);
  assert.match(brief, /Ready now \(1\)/);
  assert.match(brief, /Waiting \(1\)/);
  assert.match(brief, /Blocked \(1\)/);
  assert.match(brief, /step-2/);
});

test('buildNextStepPrompt returns fallback message when no ready steps exist', () => {
  const snapshot = mod.buildPlanExecutionSnapshot([
    { ref: 'step-1', title: 'Do follow-up', status: 'pending', dependsOn: ['missing-step'] },
  ]);
  const prompt = mod.buildNextStepPrompt({ id: 'PLAN-99', title: 'Blocked rollout' }, snapshot);
  assert.match(prompt, /No ready step is currently available/);
});

test('buildNextStepPrompt explains waiting dependencies for explicit step prompts', () => {
  const snapshot = mod.buildPlanExecutionSnapshot([
    { ref: 'step-001', title: 'Foundation', status: 'pending' },
    { ref: 'step-002', title: 'API wiring', status: 'pending', dependsOn: ['step-001'] },
  ]);

  const prompt = mod.buildNextStepPrompt(
    { id: 'PLAN-120', title: 'Dependency-aware rollout' },
    snapshot,
    'step-002'
  );

  assert.match(prompt, /Step readiness: waiting\./);
  assert.match(prompt, /Pending dependencies: step-001/);
  assert.match(prompt, /Resolve blockers\/dependencies first/);
});

test('buildNextStepPrompt explains blocked state for explicit step prompts', () => {
  const snapshot = mod.buildPlanExecutionSnapshot([
    { ref: 'step-010', title: 'Security review', status: 'blocked', blockedReason: 'Awaiting security sign-off' },
  ]);

  const prompt = mod.buildNextStepPrompt(
    { id: 'PLAN-121', title: 'Security-gated release' },
    snapshot,
    'step-010'
  );

  assert.match(prompt, /Step readiness: blocked\./);
  assert.match(prompt, /Blocked reason: Awaiting security sign-off/);
  assert.match(prompt, /Resolve blockers\/dependencies first/);
});
