import { get, set } from 'idb-keyval';
import { auroraApiRequest } from '../api/auroraApi';
import { loadCatalogSnapshot } from './catalogSnapshot';

jest.mock('idb-keyval', () => ({ get: jest.fn(), set: jest.fn() }));
jest.mock('../api/auroraApi', () => ({ auroraApiRequest: jest.fn() }));
const catalog = { artists: [], albums: [], genres: [] };
beforeEach(() => jest.resetAllMocks());
it('reuses a complete catalog only after its account-scoped revision matches', async () => {
  jest.mocked(get).mockResolvedValue({ ...catalog, revision: 'one' });
  jest.mocked(auroraApiRequest).mockResolvedValue({ revision: 'one' });
  const result = await loadCatalogSnapshot('alice', {}, new AbortController().signal);
  expect(get).toHaveBeenCalledWith('aurora-catalog-v1:alice');
  expect(result.catalog).toMatchObject(catalog);
});
it('discards a changed revision and never persists a walk spanning a library change', async () => {
  jest.mocked(get).mockResolvedValue({ ...catalog, revision: 'old' });
  jest.mocked(auroraApiRequest).mockResolvedValueOnce({ revision: 'one' }).mockResolvedValueOnce({ revision: 'two' });
  const result = await loadCatalogSnapshot('alice', {}, new AbortController().signal);
  expect(result.catalog).toBeUndefined();
  await result.save(catalog);
  expect(set).not.toHaveBeenCalled();
});
