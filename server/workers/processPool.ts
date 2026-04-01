import { ChildProcess, spawn } from 'child_process';
import path from 'path';

export interface PoolJob {
  id: string; // unique identifier for the job
  payload: any;
}

export class ChildProcessPool {
  private workers: ChildProcess[] = [];
  private freeWorkers: ChildProcess[] = [];
  private jobQueue: { job: PoolJob; resolve: (val: any) => void }[] = [];
  private workerTasks = new Map<ChildProcess, { id: string; resolve: (val: any) => void }>();
  private activeCount = 0;
  private pendingKills = 0;

  constructor(
    private scriptPath: string,
    private poolSize: number,
    private cwd?: string
  ) {}

  public getActiveCount() {
    return this.activeCount;
  }

  // Total spawned worker processes (idle + busy). Use this for UI display.
  public getWorkerCount() {
    return this.workers.length;
  }

  public async init() {
    for (let i = 0; i < this.poolSize; i++) {
       this.spawnWorker();
    }
  }

  private spawnWorker() {
    const tsxBin = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    const child = spawn(tsxBin, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd
    });

    let stdoutBuffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const result = JSON.parse(line);
          this.handleResult(child, result);
        } catch {
          // ignore parse errors
        }
      }
    });

    child.stderr?.on('data', (data) => {
       process.stderr.write(`[Worker ${path.basename(this.scriptPath)}] ${data.toString()}`);
    });

    child.on('exit', () => {
      this.workers = this.workers.filter(w => w !== child);
      this.freeWorkers = this.freeWorkers.filter(w => w !== child);
    });

    this.workers.push(child);
    this.freeWorkers.push(child);
  }

  public resize(newSize: number) {
    if (newSize === this.poolSize) return;
    
    if (newSize > this.poolSize) {
      const diff = newSize - this.poolSize;
      for (let i = 0; i < diff; i++) {
        this.spawnWorker();
      }
      this.poolSize = newSize;
      this.pump();
    } else {
      const diff = this.poolSize - newSize;
      this.poolSize = newSize;
      this.pendingKills += diff;
      
      // Kill free workers immediately if possible
      while (this.pendingKills > 0 && this.freeWorkers.length > 0) {
        const worker = this.freeWorkers.pop()!;
        worker.kill();
        this.pendingKills--;
      }
    }
  }

  private handleResult(child: ChildProcess, result: any) {
    const task = this.workerTasks.get(child);
    if (task && task.id === result.id) {
       task.resolve(result);
       this.workerTasks.delete(child);
       this.activeCount--;
       
       if (this.pendingKills > 0) {
         child.kill();
         this.pendingKills--;
       } else {
         this.freeWorkers.push(child);
         this.pump(); // Process next job
       }
    }
  }

  public runJob(job: PoolJob, timeoutMs = 120000): Promise<any> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove from queue if still pending
        const qIdx = this.jobQueue.findIndex(j => j.job.id === job.id);
        if (qIdx !== -1) {
          this.jobQueue.splice(qIdx, 1);
        }
        // Kill the worker if it was processing this job
        for (const [worker, task] of this.workerTasks) {
          if (task.id === job.id) {
            this.workerTasks.delete(worker);
            this.activeCount--;
            worker.kill();
            break;
          }
        }
        resolve({ id: job.id, error: `Job timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      const wrappedResolve = (val: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      };

      this.jobQueue.push({ job, resolve: wrappedResolve });
      this.pump();
    });
  }

  private pump() {
    if (this.jobQueue.length > 0 && this.freeWorkers.length > 0) {
      const worker = this.freeWorkers.pop()!;
      const { job, resolve } = this.jobQueue.shift()!;
      this.activeCount++;
      this.workerTasks.set(worker, { id: job.id, resolve });

      if (worker.stdin && !worker.stdin.destroyed) {
         worker.stdin.write(JSON.stringify(job.payload) + '\n');
      } else {
         resolve({ id: job.id, error: 'Child process stdin closed or destroyed' });
      }
    }
  }

  public terminate() {
    for (const worker of this.workers) {
      worker.kill();
    }
    this.workers = [];
    this.freeWorkers = [];
    this.jobQueue = [];
    this.workerTasks.clear();
    this.activeCount = 0;
  }
}
