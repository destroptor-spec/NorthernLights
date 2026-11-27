import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import { ArtistDetail } from './ArtistDetail';

const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

it.each([[true, true, true], [false, false, false], [true, false, false], [false, true, false], [false, false, true]])('renders the first artist layout for Last.fm=%s, YouTube=%s, JamBase=%s', (popular, videos, shows) => {
    global.fetch = jest.fn(() => new Promise<Response>(() => {}));
    usePlayerStore.setState({
        hasLastFmKey: popular, hasYouTubeKey: videos, hasJamBaseKey: shows,
        youtubeEnabled: true, jambaseEnabled: true, currentUser: null,
    });
    render(<MemoryRouter initialEntries={['/library/artist/one']}>
        <Routes><Route path="/library/artist/:artistId" element={<ArtistDetail />} /></Routes>
    </MemoryRouter>);
    for (const [name, enabled] of [['Popular in your library', popular], ['Music videos', videos], ['Upcoming shows', shows]] as const) {
        expect(!!screen.queryByRole('heading', { name })).toBe(enabled);
    }
});
