import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import vitestConfig from '../../vitest.config';

type WorkflowRecord = Record<string, unknown>;
type WorkflowStep = WorkflowRecord & { name?: string };

function asRecord(value: unknown, label: string): WorkflowRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as WorkflowRecord;
}

function asSteps(value: unknown, label: string): WorkflowStep[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((step, index) => asRecord(step, `${label}[${index}]`) as WorkflowStep);
}

async function loadWorkflow(name: string) {
  return asRecord(parseYaml(await readFile(`.github/workflows/${name}`, 'utf8')), name);
}

function workflowJob(workflow: WorkflowRecord, name: string) {
  return asRecord(asRecord(workflow.jobs, 'workflow jobs')[name], `job ${name}`);
}

function jobSteps(job: WorkflowRecord, name: string) {
  return asSteps(job.steps, `${name} steps`);
}

function findStep(steps: WorkflowStep[], name: string) {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step: ${name}`);
  return step;
}

function stepIndex(steps: WorkflowStep[], name: string) {
  const index = steps.findIndex((step) => step.name === name);
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe('critical CI workflows', () => {
  it('defines a reproducible critical-domain coverage artifact with moderate global thresholds', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const testConfig = asRecord(vitestConfig.test, 'Vitest test config');
    const coverage = asRecord(testConfig.coverage, 'Vitest coverage config');
    const thresholds = asRecord(coverage.thresholds, 'Vitest coverage thresholds');

    expect(packageJson.scripts?.['test:coverage']).toBe('vitest run --coverage');
    expect(packageJson.devDependencies?.['@vitest/coverage-v8']).toBe('4.1.5');
    expect(coverage.provider).toBe('v8');
    expect(coverage.reportsDirectory).toBe('coverage/critical');
    expect(coverage.reporter).toEqual(expect.arrayContaining(['text', 'json-summary', 'lcov']));
    expect(coverage.include).toEqual(
      expect.arrayContaining([
        'src/main/connectivity.ts',
        'src/main/runtimePorts.ts',
        'src/main/platform/systemProxy.ts',
        'src/main/traffic/store.ts',
        'src/main/remoteConfig.ts'
      ])
    );
    for (const metric of ['lines', 'statements', 'functions', 'branches']) {
      expect(thresholds[metric], metric).toBeGreaterThanOrEqual(60);
      expect(thresholds[metric], metric).toBeLessThanOrEqual(90);
    }
  });

  it('collects and uploads critical-domain coverage in Validate without changing the isolated process tests', async () => {
    const workflow = await loadWorkflow('validate.yml');
    const steps = jobSteps(workflowJob(workflow, 'validate'), 'validate');
    const testStep = findStep(steps, 'Test');
    const coverageStep = findStep(steps, 'Upload critical-domain coverage');
    const coverageWith = asRecord(coverageStep.with, 'coverage upload inputs');

    expect(testStep.run).toContain('--coverage');
    expect(testStep.run).toContain('--exclude tests/main/updateInstallerLauncher.test.ts');
    expect(testStep.run).toContain('--exclude tests/main/manageInstalledProcessScript.test.ts');
    expect(testStep.run).toContain('tests/main/manageInstalledProcessScript.test.ts');
    expect(testStep.run).toContain('tests/main/updateInstallerLauncher.test.ts');
    expect(coverageStep.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(coverageWith.path).toContain('coverage/critical');
    expect(coverageWith['if-no-files-found']).toBe('error');
  });

  it('ends Build Windows after a read-only provenance-bound artifact so publication failures cannot poison the build run', async () => {
    const workflow = await loadWorkflow('build-windows.yml');
    const steps = jobSteps(workflowJob(workflow, 'build'), 'build');
    const provenance = findStep(steps, 'Write release artifact provenance');
    const provenanceEnv = asRecord(provenance.env, 'provenance env');
    const upload = findStep(steps, 'Upload installer');
    const uploadWith = asRecord(upload.with, 'installer upload inputs');
    const permissions = asRecord(workflow.permissions, 'workflow permissions');

    expect(permissions.contents).toBe('read');
    expect(permissions.actions).toBe('read');
    expect(provenance.run).toContain('--write-provenance');
    expect(provenanceEnv.RELEASE_TAG).toBe('${{ github.ref_name }}');
    expect(provenanceEnv.RELEASE_RUN_ID).toBe('${{ github.run_id }}');
    expect(provenanceEnv.RELEASE_RUN_ATTEMPT).toBe('${{ github.run_attempt }}');
    expect(provenanceEnv.RELEASE_COMMIT_SHA).toBe('${{ github.sha }}');
    expect(provenanceEnv.RELEASE_EVENT).toBe('${{ github.event_name }}');
    expect(provenance.run).not.toContain('${{');
    expect(uploadWith.path).toContain('release/RELEASE-PROVENANCE.json');
    expect(steps.some((step) => step.name === 'Publish GitHub Release')).toBe(false);
    expect(steps.some((step) => step.name === 'Verify published GitHub Release')).toBe(false);
  });

  it('publishes after a successful tag Build Windows run while preserving the manually verified retry path', async () => {
    const workflow = await loadWorkflow('publish-github-release.yml');
    const triggers = asRecord(workflow.on, 'workflow triggers');
    const dispatch = asRecord(triggers.workflow_dispatch, 'workflow_dispatch trigger');
    const inputs = asRecord(dispatch.inputs, 'workflow_dispatch inputs');
    const workflowRun = asRecord(triggers.workflow_run, 'workflow_run trigger');
    const publishJob = workflowJob(workflow, 'publish');
    const publishEnv = asRecord(publishJob.env, 'publish env');
    const steps = jobSteps(publishJob, 'publish');
    const publish = stepIndex(steps, 'Publish public assets from Build Windows');
    const verify = stepIndex(steps, 'Verify published GitHub Release');

    expect(Object.keys(triggers).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(workflowRun.workflows).toEqual(['Build Windows']);
    expect(workflowRun.types).toEqual(['completed']);
    expect(inputs).toMatchObject({
      tag: { required: true, type: 'string' },
      run_id: { required: true, type: 'string' }
    });
    expect(publishJob.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(publishJob.if).toContain("startsWith(github.event.workflow_run.head_branch, 'v')");
    expect(publishEnv.RELEASE_TAG).toContain('github.event.workflow_run.head_branch');
    expect(publishEnv.RELEASE_RUN_ID).toContain('github.event.workflow_run.id');
    expect(steps.some((step) => step.name === 'Setup Node')).toBe(true);
    expect(steps.some((step) => step.name === 'Install')).toBe(true);
    expect(steps[publish].run).toContain('--from-run');
    expect(steps[publish].run).toContain('${RELEASE_RUN_ID}');
    expect(verify).toBeGreaterThan(publish);
    expect(steps[verify].run).toContain('npm run release:verify:remote');
  });

  it('keeps Worker production deployment manual, fixed-SHA, protected, ordered, and auditable', async () => {
    const workflow = await loadWorkflow('deploy-worker.yml');
    const triggers = asRecord(workflow.on, 'workflow triggers');
    const dispatch = asRecord(triggers.workflow_dispatch, 'workflow_dispatch trigger');
    const inputs = asRecord(dispatch.inputs, 'workflow_dispatch inputs');
    const prepare = workflowJob(workflow, 'prepare');
    const deploy = workflowJob(workflow, 'deploy');
    const prepareSteps = jobSteps(prepare, 'prepare');
    const deploySteps = jobSteps(deploy, 'deploy');
    const checkoutInputs = asRecord(
      findStep(prepareSteps, 'Checkout requested commit').with,
      'prepare checkout inputs'
    );
    const prepareCommitStep = findStep(prepareSteps, 'Verify exact commit');
    const deployCommitStep = findStep(deploySteps, 'Verify exact commit');
    const deployEnvironment = asRecord(deploy.environment, 'deploy environment');
    const deployEnv = asRecord(deploy.env, 'deploy env');

    expect(Object.keys(triggers)).toEqual(['workflow_dispatch']);
    expect(inputs.commit_sha).toMatchObject({ required: true, type: 'string' });
    expect(inputs.confirm_production).toMatchObject({ required: true, type: 'boolean' });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(prepare.environment).toBeUndefined();
    expect(JSON.stringify(prepare)).not.toContain('secrets.');
    expect(checkoutInputs.ref).toBe('${{ inputs.commit_sha }}');
    expect(asRecord(prepareCommitStep.env, 'prepare commit env')).toMatchObject({
      REQUESTED_COMMIT_SHA: '${{ inputs.commit_sha }}',
      WORKFLOW_COMMIT_SHA: '${{ github.sha }}',
      WORKFLOW_REF: '${{ github.ref }}'
    });
    expect(prepareCommitStep.run).toContain('git rev-parse HEAD');
    expect(prepareCommitStep.run).toContain('refs/heads/main');
    expect(prepareCommitStep.run).toContain('WORKFLOW_COMMIT_SHA');
    expect(prepareCommitStep.run).not.toContain('${{ inputs.commit_sha }}');
    expect(findStep(prepareSteps, 'Test Worker').run).toBe('npm run test:worker');
    expect(findStep(prepareSteps, 'Typecheck Worker').run).toBe('npm run typecheck:worker');
    expect(findStep(prepareSteps, 'Build Worker dry run').run).toBe('npm run build:worker');

    expect(deploy.needs).toBe('prepare');
    expect(deploy.if).toContain('inputs.confirm_production');
    expect(deployEnvironment.name).toBe('production-worker');
    expect(deployEnv.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(deployEnv.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(deployEnv.YOUYU_WORKER_DEPLOY_ENABLED).toBe('${{ vars.YOUYU_WORKER_DEPLOY_ENABLED }}');
    expect(asRecord(deployCommitStep.env, 'deploy commit env')).toMatchObject({
      REQUESTED_COMMIT_SHA: '${{ inputs.commit_sha }}',
      WORKFLOW_COMMIT_SHA: '${{ github.sha }}',
      WORKFLOW_REF: '${{ github.ref }}'
    });
    expect(deployCommitStep.run).toContain('refs/heads/main');
    expect(deployCommitStep.run).toContain('WORKFLOW_COMMIT_SHA');
    expect(deployCommitStep.run).not.toContain('${{ inputs.commit_sha }}');
    for (const step of [...prepareSteps, ...deploySteps]) {
      expect(String(step.run ?? ''), step.name).not.toContain('${{ inputs.commit_sha }}');
    }
    const readiness = stepIndex(deploySteps, 'Verify protected environment readiness');
    const ordered = [
      'Check remote schema',
      'Review remote migration plan',
      'Apply remote migrations',
      'Verify remote schema after apply',
      'Deploy Worker',
      'Smoke production route',
      'Write deployment audit summary'
    ].map((name) => stepIndex(deploySteps, name));
    expect(readiness).toBeLessThan(ordered[0]);
    expect(deploySteps[readiness].run).toContain('YOUYU_WORKER_DEPLOY_ENABLED');
    expect(deploySteps[readiness].run).toContain('enabled');
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(deploySteps[ordered[0]].run).toContain('--remote --check');
    expect(deploySteps[ordered[1]].run).toContain('--remote --dry-run');
    expect(deploySteps[ordered[2]].run).toContain('--remote --apply');
    expect(deploySteps[ordered[3]].run).toContain('--remote --check');
    for (const index of ordered.slice(0, 5)) {
      const remoteEnv = asRecord(deploySteps[index].env, `${deploySteps[index].name} env`);
      expect(remoteEnv.CLOUDFLARE_API_TOKEN).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
      expect(remoteEnv.CLOUDFLARE_ACCOUNT_ID).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    }
    expect(deploySteps[ordered[4]].run).toContain('npx --no-install wrangler deploy');
    expect(deploySteps[ordered[5]].run).toContain('https://youyu-api.fishknowsss.com/');
    expect(deploySteps[ordered[6]].run).toContain('GITHUB_STEP_SUMMARY');
  });
});
