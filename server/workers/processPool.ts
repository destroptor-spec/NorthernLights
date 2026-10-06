import type { ProcessingLogChannel } from '../../shared/logging';
import { logProcessing } from '../services/loggingConfig';
import { forwardWorkerLog } from '../services/workerLogging';
import { ChildProcess, spawn } from 'child_process';

export interface PoolJob {
  id: string;
  payload: unknown;
  label?: string;
}

interface PendingJob {
  job: PoolJob;
  startedAt?: number;
  resolve: (value: unknown) => void;
}

export class ChildProcessPool {
  private workers = new Set<ChildProcess>();
  private freeWorkers: ChildProcess[] = [];
  private jobQueue: PendingJob[] = [];
  private workerTasks = new Map<ChildProcess, PendingJob>();
  private terminated = false;
  private stoppedGroups = new WeakSet<ChildProcess>();
  private refillTimer?: ReturnType<typeof setTimeout>;

  constructor(private scriptPath: string, private poolSize: number, private cwd?: string, private logChannel?: ProcessingLogChannel) {}

  public getActiveCount() { return this.workerTasks.size; }
  public getWorkerCount() { return this.workers.size; }

  public async init() { this.fillPool(); }

  private fillPool() {
    if (this.terminated) return;
    while (this.workers.size < this.poolSize) this.spawnWorker();
    this.pump();
  }

  private spawnWorker() {
    // Avoid the tsx CLI's extra launcher process. Each worker owns a separate
    // process group so a wedged Python/ffmpeg descendant can be killed with it.
    const child = spawn(process.execPath, ['--import', 'tsx', this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'], cwd: this.cwd,
      detached: process.platform !== 'win32',
    });
    this.workers.add(child);
    this.freeWorkers.push(child);
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        try { this.handleResult(child, JSON.parse(line)); } catch { /* Non-protocol log line. */ }
      }
    });
    let stderrBuffer = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (!this.logChannel) { process.stderr.write(chunk); return; }
      stderrBuffer += chunk;
      const lines = stderrBuffer.split('\n');
      stderrBuffer = lines.pop() || '';
      for (const line of lines) forwardWorkerLog(this.logChannel, line);
      if (stderrBuffer.length > 65536) {
        forwardWorkerLog(this.logChannel, stderrBuffer);
        stderrBuffer = '';
      }
    });
    child.stderr?.on('end', () => {
      if (this.logChannel && stderrBuffer) forwardWorkerLog(this.logChannel, stderrBuffer);
    });
    child.stdin?.on('error', error => this.failWorker(child, error.message));
    child.on('error', error => this.failWorker(child, error.message));
    // Kill descendants on exit so inherited pipes cannot prevent close. Settle
    // on close, after final stdout has drained, to preserve a last valid reply.
    child.on('exit', () => this.killGroup(child));
    child.on('close', (code, signal) => this.failWorker(child, `Worker exited (code=${code}, signal=${signal})`));
  }

  private stopWorker(child: ChildProcess) {
    if (!this.workers.delete(child)) return;
    this.freeWorkers = this.freeWorkers.filter(worker => worker !== child);
    this.killGroup(child);
  }

  private killGroup(child: ChildProcess) {
    if (this.stoppedGroups.has(child)) return;
    this.stoppedGroups.add(child);
    if (!child.pid) return; // spawn failed, no process to stop
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        // Only groups created by this pool are targeted. SIGKILL also stops a
        // SIGSTOP'ed or native-inference-hung descendant; no delayed PID reuse.
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        console.error('[Pool] Failed to stop worker group:', error);
      }
    }
  }

  private failWorker(child: ChildProcess, reason: string) {
    if (!this.workers.has(child)) return; // error/close/write callback can race
    const task = this.workerTasks.get(child);
    this.workerTasks.delete(child);
    this.stopWorker(child);
    task?.resolve({ id: task.job.id, error: reason });
    // Back off on startup failures instead of continuously spawning processes.
    if (!this.terminated && !this.refillTimer) {
      this.refillTimer = setTimeout(() => {
        this.refillTimer = undefined;
        this.fillPool();
      }, 250);
    }
    this.pump();
  }

  public resize(newSize: number) {
    if (this.terminated) return;
    if (!Number.isInteger(newSize) || newSize < 0) throw new Error('Invalid worker pool size');
    this.poolSize = newSize;
    while (this.workers.size > newSize && this.freeWorkers.length) {
      this.stopWorker(this.freeWorkers[this.freeWorkers.length - 1]);
    }
    // Busy surplus workers retire on completion. Growing again cancels that
    // retirement automatically; there is no stale pending-kill counter.
    this.fillPool();
  }

  private handleResult(child: ChildProcess, result: { id?: string }) {
    const task = this.workerTasks.get(child);
    if (!task || result?.id !== task.job.id) return;
    this.workerTasks.delete(child);
    if (this.logChannel) logProcessing(this.logChannel, `[${this.logChannel}] Completed ${task.job.label || task.job.id} in ${Date.now() - (task.startedAt ?? Date.now())}ms`);
    task.resolve(result);
    if (this.stoppedGroups.has(child)) this.failWorker(child, 'Worker exited');
    else if (this.workers.size > this.poolSize) this.stopWorker(child);
    else this.freeWorkers.push(child);
    this.pump();
  }

  public runJob(job: PoolJob, timeoutMs = 300000): Promise<any> {
    if (this.terminated) return Promise.resolve({ id: job.id, error: 'Worker pool terminated' });
    return new Promise(resolve => {
      let settled = false;
      const pending: PendingJob = { job, resolve: value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      } };
      const timer = setTimeout(() => {
        this.jobQueue = this.jobQueue.filter(queued => queued !== pending);
        for (const [worker, task] of this.workerTasks) {
          if (task === pending) {
            this.failWorker(worker, `Job timed out after ${timeoutMs}ms`);
            break;
          }
        }
        pending.resolve({ id: job.id, error: `Job timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      this.jobQueue.push(pending);
      this.pump();
    });
  }

  private pump() {
    while (!this.terminated && this.jobQueue.length && this.freeWorkers.length) {
      const worker = this.freeWorkers.pop()!;
      const task = this.jobQueue.shift()!;
      task.startedAt = Date.now();
      this.workerTasks.set(worker, task);
      if (this.logChannel) logProcessing(this.logChannel, `[${this.logChannel}] Started ${task.job.label || task.job.id} (worker ${worker.pid})`);
      if (!worker.stdin || worker.stdin.destroyed || !worker.stdin.writable) {
        this.failWorker(worker, 'Child process stdin closed or destroyed');
        continue;
      }
      try {
        worker.stdin.write(JSON.stringify(task.job.payload) + '\n', error => {
          if (error) this.failWorker(worker, error.message);
        });
      } catch (error) {
        this.failWorker(worker, String(error));
      }
    }
  }

  public terminate() {
    this.terminated = true;
    clearTimeout(this.refillTimer);
    this.refillTimer = undefined;
    for (const task of [...this.jobQueue, ...this.workerTasks.values()]) {
      task.resolve({ id: task.job.id, error: 'Worker pool terminated' });
    }
    this.jobQueue = [];
    this.workerTasks.clear();
    for (const worker of this.workers) this.stopWorker(worker);
  }
}
