import { initDB } from './index';

// Picture sets from the metadata providers for the About cards' carousels:
// an artist's hero images (wide backgrounds) and an album's artwork beyond its
// front cover. Looked up when a page is first opened and kept on the row with
// when they were read, so they're asked again after a while
// (services/metadata: getArtistHeroImages / getAlbumArtworkImages).

export interface StoredProviderImage {
  url: string;
  provider: string | null;
  /** What the picture is ("Back", "Booklet"), when the provider says. */
  label: string | null;
}

export interface ArtistHeroImageSource {
  name: string;
  /** The artist's own MBID, else one from their tracks' tags. */
  mbid: string | null;
  /** The banner the artist lookup chose (artists.artwork_url). */
  artworkUrl: string | null;
  images: StoredProviderImage[] | null;
  readAt: Date | null;
}

export async function getArtistHeroImageSource(artistId: string): Promise<ArtistHeroImageSource | null> {
  const db = await initDB();
  const res = await db.query(
    `SELECT a.name, a.artwork_url, a.hero_images, a.hero_images_read_at,
            COALESCE(a.mbid, (SELECT t.mb_artist_id FROM tracks t
                               WHERE t.artist_id = a.id AND t.mb_artist_id IS NOT NULL LIMIT 1)) AS mbid
       FROM artists a WHERE a.id = $1`,
    [artistId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { name: row.name, mbid: row.mbid || null, artworkUrl: row.artwork_url || null, images: row.hero_images ?? null, readAt: row.hero_images_read_at ?? null };
}

export async function storeArtistHeroImages(artistId: string, images: StoredProviderImage[]): Promise<void> {
  const db = await initDB();
  await db.query('UPDATE artists SET hero_images = $2::jsonb, hero_images_read_at = NOW() WHERE id = $1', [artistId, JSON.stringify(images)]);
}

export interface AlbumArtworkImageSource {
  title: string;
  artist: string;
  /** The release most of its files are tagged with. */
  releaseId: string | null;
  /** The release group its files (or the album row) name. */
  releaseGroupId: string | null;
  images: StoredProviderImage[] | null;
  readAt: Date | null;
}

export async function getAlbumArtworkImageSource(albumId: string): Promise<AlbumArtworkImageSource | null> {
  const db = await initDB();
  const res = await db.query(
    `SELECT al.title, al.artist_name, al.artwork_images, al.artwork_images_read_at,
            (SELECT t.mb_album_id FROM tracks t WHERE t.album_id = al.id AND t.mb_album_id IS NOT NULL
              GROUP BY t.mb_album_id ORDER BY COUNT(*) DESC, t.mb_album_id ASC LIMIT 1) AS release_id,
            COALESCE((SELECT t.mb_release_group_id FROM tracks t WHERE t.album_id = al.id AND t.mb_release_group_id IS NOT NULL
              GROUP BY t.mb_release_group_id ORDER BY COUNT(*) DESC, t.mb_release_group_id ASC LIMIT 1),
              al.mb_release_group_id) AS release_group_id
       FROM albums al WHERE al.id = $1`,
    [albumId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    title: row.title, artist: row.artist_name || '', releaseId: row.release_id || null, releaseGroupId: row.release_group_id || null,
    images: row.artwork_images ?? null, readAt: row.artwork_images_read_at ?? null,
  };
}

export async function storeAlbumArtworkImages(albumId: string, images: StoredProviderImage[]): Promise<void> {
  const db = await initDB();
  await db.query('UPDATE albums SET artwork_images = $2::jsonb, artwork_images_read_at = NOW() WHERE id = $1', [albumId, JSON.stringify(images)]);
}
