import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { initDB } from '../database';

/**
 * Executes a PostgreSQL query with exponential backoff on transient errors.
 * Transient errors include: 
 * - Connection resets (ECONNRESET)
 * - Deadlocks (40P01)
 * - Serialization failures (40001)
 */
export async function queryWithRetry<T extends QueryResultRow = any>(
  queryText: string,
  values: any[] = [],
  maxRetries = 3,
  initialDelay = 1000,
  slowQueryThresholdMs = 5000
): Promise<QueryResult<T>> {
  const pool = await initDB();
  let lastError: any;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await pool.query<T>(queryText, values);
      const elapsed = Date.now() - startTime;
      if (elapsed > slowQueryThresholdMs) {
        console.warn(`[DB] Slow query detected (${elapsed}ms): ${queryText.substring(0, 100)}...`);
      }
      return result;
    } catch (err: any) {
      lastError = err;
      
      const isTransient = 
        err.code === '40P01' || // Deadlock
        err.code === '40001' || // Serialization failure
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('Connection terminated unexpectedly') ||
        err.message?.includes('Client was closed or destroyed');

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const delay = initialDelay * Math.pow(2, attempt);
      console.warn(`[DB] Query failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Executes a function within a transaction with retry logic.
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000
): Promise<T> {
  const pool = await initDB();
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK');
      lastError = err;

      const isTransient = 
        err.code === '40P01' || 
        err.code === '40001' ||
        err.message?.includes('ECONNRESET');

      if (!isTransient || attempt === maxRetries) {
        throw err;
      }

      const delay = initialDelay * Math.pow(2, attempt);
      console.warn(`[DB] Transaction failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    } finally {
      client.release();
    }
  }

  throw lastError;
}
