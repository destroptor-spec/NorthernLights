import { getAuroraStatusNamespace } from './castNamespace';
export const CAST_DIAGNOSTICS_CAPABILITY = 'diagnostics';

interface DiagnosticsSession {
  sendMessage(namespace: string, message: unknown): Promise<unknown>;
  getApplicationMetadata?: () => { namespaces?: unknown } | null;
}

/** Bounded, idempotent delivery; a receiver status confirms application, not send(). */
export class CastDiagnosticsSync {
  private session: DiagnosticsSession | null = null;
  private enabled = false;
  private attempts = 0;
  private sentAt = -Infinity;
  private confirmed = false;
  private requestId = 0;

  acknowledge(session: DiagnosticsSession, requestId: unknown, enabled: unknown,
    log: (level: 'ok' | 'warn', message: string) => void) {
    if (session !== this.session || requestId !== this.requestId || enabled !== this.enabled || this.confirmed) return;
    this.confirmed = true;
    log('ok', `Receiver diagnostics confirmed: enabled=${enabled}`);
  }

  reset() {
    this.session = null;
  }

  sync(session: DiagnosticsSession, enabled: boolean, status: { caps?: string[]; diagnosticsVerbose?: boolean },
    log: (level: 'ok' | 'warn', message: string) => void, now = Date.now()) {
    if (!Array.isArray(status.caps) || !status.caps.includes(CAST_DIAGNOSTICS_CAPABILITY)) return;
    if (session !== this.session || enabled !== this.enabled) {
      this.session = session;
      this.enabled = enabled;
      this.attempts = 0;
      this.sentAt = -Infinity;
      this.confirmed = false;
      this.requestId += 1;
    }
    if (this.confirmed) return; // Another sender may subsequently change the setting.
    if (!this.attempts && status.diagnosticsVerbose === enabled) {
      this.confirmed = true;
      return;
    }
    if (now - this.sentAt < 5000) return;
    if (this.attempts >= 3) {
      this.confirmed = true; // Stop retrying; a new user change/session resets the budget.
      log('warn', 'Receiver diagnostics update was not confirmed; toggle again to retry.');
      return;
    }
    this.attempts += 1;
    this.sentAt = now;
    try {
      void session.sendMessage(getAuroraStatusNamespace(session), { type: 'aurora.diagnostics', enabled, requestId: this.requestId })
        .catch(() => log('warn', 'Could not send receiver diagnostics update.'));
    } catch {
      log('warn', 'Could not send receiver diagnostics update.');
    }
  }
}
