// Status streams must be closable before a PWA handoff: an older worker may
// still proxy them, and Chromium waits for those fetches before activating.
const streams = new Set<ServerEventStream>();
let suspensionCount = 0;

export class ServerEventStream {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private source: EventSource | null = null;
  private closed = false;

  constructor(private readonly url: string) {
    this.resume();
    streams.add(this);
  }

  resume() {
    if (this.closed || this.source || suspensionCount > 0) return;
    const source = new EventSource(this.url);
    this.source = source;
    source.onmessage = event => {
      if (this.source === source) this.onmessage?.(event);
    };
    source.onerror = event => {
      if (this.source === source) this.onerror?.(event);
    };
  }

  suspend() {
    const source = this.source;
    this.source = null;
    source?.close();
  }

  close() {
    this.closed = true;
    streams.delete(this);
    this.suspend();
  }
}

// Newly mounted status views also stay suspended until a failed update has
// released the lease. A successful update leaves streams closed until unload.
export function suspendServerEvents(): () => void {
  suspensionCount++;
  for (const stream of streams) stream.suspend();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspensionCount--;
    if (suspensionCount === 0) {
      for (const stream of streams) {
        try { stream.resume(); } catch {
          // One failed connection must not strand the other views or prevent
          // the updater from releasing its retry lock. Never log token URLs.
          console.warn('[PWA] Unable to reconnect a status stream.');
        }
      }
    }
  };
}
