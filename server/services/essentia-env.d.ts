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
        RhythmExtractor2013(vector: any): { bpm: number; beats: any; confidence: number };
        Loudness(vector: any): { loudness: number };
        FrameGenerator(vector: any, frameSize: number, hopSize: number): any;
    }

    export const EssentiaModel: any;
}

declare module 'essentia.js-model' {
    export class EssentiaTFInputExtractor {
        constructor(wasmModule: any, extractorType: 'musicnn' | 'vggish' | 'tempocnn', isDebug?: boolean);
        arrayToVector(array: Float32Array): any;
        vectorToArray(vector: any): Float32Array;
        compute(audioFrame: Float32Array): {
            melSpectrum: Float32Array;
            frameSize: number;
            patchSize: number;
            melBandsSize: number;
        };
        computeFrameWise(audioSignal: Float32Array, hopSize?: number): {
            melSpectrum: Float32Array;
            frameSize: number;
            patchSize: number;
            melBandsSize: number;
        };
        delete(): void;
        shutdown(): void;
    }

    export class EssentiaTensorflowJSModel {
        constructor(tfjs: any, modelPath: string, verbose?: boolean);
        initialize(): Promise<void>;
        predict(features: {
            melSpectrum: Float32Array;
            frameSize: number;
            patchSize: number;
            melBandsSize: number;
        }, padding?: boolean): Promise<number[][]>;
        dispose(): void;
    }

    export class TensorflowMusiCNN extends EssentiaTensorflowJSModel {
        constructor(tfjs: any, modelUrl: string, verbose?: boolean);
    }

    export class TensorflowVGGish extends EssentiaTensorflowJSModel {
        constructor(tfjs: any, modelUrl: string, verbose?: boolean);
    }
}
