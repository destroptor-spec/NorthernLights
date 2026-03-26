declare module 'essentia.js' {
    export const EssentiaWASM: any;
    export class Essentia {
        constructor(wasmModule: any);
        arrayToVector(array: Float32Array): any;
        Energy(vector: any): { energy: number };
        Spectrum(vector: any): { spectrum: any };
        SpectralCentroidTime(vector: any): { centroid: number };
        DynamicComplexity(vector: any): { dynamicComplexity: number };
        PitchSalience(spectrum: any): { pitchSalience: number };
        Flux(spectrum: any): { flux: number };
        ZeroCrossingRate(vector: any): { zeroCrossingRate: number };
        Danceability(vector: any): { danceability: number };
    }
}
