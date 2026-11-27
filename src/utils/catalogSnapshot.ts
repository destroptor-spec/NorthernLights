import { get, set } from 'idb-keyval';
import { auroraApiRequest } from '../api/auroraApi';
import type { PlayerState } from '../store';

type Catalog = Pick<PlayerState, 'artists' | 'albums' | 'genres'>;
interface Snapshot extends Catalog { revision: string }

export async function loadCatalogSnapshot(userId: string, headers: Record<string, string>, signal: AbortSignal) {
  const key = `aurora-catalog-v1:${userId}`;
  const revision = async () => (await auroraApiRequest<{ revision: string }>('/catalog/revision', headers, {
    signal, cache: 'no-store',
  })).revision;
  const [stored, initial] = await Promise.all([
    get<Snapshot>(key).catch(() => undefined),
    revision().catch(() => undefined),
  ]);
  signal.throwIfAborted();
  return {
    catalog: initial && stored?.revision === initial ? stored : undefined,
    async save(catalog: Catalog) {
      if (initial && !signal.aborted && await revision() === initial && !signal.aborted) {
        await set(key, { ...catalog, revision: initial });
      }
    },
  };
}
