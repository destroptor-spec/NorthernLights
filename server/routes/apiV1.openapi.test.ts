import fs from 'fs';
import path from 'path';
import { generateAuroraApiDocument } from '../api/v1/openapi';

describe('Aurora API v1 OpenAPI inventory', () => {
  it('contains every implemented route and no removed routes', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/apiV1.routes.ts'), 'utf8');
    const implemented = Array.from(source.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g))
      .map(match => `${match[1].toUpperCase()} ${match[2].replace(/:([A-Za-z]+)/g, '{$1}')}`)
      .sort();
    const document = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'docs/openapi/aurora-v1.json'), 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = Object.entries(document.paths).flatMap(([routePath, operations]) =>
      ['get', 'post', 'put', 'patch', 'delete']
        .filter(method => operations[method])
        .map(method => `${method.toUpperCase()} ${routePath}`)
    ).sort();

    expect(documented).toEqual(implemented);
  });

  it('describes the concrete playlist and revision-delete response contracts', () => {
    const document = generateAuroraApiDocument() as any;
    const dataRef = (routePath: string, method: string, status = '200') =>
      document.paths[routePath][method].responses[status].content['application/json'].schema
        .properties.data.$ref;

    expect(dataRef('/playlists/{id}/state', 'patch')).toBe('#/components/schemas/Playlist');
    expect(dataRef('/hub/artist-radio', 'post')).toBe('#/components/schemas/Playlist');
    expect(dataRef('/hub/custom', 'post', '201')).toBe('#/components/schemas/Playlist');
    expect(document.paths['/playback-sessions/{id}'].delete.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/PlaybackSessionDelete');
  });

  // The Playlists page partitions its rails by generationSource, and the detail
  // hero picks the Wrapped cover from it. It was absent from the v1 Playlist DTO
  // when the store migrated off the legacy endpoint, which silently emptied the
  // Wrapped and Radios rails, so the contract is pinned here.
  it('exposes the playlist generation source clients group rails by', () => {
    const document = generateAuroraApiDocument() as any;
    const playlist = document.components.schemas.Playlist;

    expect(playlist.properties.generationSource).toEqual({ $ref: '#/components/schemas/PlaylistGenerationSource' });
    expect(playlist.required).toContain('generationSource');
    expect(document.components.schemas.PlaylistGenerationSource.enum).toEqual(
      expect.arrayContaining(['manual', 'hub', 'system', 'artist-radio', 'wrapped'])
    );
  });

  it('keeps collection pagination and pairing polling bounded at their sources', () => {
    const routes = fs.readFileSync(path.resolve(process.cwd(), 'server/routes/apiV1.routes.ts'), 'utf8');
    const database = fs.readFileSync(path.resolve(process.cwd(), 'server/database/index.ts'), 'utf8');

    expect(routes).toContain("keyPrefix: 'api-v1-pairing-exchange'");
    expect(routes).toContain('max: 240');
    expect(routes).toContain('keyGenerator: (req) =>');
    expect(routes).toContain('getAlbumsPage({ limit: pagination.limit + 1');
    expect(database).toContain('WITH page_albums AS');
    expect(database).toContain('WITH page_genres AS');
  });
});
