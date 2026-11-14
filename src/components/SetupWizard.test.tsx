import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

var mockStoreState: Record<string, any>;

jest.mock('../store', () => {
  const usePlayerStore = (selector: (state: Record<string, any>) => unknown) => selector(mockStoreState);
  usePlayerStore.getState = () => mockStoreState;
  return { usePlayerStore };
});

import { SetupWizard } from './SetupWizard';

function setupStore(step: 'account' | 'analysis' | 'library') {
  mockStoreState = {
    setupStep: step,
    authToken: 'account-token',
    sseAccessToken: 'sse-token',
    createSetupAdmin: jest.fn().mockResolvedValue({ success: true }),
    updateSetupProgress: jest.fn().mockResolvedValue({ success: true }),
    finalizeSetup: jest.fn().mockResolvedValue({ success: true }),
    addLibraryFolder: jest.fn().mockResolvedValue({ success: true }),
    rescanLibrary: jest.fn().mockResolvedValue(undefined),
    getAuthHeader: jest.fn(() => ({ Authorization: 'Bearer account-token' })),
  };
}

describe('SetupWizard navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    globalThis.fetch = jest.fn() as jest.Mock;
  });

  it('keeps account creation required and validates both credentials', async () => {
    setupStore('account');
    render(<SetupWizard onComplete={jest.fn()} />);

    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /previous/i })).toBeNull();

    const submit = screen.getByRole('button', { name: /create admin account/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Admin username'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'twelve-chars!' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(mockStoreState.createSetupAdmin).toHaveBeenCalledWith('admin', 'twelve-chars!'));
  });

  it('allows analysis to be skipped but never navigates back to account creation', async () => {
    setupStore('analysis');
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        isDownloading: false,
        models: [
          { name: 'Discogs-EffNet', files: [{ filename: 'discogs-effnet-bs64-1.pb', size: 0, cached: false, downloading: false }] },
          { name: 'Danceability', files: [{ filename: 'danceability-discogs-effnet-1.pb', size: 0, cached: false, downloading: false }] },
          { name: 'Mood: happy', files: [{ filename: 'mood_happy-discogs-effnet-1.pb', size: 5_000_000, cached: true, downloading: false }] },
        ],
      }),
    });

    render(<SetupWizard onComplete={jest.fn()} />);
    const skip = await screen.findByRole('button', { name: /skip for now/i });
    // The network and its classifiers, as two rows.
    expect(screen.getByText('Discogs-EffNet')).toBeTruthy();
    expect(screen.getByText('Classifiers (2)')).toBeTruthy();
    expect(screen.getByText('1 of 2 missing')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /previous/i })).toBeNull();
    fireEvent.click(skip);

    await waitFor(() => expect(mockStoreState.updateSetupProgress).toHaveBeenCalledWith('library'));
  });

  it('requires a valid library submission, exposes Previous, and launches a background scan', async () => {
    setupStore('library');
    const onComplete = jest.fn();
    render(<SetupWizard onComplete={onComplete} />);

    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    const previous = screen.getByRole('button', { name: /previous/i });
    fireEvent.click(previous);
    await waitFor(() => expect(mockStoreState.updateSetupProgress).toHaveBeenCalledWith('analysis'));
    const submit = screen.getByRole('button', { name: /add library and launch/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Music directory'), { target: { value: '/srv/music' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(mockStoreState.addLibraryFolder).toHaveBeenCalledWith('/srv/music', { scan: false }));
    expect(mockStoreState.finalizeSetup).toHaveBeenCalledTimes(1);
    expect(mockStoreState.rescanLibrary).toHaveBeenCalledWith('/srv/music');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('stays on the library step when the server rejects the directory', async () => {
    setupStore('library');
    mockStoreState.addLibraryFolder.mockResolvedValue({
      success: false,
      error: 'Path does not exist or is not a directory',
    });
    const onComplete = jest.fn();
    render(<SetupWizard onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('Music directory'), { target: { value: '/missing/music' } });
    fireEvent.click(screen.getByRole('button', { name: /add library and launch/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('Path does not exist or is not a directory');
    expect(mockStoreState.finalizeSetup).not.toHaveBeenCalled();
    expect(mockStoreState.rescanLibrary).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
