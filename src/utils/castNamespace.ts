export const AURORA_STATUS_NAMESPACE = 'urn:x-cast:aurora.status';

/** Discover a running older receiver's namespace without tying Aurora to a host. */
export function getAuroraStatusNamespace(session: {
  getApplicationMetadata?: () => { namespaces?: unknown } | null;
}): string {
  try {
    const namespaces = session.getApplicationMetadata?.()?.namespaces;
    if (Array.isArray(namespaces)) {
      if (namespaces.includes(AURORA_STATUS_NAMESPACE)) return AURORA_STATUS_NAMESPACE;
      const legacy = namespaces.find((name: unknown): name is string =>
        typeof name === 'string' && name.startsWith('urn:x-cast:') && name.endsWith('.aurora.status'));
      if (legacy) return legacy;
    }
  } catch { /* Metadata can be absent during launch. */ }
  return AURORA_STATUS_NAMESPACE;
}
