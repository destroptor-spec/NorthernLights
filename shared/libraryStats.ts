export interface LibraryDirectoryStats {
  path: string;
  totalTracks: number;
  withMetadata: number;
  analyzed: number;
  missingAnalysis: number;
  outdatedAnalysis: number;
}
