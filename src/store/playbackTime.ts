import { create } from 'zustand';

export interface PlaybackTimeState {
  currentTime: number;
  duration: number;
  seekRevision?: number;
}

export const usePlaybackTimeStore = create<PlaybackTimeState>(() => ({
  currentTime: 0,
  duration: 0,
  seekRevision: 0,
}));

export const getPlaybackTimeSnapshot = (): PlaybackTimeState => {
  const { currentTime, duration } = usePlaybackTimeStore.getState();
  return { currentTime, duration };
};

export const setPlaybackCurrentTime = (currentTime: number): void => {
  usePlaybackTimeStore.setState({ currentTime });
};

// Explicit seeks must be distinguishable from ordinary clock ticks, including
// small seeks and seeking back to zero while paused.
export const noteLocalPlaybackSeek = (currentTime: number): void => {
  usePlaybackTimeStore.setState(state => ({ currentTime, seekRevision: (state.seekRevision ?? 0) + 1 }));
};

export const setPlaybackDuration = (duration: number): void => {
  usePlaybackTimeStore.setState({ duration });
};

export const setPlaybackTimeState = (state: Partial<PlaybackTimeState>): void => {
  usePlaybackTimeStore.setState(state);
};
