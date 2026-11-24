import { fireEvent, render, screen, within } from '@testing-library/react';
import { ArtistAboutSection } from './ArtistAboutSections';



const about = (patch: Partial<React.ComponentProps<typeof ArtistAboutSection>> = {}) => (
  <ArtistAboutSection
    artistName="Daysend"
    loading={false}
    roles={[]}
    stats={{ totalTracks: 0, totalAlbums: 0, totalDuration: 0 }}
    tags={[]}
    {...patch}
  />
);

describe('About {artist}', () => {
  it('keeps the kind with the name, then small-headed blocks: At a glance, Biography, Members, Tags', () => {
    render(about({
      bio: 'A metal band from Sydney.',
      members: ['Scott Bisset', 'Jarrod Anderson'],
      roles: [{ role: 'Performer' }, { role: 'Composer' }],
      type: 'Group', disambiguation: 'Australian metal band', area: 'Sydney, Australia', lifeSpan: { begin: '2002', end: '2011' },
      stats: { totalTracks: 11, totalAlbums: 1, totalDuration: 46 * 60 }, listeners: '14000',
      tags: [{ name: 'metalcore', isCommunity: true, providers: ['lastfm'], count: 100 }, { name: 'club', isCommunity: false }],
    }));

    const section = screen.getByRole('region', { name: 'About Daysend' });
    expect(within(section).getByRole('heading', { level: 3, name: 'About Daysend' })).toBeTruthy();
    const kind = within(section).getByText('Group', { exact: false, selector: '.about-card__kind' });
    expect(kind.textContent).toBe('Group – Australian metal band');

    // The blocks, in order, each with its small heading.
    expect(within(section).getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['At a glance', 'Biography', 'Members', 'Tags']);
    expect(within(section).getByText(/^Daysend is a group/).textContent).toBe(
      'Daysend is a group from Sydney, Australia, active from 2002 to 2011. '
      + 'Your library has 11 tracks from 1 album (46 min), where Daysend is credited as performer and composer. '
      + 'Last.fm counts 14K listeners.',
    );
    expect(within(section).getAllByRole('listitem').slice(0, 2).map(li => li.textContent)).toEqual(['Scott Bisset', 'Jarrod Anderson']);

    // The summary comes before the bio, the tags last.
    const bio = within(section).getByText('A metal band from Sydney.');
    const tags = within(section).getByRole('list', { name: 'Tags' });
    expect(within(section).getByText(/^Daysend is a group/).compareDocumentPosition(bio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tags).getByText('metalcore').getAttribute('title')).toBe('From Last.fm · 100');
    // Every tag in one style; only a provider's tag says where it is from.
    expect(within(tags).getByText('club').className).toBe(within(tags).getByText('metalcore').className);
    expect(within(tags).getByText('club').getAttribute('title')).toBeNull();
  });

  it('leaves out the blocks it has nothing for', () => {
    render(about({ bio: 'Short.', type: 'Group', lifeSpan: { begin: '1983' } }));
    expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual(['At a glance', 'Biography']);
    expect(screen.getByText('Daysend is a group, formed in 1983.')).toBeTruthy();
  });

  it('is a profile card: the portrait and name first, the initial without a picture', () => {
    const { container, rerender } = render(about({ imageUrl: 'https://img/daysend.jpg', type: 'Group' }));
    const card = container.querySelector('.about-card')!;
    expect(card.querySelector('.about-card__portrait img')?.getAttribute('src')).toBe('https://img/daysend.jpg');
    expect(within(card as HTMLElement).getByText('Daysend', { selector: '.about-card__name' })).toBeTruthy();

    rerender(about({ type: 'Group' }));
    expect(screen.getByRole('img', { name: 'Daysend artist initial' })).toBeTruthy();
  });

  it('opens a long bio with Read more, which says whether it is open', () => {
    render(about({ bio: 'Long bio.' })); // jsdom has no layout: unmeasured, Read more is offered
    const bio = screen.getByText('Long bio.');
    expect(bio.getAttribute('data-collapsed')).toBe('true');
    expect(bio.getAttribute('data-faded')).toBe('true');
    const more = screen.getByRole('button', { name: 'Read more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe(bio.id);
    fireEvent.click(more);
    expect(bio.getAttribute('data-collapsed')).toBeNull();
    expect(bio.getAttribute('data-faded')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('offers no Read more for a bio that fits', () => {
    const height = jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(96);
    const scroll = jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(96);
    render(about({ bio: 'German trance duo from Krefeld.' }));
    expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull();
    expect(screen.getByText('German trance duo from Krefeld.').getAttribute('data-faded')).toBeNull();
    height.mockRestore();
    scroll.mockRestore();
  });

  it('is left out when there is nothing to say, and shows placeholders while the bio loads', () => {
    const { rerender } = render(about());
    expect(screen.queryByRole('region', { name: 'About Daysend' })).toBeNull();
    rerender(about({ loading: true }));
    expect(screen.getByRole('region', { name: 'About Daysend' })).toBeTruthy();
  });
});
