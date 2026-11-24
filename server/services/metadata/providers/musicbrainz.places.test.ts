/**
 * @jest-environment node
 */
import { mbReleaseRecordingPlaces } from './musicbrainz';
import { mbFetch } from '../../musicbrainz.service';

jest.mock('../../musicbrainz.service', () => ({ mbFetch: jest.fn() }));

const place = (id: string, name: string, area?: string) => ({ id, name, area: area ? { name: area } : undefined });
const rel = (type: string, p: ReturnType<typeof place>) => ({ 'target-type': 'place', type, place: p });
const geejam = place('g', 'Geejam Studios', 'Port Antonio');
const village = place('v', 'The Village', 'Los Angeles');

it('counts "recorded at" places over the recordings, most tracks first, once per recording', async () => {
  jest.mocked(mbFetch).mockResolvedValue({
    relations: [],
    media: [{ tracks: [
      { recording: { relations: [rel('recorded at', village), rel('recorded at', village), rel('mixed at', geejam)] } },
      { recording: { relations: [rel('recorded at', geejam), rel('recorded at', village)] } },
      { recording: { relations: [rel('recorded at', geejam)] } },
      { recording: { relations: [rel('recorded at', geejam)] } },
    ] }],
  });
  expect(await mbReleaseRecordingPlaces('rel')).toEqual([
    { name: 'Geejam Studios', area: 'Port Antonio', tracks: 3 },
    { name: 'The Village', area: 'Los Angeles', tracks: 2 },
  ]);
  expect(jest.mocked(mbFetch).mock.calls[0][0]).toContain('inc=place-rels+recordings+recording-level-rels');
});

it('counts a place on the release itself for every track, and is empty when none are entered', async () => {
  jest.mocked(mbFetch).mockResolvedValue({ relations: [rel('recorded at', place('a', 'Abbey Road Studios'))], media: [{ tracks: [{ recording: {} }, { recording: {} }] }] });
  expect(await mbReleaseRecordingPlaces('rel')).toEqual([{ name: 'Abbey Road Studios', area: null, tracks: 2 }]);
  jest.mocked(mbFetch).mockResolvedValue({ media: [{ tracks: [{ recording: { relations: [] } }] }] });
  expect(await mbReleaseRecordingPlaces('rel')).toEqual([]);
});
