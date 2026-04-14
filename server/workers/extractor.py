import sys
import json
import numpy as np
from essentia.standard import (
    MonoLoader, 
    TensorflowPredictMusiCNN, 
    TensorflowPredictEffnetDiscogs,
    Energy, DynamicComplexity, PitchSalience, Flux, ZeroCrossingRate, RhythmExtractor2013, SpectralCentroidTime
)

def extract_features(file_path, musicnn_pb, effnet_pb):
    try:
        # 1. Load Audio for ML (16kHz required by MusiCNN and EffNet)
        audio_16k = MonoLoader(filename=file_path, sampleRate=16000, resampleQuality=4)()
        
        # 2. Discogs-EffNet (128D Neural Embedding)
        effnet_model = TensorflowPredictEffnetDiscogs(graphFilename=effnet_pb, output="PartitionedCall:1")
        embeddings = effnet_model(audio_16k)
        # Average frame-wise embeddings and L2 normalize for Cosine Distance
        mean_emb = np.mean(embeddings, axis=0)
        norm = np.linalg.norm(mean_emb)
        effnet_vector = (mean_emb / norm).tolist() if norm > 0 else mean_emb.tolist()
        
        # 3. MusiCNN (Classification Tags)
        musicnn_model = TensorflowPredictMusiCNN(graphFilename=musicnn_pb)
        tags = musicnn_model(audio_16k)
        mean_tags = np.mean(tags, axis=0)
        
        # MusiCNN indices (based on MSD tag mappings)
        acousticness = float(mean_tags[29])
        instrumentalness = float(mean_tags[23])
        danceability = float(mean_tags[49]) # 'Danceable' tag
        
        # 4. Standard DSP Features (Requires 44.1kHz for accurate spectral data)
        audio_44k = MonoLoader(filename=file_path, sampleRate=44100, resampleQuality=4)()
        
        energy = float(Energy()(audio_44k))
        centroid = float(SpectralCentroidTime()(audio_44k))
        percussiveness = float(DynamicComplexity()(audio_44k)[0])
        zcr = float(ZeroCrossingRate()(audio_44k))
        bpm = float(RhythmExtractor2013()(audio_44k)[0])
        
        # Calculate safe Z-Scores (using neutral fallbacks for simplicity, matching your JS logic)
        def z_score(val, max_val):
            return max(0.0, min(1.0, val / max_val))
            
        acoustic_vector = [
            z_score(energy, 100),            # Energy
            z_score(centroid, 10000),        # Brightness
            z_score(percussiveness, 50),     # Percussiveness
            0.5,                             # Pitch Salience (Simplified)
            instrumentalness,                # Instrumentalness (ML)
            acousticness,                    # Acousticness (ML)
            danceability,                    # Danceability (ML)
            z_score(bpm, 200)                # Tempo
        ]
        
        output = {
            "bpm": round(bpm),
            "acoustic_vector": acoustic_vector,
            "embedding_vector": effnet_vector,
            "is_simulated": False
        }
        
        print(json.dumps(output))
        
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Missing arguments"}), file=sys.stderr)
        sys.exit(1)
    extract_features(sys.argv[1], sys.argv[2], sys.argv[3])
