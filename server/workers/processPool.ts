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

  constructor(
    private scriptPath: string,
    private poolSize: number,
    private cwd?: string
  ) {}

  public getActiveCount() {
    return this.activeCount;
  }

  public async init() {
    const tsxBin = path.resolve(__dirname, '../../node_modules/.bin/tsx');
    
    for (let i = 0; i < this.poolSize; i++) {
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
             // Expecting child process to emit at least { id: string, ...rest }
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
  }

  private handleResult(child: ChildProcess, result: any) {
    const task = this.workerTasks.get(child);
    if (task && task.id === result.id) {
       task.resolve(result);
       this.workerTasks.delete(child);
       this.activeCount--;
       this.freeWorkers.push(child);
       this.pump(); // Process next job
    }
  }

  public runJob(job: PoolJob): Promise<any> {
    return new Promise((resolve) => {
      this.jobQueue.push({ job, resolve });
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
