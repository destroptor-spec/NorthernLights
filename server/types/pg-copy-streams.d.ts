declare module 'pg-copy-streams' {
  import { Transform } from 'stream';
  export function from(sql: string, options?: any): Transform;
  export function to(sql: string, options?: any): Transform;
}
