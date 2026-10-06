import { availableParallelism } from 'os';

// Settings select processes. Native library thread counts are independent and
// must not silently reduce an explicitly selected process count.
export function analysisWorkerCount(setting: string | null | undefined, cpuCount = availableParallelism()): number {
  switch (setting) {
    case 'Background': return 1;
    case 'Balanced': return 4;
    case 'Performance': return 8;
    case 'Intensive': return 16;
    case 'Maximum': return Math.max(1, cpuCount);
    default: return 4;
  }
}
