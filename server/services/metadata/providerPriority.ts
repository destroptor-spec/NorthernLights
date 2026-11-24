import { getSystemSetting } from '../../database';
import { normaliseMetadataProviderPriority, type MetadataProviderPriority } from '../../../shared/metadataProviders';

/**
 * The admin's provider order for each item (Settings → Metadata). Until it is
 * saved once, it follows the old single-choice settings it replaced.
 */
export async function getMetadataProviderPriority(): Promise<MetadataProviderPriority> {
  return normaliseMetadataProviderPriority(await getSystemSetting('metadataProviderPriority'), {
    providerArtistImage: await getSystemSetting('providerArtistImage'),
    providerArtistArtwork: await getSystemSetting('providerArtistArtwork'),
    providerArtistBio: await getSystemSetting('providerArtistBio'),
    providerAlbumArt: await getSystemSetting('providerAlbumArt'),
  });
}
