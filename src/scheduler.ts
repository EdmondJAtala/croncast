import { Cron } from 'croner';
import path from 'node:path';
import { AppConfig, JobConfig } from './config.js';
import { record, makeTimestamp } from './recorder.js';

export interface JobState {
  id: string;
  name: string;
  schedule: string | null;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: 'success' | 'error' | null;
  lastError: string | null;
}

export interface RecordingInstance {
  id: string;
  jobName: string;
  startedAt: string;
  durationSeconds: number;
  outputPath: string;
  status: 'recording' | 'success' | 'error';
  error?: string;
}

const tasks = new Map<string, Cron>();
const jobStates = new Map<string, JobState>();
const activeRecordings = new Map<string, { instance: RecordingInstance; abort: AbortController }>();
const completedRecordings: RecordingInstance[] = [];

const MAX_COMPLETED = 50;

function sanitizeForFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

async function executeJob(config: AppConfig, job: JobConfig): Promise<void> {
  const state = jobStates.get(job.id!);
  if (!state) return;

  const timestamp = makeTimestamp();
  const safeName = sanitizeForFilename(job.name);
  const instanceId = `${safeName}_${timestamp}`;
  const outputPath = path.join(config.outputDir, `${instanceId}.mp4`);

  const instance: RecordingInstance = {
    id: instanceId,
    jobName: job.name,
    startedAt: new Date().toISOString(),
    durationSeconds: job.durationSeconds,
    outputPath,
    status: 'recording',
  };

  const ac = new AbortController();
  activeRecordings.set(instanceId, { instance, abort: ac });

  state.lastRun = instance.startedAt;

  try {
    const result = await record(config, job, outputPath, ac.signal);
    instance.status = result.success ? 'success' : 'error';
    if (result.error) instance.error = result.error;
    if (result.outputPath) instance.outputPath = result.outputPath;
    state.lastResult = result.success ? 'success' : 'error';
    state.lastError = result.error ?? null;
  } catch (err) {
    instance.status = 'error';
    instance.error = err instanceof Error ? err.message : String(err);
    state.lastResult = 'error';
    state.lastError = instance.error;
    console.error(`Job "${job.name}" failed: ${state.lastError}`);
  } finally {
    activeRecordings.delete(instanceId);
    completedRecordings.unshift(instance);
    if (completedRecordings.length > MAX_COMPLETED) {
      completedRecordings.length = MAX_COMPLETED;
    }
    const cronTask = tasks.get(job.id!);
    const next = cronTask?.nextRun();
    state.nextRun = next ? next.toISOString() : null;
  }
}

export function startScheduler(config: AppConfig): void {
  for (const job of config.jobs) {
    const state: JobState = {
      id: job.id!,
      name: job.name,
      schedule: job.schedule ?? null,
      nextRun: null,
      lastRun: null,
      lastResult: null,
      lastError: null,
    };
    jobStates.set(job.id!, state);

    if (!job.schedule) {
      console.log(`Job "${job.name}" has no schedule (manual only)`);
      continue;
    }

    try {
      // Validate by attempting to parse the expression
      const test = new Cron(job.schedule);
      test.stop();
    } catch {
      console.warn(`Invalid cron expression for job "${job.name}": ${job.schedule} — skipping`);
      continue;
    }

    const task = new Cron(job.schedule, {
      protect: true,   // Prevent overlapping executions of the same job
    }, () => {
      executeJob(config, job).catch(err => {
        console.error(`Unhandled error in job "${job.name}":`, err);
      });
    });
    tasks.set(job.id!, task);

    const nextRun = task.nextRun();
    state.nextRun = nextRun ? nextRun.toISOString() : null;

    console.log(`Scheduled job "${job.name}" (${job.schedule}), next run: ${state.nextRun}`);
  }
}

export function stopScheduler(): void {
  for (const [, task] of tasks) {
    task.stop();
  }
  tasks.clear();
  jobStates.clear();
}

export function restartScheduler(config: AppConfig): void {
  stopScheduler();
  startScheduler(config);
}

export function triggerJob(config: AppConfig, jobId: string): { triggered: boolean; reason?: string } {
  const job = config.jobs.find(j => j.id === jobId);
  if (!job) {
    console.error(`Cannot trigger: job id "${jobId}" not found`);
    return { triggered: false, reason: 'Job not found' };
  }
  // Prevent overlap: check if this job already has an active recording
  for (const [, entry] of activeRecordings) {
    if (entry.instance.jobName === job.name) {
      console.log(`Trigger skipped: job "${job.name}" is already recording`);
      return { triggered: false, reason: `Job "${job.name}" is already recording` };
    }
  }
  executeJob(config, job).catch(err => {
    console.error(`Unhandled error in triggered job "${job.name}":`, err);
  });
  return { triggered: true };
}

export function getActiveRecordings(): RecordingInstance[] {
  return Array.from(activeRecordings.values()).map(r => r.instance);
}

export function getCompletedRecordings(): RecordingInstance[] {
  return completedRecordings;
}

export function stopRecording(instanceId: string): boolean {
  const entry = activeRecordings.get(instanceId);
  if (entry) {
    entry.abort.abort();
    console.log(`Recording stopped: "${instanceId}"`);
    return true;
  }
  return false;
}

export function stopAllRecordings(): number {
  let count = 0;
  for (const [id, entry] of activeRecordings) {
    entry.abort.abort();
    console.log(`Recording stopped: "${id}"`);
    count++;
  }
  return count;
}

export function getJobStates(): JobState[] {
  return Array.from(jobStates.values());
}
