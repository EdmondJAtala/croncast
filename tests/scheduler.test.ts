import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, type AppConfig } from '../src/config.js';
import {
  startScheduler,
  stopScheduler,
  getJobStates,
  triggerJob,
  getActiveRecordings,
  stopRecording,
  stopAllRecordings,
} from '../src/scheduler.js';

function makeConfig(overrides: Record<string, unknown> = {}): AppConfig {
  return validateConfig({
    browserURL: 'http://localhost:9222',
    jobs: [
      { id: 'sched-1', name: 'scheduled-job', url: 'https://example.com', schedule: '0 0 * * *', durationSeconds: 10 },
      { id: 'manual-1', name: 'manual-job', url: 'https://example.com', durationSeconds: 10 },
    ],
    ...overrides,
  });
}

// Wait for async cleanup (recording promises to settle after abort)
function tick(ms = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Scheduler', () => {
  let config: AppConfig;

  beforeEach(async () => {
    // Ensure clean state: stop any lingering recordings and wait for async cleanup
    stopAllRecordings();
    await tick();
    stopScheduler();
    config = makeConfig();
    startScheduler(config);
  });

  afterEach(async () => {
    stopAllRecordings();
    await tick();
    stopScheduler();
  });

  describe('startScheduler', () => {
    it('initializes job states for all jobs', () => {
      const states = getJobStates();
      assert.equal(states.length, 2);
      assert.ok(states.find(s => s.name === 'scheduled-job'));
      assert.ok(states.find(s => s.name === 'manual-job'));
    });

    it('sets schedule and nextRun for scheduled jobs', () => {
      const states = getJobStates();
      const scheduled = states.find(s => s.name === 'scheduled-job')!;
      assert.equal(scheduled.schedule, '0 0 * * *');
      assert.ok(scheduled.nextRun);
    });

    it('sets null schedule for manual-only jobs', () => {
      const states = getJobStates();
      const manual = states.find(s => s.name === 'manual-job')!;
      assert.equal(manual.schedule, null);
      assert.equal(manual.nextRun, null);
    });
  });

  describe('triggerJob', () => {
    it('returns not found for unknown job id', () => {
      const result = triggerJob(config, 'nonexistent');
      assert.equal(result.triggered, false);
      assert.ok(result.reason?.includes('not found'));
    });

    it('triggers a valid job and prevents overlap', () => {
      // First trigger should succeed
      const first = triggerJob(config, 'manual-1');
      assert.equal(first.triggered, true);

      // Recording is now active (executeJob runs synchronously up to first await)
      assert.ok(getActiveRecordings().length > 0, 'should have an active recording after trigger');

      // Second trigger should be blocked (job is already recording)
      const second = triggerJob(config, 'manual-1');
      assert.equal(second.triggered, false);
      assert.ok(second.reason?.includes('already recording'));
    });
  });

  describe('stopRecording', () => {
    it('returns false for nonexistent recording id', () => {
      assert.equal(stopRecording('nonexistent'), false);
    });
  });

  describe('stopAllRecordings', () => {
    it('stops triggered recordings and returns count', () => {
      const result = triggerJob(config, 'manual-1');
      assert.equal(result.triggered, true);
      assert.ok(getActiveRecordings().length > 0);
      const count = stopAllRecordings();
      assert.ok(count >= 1);
    });
  });

  describe('stopScheduler', () => {
    it('clears all job states', () => {
      stopScheduler();
      assert.deepEqual(getJobStates(), []);
    });
  });
});
