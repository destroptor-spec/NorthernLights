/**
 * The audio model's style score in words. Bands from the dev library
 * (30,713 tracks, 2026-11-10): a track's strongest style has a median
 * score of 0.29, one in ten reach 0.63, and by its 8th style scores are
 * around 0.06. Strong is a top-style sound; Faint is background noise.
 */
export const scoreWord = (score: number): string =>
  score >= 0.5 ? 'Strong'
    : score >= 0.3 ? 'Clear'
      : score >= 0.15 ? 'Noticeable'
        : score >= 0.05 ? 'A hint'
          : 'Faint';
