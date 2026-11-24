# Changelog

## [Unreleased]

### Improvements
- **More about each release:** the album page's At a glance also gives the catalog number and barcode, says when a release is a promotional copy or a bootleg, and where the album was recorded (from MusicBrainz, looked up the first time the album is opened). Discs with their own title show it in place of "Disc 2" ("B-Sides & Bonus Tracks"), explicit tracks carry an E, and the ℗ line sits after the last track. Where the Cover Art Archive has no scan of the disc, the disc that rolls out of the cover can now be fanart.tv's or TheAudioDB's picture of it, if they're in your Album art providers.
- **The release on the album page:** Aurora now reads the record label, the release date, the original release date and the medium (CD, vinyl, digital) from your files. The album's About card opens with "At a glance": "Wasting Light is an album by Foo Fighters, released on 12 April 2011 by RCA Records. Your copy is the CD release.", and says when a reissue first came out. When there's no scan of the real disc, the disc that rolls out of the cover looks like a CD for CD releases. Files already in your library are read again in the background once, after the update.
- **Now-playing chip on the picture:** on the album page it sits on the cover's bottom-left corner, on the artist page centred at the foot of the portrait, instead of beside the title.
- **Album page:** The album's genres and styles move from the header to a "Genres and styles" section after the last track, as cards like on the artist page. Below it, an "About {album}" card like the artist's holds what was under the header: the cover and title, the album's description under Read more, and its tags (the genres in your files and Last.fm's tags, in one style). On wider screens the header leaves room for the record that rolls out of the cover, so the title and buttons no longer sit over it.
- **A calmer artist page:** the top keeps just the artist's name and the Play, Radio and Links buttons. The bio, members, credited roles, country, years, library stats and tags move to a new "About {artist}" card above Similar artists: the artist's picture and name with Group or Person beside them, then small-headed blocks across the card's width: At a glance (a short summary written from what Aurora knows: "Daysend is a group from Sydney, Australia, active from 2002 to 2011. Your library has 11 tracks from 1 album (46 min), where Daysend is credited as performer and composer."), Biography (two lines until Read more, three on a phone), Members and Tags. The card takes its light from the artist's picture: a soft glow of its strongest colour behind the portrait, as a track's cover lights its rays page. A long bio fades out under Read more; a short one has no Read more. A new "Genres and styles" section below Similar artists shows the artist's genres and styles as cards, like "Sounds close to" on a track's rays: open one, or shuffle it.
- **Artist pictures fill in as you look:** an artist shown with initials (the Artists grid, search, Browse, Similar artists, Aurora rays) or as an icon on the Hub is looked up in the background straight away, ahead of the rest of the library, and its picture appears on the card once it's found. Lookups still go at the providers' slow pace, newest on screen first.
- **TheAudioDB and fanart.tv:** two new metadata providers, set up in their own tabs under Settings → Metadata (TheAudioDB's free key is `123`; fanart.tv needs a free project key). Both add artist pictures, artist banners and album covers to the provider lists; TheAudioDB adds artist bios too. TheAudioDB also fills in an artist's country, years active and website when MusicBrainz has none, and shows its genre, style and mood among the artist's tags (they don't change genres or playlists). fanart.tv finds artists and albums by their MusicBrainz id; for albums it uses the release group id in your files' tags, so it needs no MusicBrainz lookup for tagged albums.
- **Choose several metadata providers, in your order:** in Settings → Metadata, artist images, artist banners, artist bios and album art each have their own list of providers. Aurora asks them from the top and keeps the first one that has it. Drag to reorder, × to stop asking a provider, and Add provider for one you've set up that the list lacks. Your earlier choices carry over as the first provider, with the others after it.
- **See what comes in and what goes out:** hover the signal-chain chip by the artist name to see the file as it is and what the stream carries, e.g. `FLAC 24-bit/96 kHz → AAC 128k @ 48 kHz → Stue`, or `MP3 320k @ 44.1 kHz` for a lossy file. A stream that passes the file through unchanged says so. New for apps: `GET /api/v1/tracks/{id}/stream-format`.
- **A tidier header row:** Search and the button with your name and avatar now look like the tabs and Settings beside them (same height, background and border), and your menu opens in the same style as the other menus (a sheet on phones).
- **Sleep timer in your menu:** the sleep timer moved from Settings → Playback to the menu under your name (beside Sign out). Set it on a slider from 10 to 90 minutes; while it runs, the menu shows the time left and an ✕ to cancel. One timer at a time: cancel it to set another.
- **The queue sidebar moves smoothly:** things that appear or go fold open and shut, as in the Connect card: a gig to join, Start Gig and your gig's controls, the Next in Queue section when you queue something, tracks you add or remove, and the song that just played as the next one takes its place. Starting a whole new album still just switches.
- **Queue on phones:** the queue in Now Playing starts at the song that plays and runs down from there (played songs are in Recently played). Songs you added with Play next or Add to queue have a small Q before their title. Its heading says Queue, with "Playing from <album or playlist>" under it, and the Queue and Recently played tabs sit at the bottom of the screen, as on desktop. The song that plays can't be dragged, and nothing can be dropped onto it.
- **Join a gig from the queue sidebar:** on desktop, gigs you can join now show at the top of the queue sidebar as "Join Bo's Gig", with Bo's avatar and a slowly turning light round the button, and so does a gig you're already in on another device. While you're a guest, the sidebar shows whose gig it is and Leave. On phones it stays in Connect.
- **Album menu:** albums have a menu too (⋯ on the cover, right-click, or a long press on phones): Play Album, Add to Queue (all its tracks, behind the ones you queued) and Add to Playlist.
- **Menus stand out more:** in dark mode menus are a little lighter than the page behind them.
- **Who queued what, in a gig:** tracks someone queued by hand carry their avatar in the desktop queue, and they stay in Next in Queue on every device, for guests too. A guest's Add to queue now lands behind the tracks already queued, as it does for you.
- **Recently played:** the desktop queue sidebar has two tabs at its foot, Queue and Recently played. Recently played lists the songs you played last, on any device (phone, Symfonium, Cast), newest first and each once; scroll down for more. Tap one to play the list from there.
- **New queue sidebar on desktop:** the queue now reads top to bottom as Current track, Next in Queue (the tracks you added yourself), then "Next from: <album or playlist>" and Infinity's picks. Add to queue now puts a track behind the ones you added, so it plays before the rest of the album instead of after it; Play next still puts it first. Drag a track into or out of your tracks to queue or unqueue it. Rows are quieter: cover, title and artists, with a drag handle on the cover and ⋯ on hover (Remove from queue and Like are in that menu). Save and Clear moved into the ⋯ next to "Now playing". Listen together moved here on desktop too: Start Gig under the title, and while your gig runs, everyone in it, Invite, Guest permissions, Open session and End gig. On phones, and with the sidebar collapsed, the gig stays in Connect.
- **One hover for cards:** album, playlist and music video cards, and the similar artists on an artist's page, now react like the Hub's "Uniquely yours" cards: the card rises slightly, its name turns green and Play slides in at the cover's corner, instead of the cover zooming and darkening. On phones and tablets there is no hidden Play button over the cover any more, so tapping a card always opens it. Play buttons (the player's, and the big Play buttons on album and artist pages) no longer grow on hover; their colour changes, and they still give a little when pressed.
- **Aurora keeps its own logs:** the server now writes and rotates its logs itself, however it runs (PM2, systemd, Docker): everything in `logs/production.log`, and each area's errors in its own file (scanner, analyzer, loudness) even when that area's detailed logging is off. Files rotate at 50 MB, keep 5, and expire after 30 days, all adjustable in `.env`. A new Log level in Settings → System → Logging chooses Warnings and errors, Info or Debug; errors and warnings are always recorded. Logs that used to grow forever (Cast receiver, sign-ins, Subsonic requests) are now bounded too, and a harmless Essentia message that filled the error log during analysis is no longer logged.
- **First-run setup:** the analysis step describes how Aurora listens today (one network and its classifiers for styles, sound and moods), shows them as two rows instead of a list of files, and downloads only the models that are missing.
- **Large libraries:** the genre and style rebuild no longer fails on very large libraries (it stopped on a time limit at around 95,000 tracks), and AI playlists no longer pause for several seconds on a large library after a quiet spell.
- **Better artist radio:** an artist radio now keeps to the artist's sound and styles (a hip hop radio stays hip hop, a trance radio stays trance) and plays music only: no skits, interludes, a cappella versions, drum solos, hidden tracks or hour-long recordings, and only one version of each song, however many remixes you have. A blind listening test preferred it 3 to 2.
- **Discover mixes by style and original year:** "Your … favourites" and "Rediscover …" now go by Aurora's styles (Trance, Progressive House, Hip Hop) instead of each song's single genre tag, so a song counts under every style it really is. Decade mixes go by the year a song first came out, so a 2012 reissue of a 2006 hit is in the 2000's. The decade-and-style mixes ("House from the 2010's") are only made for styles and decades your library has plenty of, with at most two songs per artist. Their covers now print the style under the decade ("2010" over "House"), so they no longer look like the plain decade mix, and every Discover mix keeps its Hub cover in Playlists and on the playlist's own page. The favourites and rediscover covers are fuller and brighter: light curtains across a glowing sky, arcs of every width sweeping across the cover from a lit corner, and decade covers with two or three ribbons that vary from hairlines to broad washes.
- **AI playlists say when your library is too thin:** ask for something specific your library hardly has ("Danish rap from the 80s", or "jazz for a dinner party" in a library with no jazz) and Aurora tells you how much there is ("Your library has no Hip Hop tracks from Denmark from the 1980s") instead of filling the playlist with something else. Mood requests ("music for coding") still draw on anything that sounds right.
- **Special lists in the Hub:** some of the Hub's AI playlists are now special lists: tightly themed playlists your library can carry, like "Trance Horizon", "Danish Rap Commute" or "Music for Code". Aurora lists the themes your library has enough of (a style, a genre from one country, or a style from one decade), the AI picks and names them, and a list is only made when enough of your songs really fit. Themes rotate: one doesn't come back within two weeks while your library has others to offer, and a smaller library takes turns through what it has. Number of playlists (Settings → Playback) is now 2, 3, 6 or 9, of which up to 1, 1, 2 or 3 are special lists; they sit in the same rail as the others. If the AI doesn't answer, the Hub keeps its current playlists instead of going empty. Playlists also spread artists properly again: "ATB feat. JanSoon" and "ATB & Sean Ryan" now count as the same artist, so one artist no longer fills a playlist under different credits.
- **AI playlists keep to their theme:** an AI playlist is now ranked by one score — how close a track sounds to the idea, and how strongly it belongs to the styles asked for — instead of a mix of six separate lists. A trance playlist is now trance (it used to fill up with "Dance"-tagged EDM), and requests for niche styles the library hardly has no longer happen, because the AI only picks styles your library really holds. Building a playlist is also several times faster. Genre Cohesion sets how strictly a playlist keeps to its styles versus its mood.
- **Genre Matrix retired:** Settings no longer has a Genre Matrix tab or a MusicBrainz database import (Settings → Database → MBDB, a 4 GB download); genres and styles do that job, and MusicBrainz genre names ship with Aurora. Scans no longer start an AI genre categorization afterwards. The genre filter groups styles under their genre from Aurora's own taxonomy.
- **Genres everywhere follow Aurora's genres and styles:** the genre list, each song's genre, the filters and Subsonic apps (Symfonium and others) now show the genres and styles Aurora worked out from tags and sound ("Grunge", "Alternative Rock", "Rock") instead of each file's raw genre tag. A song lists its styles first, then its genres. The file tags themselves are untouched.
- **Recommendations by style:** Infinity, the Hub and AI playlists no longer rank a track down for being in a different genre. Tracks that share styles with the end of your queue (or the playlist's theme) rank a little higher, so a great match from a neighbouring genre is no longer pushed out. Genre Strictness is now called Style match. AI playlists pick from your library's own genres and styles, and the genres they leave out cover whole families ("metal" leaves out Heavy, Death and Doom Metal). The Genre Penalty Curve setting is gone.
- **Credit imports:** Producer, writer and role credits from Genius and MusicBrainz now import by themselves on the server whenever the provider is set up, slowly and in the background, and pick up new tracks as they arrive. Settings → Metadata only shows their progress. Every lookup is remembered, so a track is never asked about twice unless it's retagged, and rate limits pause the import instead of failing it.
- **Audio analysis:** Each track is now analysed at three points (20 %, 50 % and 80 %) instead of one, so songs whose middle differs from the rest are matched more reliably. A blind listening test preferred the new results 13 to 7. Analysis takes about as long as before: the three windows are decoded in one pass, and a single model now does the work of two. Analysis also stores 400 style scores per track, the groundwork for the coming Genre and Style browse. After updating, Aurora re-analyses the library once.
- **Genre review:** Settings → Library Entities → Genres is now one review queue, built like the artist review. It asks about genre tags that don't match a genre or style by name (no match, a style found under two genres, a guess from MusicBrainz, several genres in one tag) and about two spellings of one genre, shows the artists and albums involved, and previews where the tracks go. Tags that match by name are listed and accepted together. Every decision can be undone for 30 days. A meter shows how many tagged tracks have a genre. Each question shows what the audio says about the tracks (their top genres and styles) and, with Last.fm or MusicBrainz data, the artists' tags, and starts from a suggested answer when they agree. When the tracks' styles vary, the suggestion is the genre alone, so one tag doesn't give every track of a varied artist the same style.
- **Genre and style browse (preview):** Turn on "Genre and style browse" in Settings → Appearance and Library → Genres shows Aurora's own genres and their styles, worked out for every track from its tags and its sound (and, when available, Last.fm and MusicBrainz artist tags). Each genre is a card in one of the Hub's cover gradients (as on Daylist, On repeat and Rewind) with its track count and biggest style, and opens a page with its biggest styles, every style in an index, the albums and artists most in it, and Shuffle for the genre or any decade. Shuffle starts a mix of 15 to 30 strong tracks from many artists (all of a small style), and Infinity mode, when on, carries on from there. Tracks Aurora couldn't place are listed under Unsorted. **Aurora rays** in a track's menu opens "Aurora rays from {title}": its credits, its genres and styles and where each came from (a file tag, the sound, artist tags, or set by hand), how it sounds (energy, danceability, acoustic or electronic, vocal or instrumental, tempo, closest styles), how it sits in its album and artist (and its featured artists and remixers), what it sounds close to (nearby styles and tracks), and the other albums it's on. Admins can add or remove a genre or style there. Style pages end with the styles that sound closest, from any genre. Aurora also adds styles it clearly hears to tagged tracks (shown as "from the sound"), and flags tags the sound contradicts: admins find them under Unsorted → Disputed tags, listen, and keep or remove each. Every track now has a country (from MusicBrainz, the artist's Last.fm tags, or the file) and, where the file says, a lyrics language; "danish", "dansk", "Denmark" and "danmark" all mean Denmark. Shuffle on a genre or style page can be narrowed by decade and country, and AI playlists understand requests like "Dansk rap fra 90'erne". Decades now go by a song's original release year, so a 2021 remaster of a 1991 song counts as the 90s. Shuffle can also be narrowed to female or male vocals and to a mood (chill, party, melancholic…), from the artists' tags, and AI playlists use both ("chill med kvindelig vokal"). Without Last.fm or MusicBrainz everything still works from file tags and the sound; AI playlists then skip vocal and mood requests rather than come back empty. Album and artist pages show their genres and styles.
- **Python 3.14:** The analysis environment moves to Python 3.14 with a pinned Essentia build. Existing installs rebuild `.venv` once (see the production guide; the full upgrade checklist is in `docs/genre-engine-upgrade.md`).

### Bug fixes
- **Album and artist links from files:** links tagged by MusicBrainz Picard under each site's name (DISCOGS.COM, ALLMUSIC.COM, WIKIDATA.ORG, LAST.FM, BANDCAMP.COM and the like, in about a fifth of files) were ignored. They're read now, in every file format, and the album's Links menu leaves out links to the artist (those belong on the artist page).
- **Artist picture backfill stopped after about 100 artists:** Last.fm answering "The artist you supplied could not be found" was treated as an outage, which ends the run. It's now a normal miss.
- **Genius picture of the wrong artist:** when Genius's search had no song by the artist, Aurora took any artist whose name contained theirs, so the metal band Demon Hunter got the picture of the "KPop Demon Hunters Cast". Genius now has to have the same name (a note in brackets after it, like "(UK)", is allowed); otherwise the next provider is asked.
- **Genius's blank artist picture:** for an artist Genius has no photo of, it answers with its grey stock picture, and Aurora kept that as the artist's photo, so providers further down the Artist images list were never asked. It's now treated as no picture: the next provider is asked, and artists who already have it saved are looked up again.
- **MusicBrainz album art by search:** an album whose files don't name their MusicBrainz release never got a cover from the Cover Art Archive: the search found the release group but looked it up as a release. It now looks up the release group's cover.
- **Signing out stops the music:** signing out, or a login that expires, now stops all playback on that device: the song that plays, the next one it had ready, a cast from that device (the speaker or TV stops too) and the sleep timer. The lock-screen and media keys can't start it again. The queue is cleared from the device too, so the next person to sign in never sees it. With Sync playback across devices on, your queue comes back from the server when you sign in again, paused where it was.
- **No more stutter casting hi-res files to Beoplay speakers:** casting a 24-bit/96 kHz (or 88.2/192 kHz) file to a Beoplay speaker stuttered, while CD-quality files played fine. Cast always gets 128k AAC, but it kept the file's sample rate, so the speaker had to decode 96 kHz AAC for no gain in quality. Streams now never carry more than 48 kHz (96/192 kHz becomes 48 kHz, 88.2/176.4 kHz becomes 44.1 kHz), for Cast and browser streaming alike. Confirmed on a Beoplay A9.
- **Infinity no longer plays the same song twice:** a song you have on more than one album (the album and a compilation, the studio album and a live album) could come up again soon after, sometimes right after itself, when the copies carried different MusicBrainz ids or the credit named a guest ("Sia" and "Sia feat. Burna Boy"). Infinity now counts the same title by the same lead artist as the same song. Remixes and other versions with their own title still count as different songs.
- **Moving or renaming music files keeps their history:** a file that moves to another folder or gets a new name now stays the same track, with its playlist entries, likes, play history and analysis. Before, the scanner deleted the old track and added a new one, and everything attached to it was lost. Aurora recognises the file by its size and date, or by its size and tags when its date changed on the way; when it can't be sure (two identical copies, say), it does what it did before. A file that is re-tagged and moved in one go still counts as new.
- **Gigs nearby on your home network:** an open gig now shows to everyone on the same network as the Aurora server, whatever their device's own address (each device on IPv6 has its own, which hid gigs between a phone and a desktop at home). Elsewhere, devices on the same IPv6 network see each other's gigs too.
- **Queue sidebar:** dragging a track onto the one that plays no longer makes it vanish (it went among the played tracks); the drop snaps back. The track that plays can't be dragged either. On wide screens (1280 px and up) the sidebar has more room at its sides.
- **Search field on phones:** no second, inner green border while typing, and only one clear (×) button: the browser's own no longer shows beside Aurora's (on desktop too).
- **Menus on right-click and long press:** every track row and playlist card with a ⋯ menu (albums, playlists, the queue, search results, quick search, Popular on artist pages) now also opens it by right-click, the keyboard's menu key, or a long press on phones and tablets, including iPhones and iPads, which had no long press before. The tap that ends a long press doesn't also play the track, and right-clicking a link keeps the browser's own menu.
- **Last row reachable with a bottom browser toolbar:** in browsers whose toolbar stays at the bottom (Samsung Internet with Android's navigation buttons), the end of a page sat behind the mini player and tab bar, so a single's only track couldn't be tapped. The app now fits the visible part of the screen.
- **Add to Playlist offers only your own editable playlists:** the track menu no longer lists artist radio, the Daylist and other read-only playlists (or Hub AI playlists, which are rebuilt), where adding a song failed.
- **AI playlists have no Discoverable setting:** other listeners never see AI playlists, so the Private/Discoverable button on them did nothing and is gone (from the server's rules too). A share link still works.
- **Aurora rays in the track menu:** it has a galaxy icon and a small Beta tag.
- **Track menu sub-panels:** Go to Artist and Add to Playlist no longer open shifted to the side, Credits and the other lists use the menu's full height instead of stopping partway, and the filter is a plain row of the menu with no box or focus border.
- **Menus stay on screen:** a track's menu opened near the bottom or right edge (a queue row in the corner, say) ran off the screen, because it assumed the menu was shorter than it is. Menus now measure themselves and open upward or to the left where there isn't room, as desktop menus do; a menu taller than the window scrolls. The same goes for the playlist, album and artist menus.
- **Popular in your library has a menu:** its rows on an artist page now have the same ⋯ menu as other track rows (add to queue or a playlist, go to album, Aurora rays…).
- **Analysis of MP3s with a wrong length:** some MP3s carry a header that claims the file is several times longer than it is (a 4-minute song read as 20 minutes). The new three-point analysis then looked past the end of the song, failed, and stored stand-in values for it. Aurora now notices, measures the real length and analyses the right three points, and stores the real length, so the player, Subsonic apps and playlists show it too (a rescan keeps it while the file still claims the same wrong length). Settings → Library → Re-analyze Fallbacks redoes tracks that were affected.
- **Similar artists ignore stand-in analysis:** tracks Aurora couldn't analyse (stored with stand-in values) no longer count towards an artist's sound in "Similar artists", so an artist with such tracks isn't pulled towards the middle, and one with only such tracks isn't suggested. The list is rebuilt once on the first start after updating.
- **Unused Genius proxy removed:** `POST /api/providers/genius/search` and `/api/providers/genius/artist/:id` are gone. Nothing in Aurora has called them since metadata moved to the server, but any signed-in user could use them to spend the server's Genius API quota. Testing the Genius key (`/api/providers/genius/test`) is unchanged.
- **Old listener routes are logged before removal:** the web app gets every listener feature from API v1, so the older `/api` routes for the Hub, playlists, playback reports, Infinity, library browsing, search, loves and scrobbling (41 in all) are marked deprecated. Each call is logged in `production.log` with the client that made it, and the response carries a `Deprecation` header; once a week of logs shows nothing calls them, they go. The list and their API v1 replacements are in `docs/legacy-listener-routes.md`.
- **Old Hub routes removed:** a week of logging (17–24 Nov) showed nothing calls the ten `/api/hub` routes, so they're gone; the Hub is on API v1 (`/api/v1/hub`). The other old listener routes follow, one file at a time.
- **Old playlist routes removed:** the same week showed nothing calls the eleven `/api/playlists` routes either; playlists are on API v1 (`/api/v1/playlists`).
- **Old playback report routes removed:** `/api/playback/history`, `/record` and `/skip`; plays and skips go to `POST /api/v1/playback/reports`.
- **Old Infinity route removed:** `POST /api/recommend`; the next track comes from `POST /api/v1/recommendations/next`.
- **Old artist list and detail routes removed:** `GET /api/artists` and `GET /api/artists/:id`; they're on API v1. Similar artists, credits and appears-on stay.
- **Old album list and detail routes removed:** `GET /api/albums` and `GET /api/albums/:id`; they're on API v1. Editions, merges and credits stay.
- **Old genre list and detail routes removed:** `GET /api/genres` and `GET /api/genres/:id`; they're on API v1. The genre taxonomy route stays.
- **Unused MusicBrainz proxy routes removed:** the seven `/api/providers/musicbrainz/…` lookup, search and token-refresh routes had no caller, and any signed-in user could use them to spend the server's shared MusicBrainz rate limit. Connecting, testing and disconnecting MusicBrainz are unchanged. Other routes nothing called (the old artist-duplicates tool, which the artist review replaced, and three status routes) and the unused `essentia.js` package are gone too.

### Security
- **Failed sign-ins to the API are limited:** a request to API v1 with a missing, wrong or expired credential was never counted towards any limit, and one with a made-up app key cost a database lookup each time. Now an address with more than 120 failed sign-ins in a minute is refused (429, `TOO_MANY_FAILED_SIGN_INS`) until the minute is up, before the next attempt is checked, and an app key that isn't shaped like one Aurora issued is refused without a lookup. Signed-in requests don't count, so a household of devices is never slowed by its own use.

## [v1.0.0-rc.7] - 2026-11-06

### Features
- **Connect and playback across devices:** See where music is playing, control it from another device, transfer playback, and share queue edits across devices. A device that isn't playing can also change repeat, shuffle, Infinity Mode, and volume.
- **Listen Together:** Invite people to a shared listening session with join links, guest controls, and discoverable gigs with configurable participation levels. Each gig has a panel that lists its members, with an option to remove them, and Aurora avatars appear throughout the app.
- **Independent Cast playback:** Chromecast can follow the shared queue and keep Infinity Mode playing after the sending app closes or goes to sleep.
- **Cast takeover:** Choosing a Cast device that is already playing another device's music replaces that music, as in other casting apps. The replaced device returns to local playback, paused, with no error, even if it was asleep during the takeover. Desktop Chrome then needs a page refresh before it can cast again, and the Connect menu offers one.
- **Aurora Listener API:** Added a versioned API for web, desktop, and mobile clients, with app pairing, dedicated app keys, library browsing, playlists, discovery, playback control, and live updates.
- **Database backups:** Export and restore the database for backups, server moves, and rebuilt installations.
- **Artist review tools:** Review artist names and combined credits with previews, keep or split decisions, and undo support.

### Improvements
- **Infinity Mode:** Recommendations continue from the end of the queue, avoid queued tracks and repeats, and use server-managed top-ups across playback devices.
- **Cast at the end of the queue:** When the queue finishes, the cast stays connected and idle, and Play starts the queue again on the Cast device. If the Cast device closes after its idle timeout, the sending device ends the cast without an error, including when it was asleep at the time.
- **Library loading:** Library sections appear progressively while larger collections load.
- **Artist metadata:** Improved use of per-person file tags, MusicBrainz identities, artwork fallbacks, and image and biography provider preferences.
- **Listening history:** Playback reports update plays, skips, and scrobbles across devices; failed scrobbles retry after network errors. OpenSubsonic likes can optionally sync to connected providers.
- **Interface:** Refined Connect menus, mobile queue interactions, compact Settings navigation, typography, Hub artwork, and receiver presentation.
- **Diagnostics:** Added clearer playback, scanner, Cast, and streaming logs with controls for diagnostic verbosity.

### Bug fixes
- **Cast reliability:** Fixed queue changes, rapid skips, seeking, progress updates, artwork, reconnection, session handovers, and recovery when the Cast SDK loses media status. The Cast volume slider no longer jumps back while you drag it. After switching a cast between two of your own devices, the new device keeps its progress bar and volume control.
- **Playback synchronization:** Fixed unintended playback takeovers, stale remote controls, and queue conflicts. The currently playing track is protected from removal.
- **Local playback:** Improved next-track preparation at Source quality and fixed end-of-queue, repeat, and skip-reporting behavior.
- **Library scanning:** Prevented inaccessible folders from causing track deletion, hardened analysis workers, corrected analysis coverage, and fixed artist-tag splitting.
- **Artwork and video:** Fixed missing artist images across Hub and library views, video matching and retry behavior, and mobile background-video playback.
- **PWA updates:** Fixed update activation getting stuck, stale or broken asset caching, and cross-origin image caching issues.
- **Accounts and server startup:** Fixed invite expiry and reuse, sign-in submission before captcha completion, environment configuration loading, and misleading database recovery screens. Usernames are now case-insensitive.
- **API and discovery:** Fixed pagination with UUID identifiers, playlist metadata, Hub regeneration feedback, and Wrapped period boundaries in local time.

### Security
- **Dependency fixes:** updated 17 packages with published security fixes (request parsing, compression, proxy address handling, music file parsing, validation, and build tools), each at a version at least two weeks old. Still open: `sharp` (its fix is the 0.35 upgrade, #30) and build-only PWA tooling.
- Restricted media, event-stream, and receiver credentials to their intended uses; hardened pairing, streaming rate limits, and artwork cache access.
- Isolated Cast media credentials from login credentials and session broadcasts, and added image-specific signed artwork links.
- Protected the server owner and last administrator from unsafe account changes; closing a shared listening session invalidates its invitation links.

## [v1.0.0-rc.6] - 2026-07-14

### Audio & Playback
- **Adaptive Auto HLS ABR**: Replaced the browser `Auto` → `128 kbps` alias with source-aware adaptive AAC HLS across 64/128/160/320 kbps. One-process FFmpeg `asplit`/`var_stream_map` packaging with aligned 10-second renditions. hls.js seeds ABR from Network Information, caps to 64 kbps for Data Saver, and falls back on failure. The player signal chain shows `Auto · <active bitrate>`.
- **Cast Lossless**: Cast FLAC/WAV losslessly at Source quality; receiver passes progressive lossless through with a lossless UI badge. Receiver lossless-capability probe and raw-stream request logging added. Cast-safe AAC fallback retained for `auto`/`source` on the custom receiver path.
- **Authoritative Lossless Flag**: `music-metadata` now sets an authoritative `is_lossless` flag on tracks, replacing heuristic detection.
- **Audio Output Routing**: Route graph output through a `MediaStream` bridge on Firefox/Safari. Permission-gated device routing with `AudioContext` sink selector.
- **Loudness Normalization (EBU R128)**: Per-track EBU R128 loudness computed and stored during analysis. Per-element `GainNode` in the playback graph applies correction on track change. Library backfill via `POST /analyze/loudness`, `GET /api/loudness` read endpoint, distinct "Measuring Loudness" scan phase in the UI, and Lazy/Full/Both computation-mode switch.
- **Volume Scroll**: Adjust volume with mouse wheel on the player.
- **Cast Volume Clamp**: Receiver volume clamped on fresh session handover to prevent jarring jumps.

### Hub & Recommendations
- **Wrapped Recaps**: Generate year/season Wrapped playlists surfaced on Hub, Playlists, and Settings. Blends Last.fm/ListenBrainz listening history into recap playlists.
- **Procedural Aurora Covers**: Generative cover art for Wrapped and Hub discover mixes — three distinct discover styles, humanized engine-mix copy, full-decade numerals ("2010" not "10's"), thicker overlapping favourite curtains. Multi-color palette extracted from cover art via `useDominantColor`.
- **Hub Resume Slot**: User-configurable resume-freshness gate and last-opened-album fallback for the resume slot.
- **Hub Admin Toggles**: Admin toggles for personalized Hub rails with config-aware cache.
- **Artist Radio**: Eligibility check and adaptive radio length. Fixed missing stream/art URLs on artist radio tracks.
- **Now-Playing Source Link**: Click now-playing title to open where it's playing from (album/artist/playlist).

### Library & Metadata
- **Canonical Genre Identity**: Deterministic 0–100 duplicate scoring with connector-aware normalization, MusicBrainz path context, persistent signature-scoped dismissals, and reversible transactional grouping. Canonical identity drives genre grids, Genre Matrix coverage, KNN inputs, candidate pools, banned paths, hop costs, Infinity Mode, Hub mixes, album filters, and OpenSubsonic genre listing.
- **Library Entities Tab**: Expanded Artist Entities into Artists and Genres sub-tabs with ranked spelling-variant review, ambiguous slash-tag isolation, taxonomy-conflict preview, manual grouping, and reversible restore.
- **WMA Artwork Recovery**: Shared `sharp`-validated resolver tries every embedded ASF picture, removes malformed prefixes, reconstructs broken JPEGs, and falls back through provider chain. `tracks.artwork_version` triggers one automatic reparse for artless rows.
- **Credit Enrichment**: Background jobs with progress polling and MetadataTab progress bars. Credit-only artist detail rendering and loading-state fixes. Compilation tracks credited to real performers with name-based VA detection.
- **Artist Image Enrichment**: Batch enrichment service wired into scan, refresh, and cache-clear. Removed per-card image fetching from LibraryHome grid to reduce boot payload.
- **Self-Healing**: Unparsed tracks auto-recover on next scan; artwork decode failures are isolated per-file.

### Mobile
- **Two-Page Queue Sheet**: Queue sheet expanded to two pages with aurora bloom backdrop and Cast volume gating.
- **Now-Playing Backdrops**: Compositor-friendly backdrop morphs that scroll with page 1. Cross-fade backdrops track-to-track. Adaptive readability veil for low-contrast covers.
- **Music Video Backgrounds**: Mobile now-playing background music videos via YouTube, with vibrant mesh gradient fallback and appearance toggle.

### Music Videos
- **YouTube IFrame API**: Loader and track music video hook. Music Videos rail on artist pages. Track music video endpoint with DB index. YouTube host validation hardened.

### Playlists
- **Playlist Discovery**: Inline editing, privacy toggle, and rail-based playlist layout. Playlist discovery and privacy controls (backend + store).

### Security
- **CSP Enforcing**: Promoted Content-Security-Policy from Report-Only to enforcing. Dropped `script-src 'unsafe-inline'` in favor of sha256 hashes. Allowed Cast SDK scripts on insecure origins and service worker Google Fonts access.
- **npm Audit Fix**: Resolved 18 of 22 advisories.

### PWA & Offline
- **Adaptive HLS Offline Fallback**: Rendition-agnostic offline fallback for adaptive HLS caches — same-path cache lookup on exact-query miss so aligned AAC renditions can satisfy offline requests.
- **Stable Manifest ID**: PWA manifest id set independent of `start_url` so already-installed PWAs aren't treated as new on update.
- **Chunk Recovery**: Auto-recover from stale lazy chunks after deploy via `vite:preloadError` handler. PWA update reload prevents white screen and repeated prompts.

### Settings & Setup
- **Resumable Onboarding**: Three-step first-run flow (Account → Analysis → Library) with server-side progress independent from user existence. Interrupted installs resume after login. Model downloads use partial files and reject failed/incomplete downloads; scans defer feature analysis when models are unavailable.
- **ML Model Readiness**: Analysis gated on ML model readiness with atomic model downloads.
- **API Keys Tab**: OpenSubsonic key management moved to dedicated Settings → API Keys tab with create, rotate, revoke, delete, and disabled-service states.
- **OpenSubsonic Service Toggle**: `openSubsonicEnabled` system setting; `/rest` returns error `50` when disabled without deleting keys.
- **Subsonic Key Rotation**: `POST /api/auth/subsonic-api-keys/:id/rotate` replaces key secret in place and returns the new raw key once.

### Subsonic / OpenSubsonic
- **Scrobble Bridge**: `/rest/scrobble` now updates Aurora play history and optionally forwards to connected Last.fm/ListenBrainz providers with per-user toggle (disabled by default). Provider failures logged without failing the client request.
- **Scrobble Hardening**: Timeout + graceful soft-fail for LB/Last.fm submissions. Scrobble threshold default lowered from 95% to 50%.

### Performance
- **Lean DB Projections**: Stripped snake_case column duplicates from `mapTrackRow`. Trimmed `rawUrls` from `getAllTracks`; `decoded_path` never serialized. Index directory-prefix lookups via `decoded_path` column. Lean projection for `getAllArtists` to reduce boot payload.
- **Connection Hardening**: Capture leak-detect stack at real `connect()` call site. Bound advisory-lock wait with `SET LOCAL lock_timeout`. Restored native `pool.query` wrapping to prevent connection poisoning on DB blips.
- **Rendering**: Eliminate CLS by rendering FilterBar shape in loading states. Resolve actual scroll viewport for `VirtualizedCardGrid` to restore windowing. Compositor-friendly mobile backdrop morphs.
- **Dead Code Removal**: Removed unused theme system, dead `cn()` helper, deprecated `Semaphore` class, unused npm deps (`@tensorflow/tfjs-node`, `bottleneck`, `buffer`, `clsx`, `tailwind-merge` — 85 packages), Buffer polyfill, and `global` shims.

### UI
- **Semantic Color Tokens**: Semantic Tailwind color tokens with alpha modifier support.
- **Cover Gradient Utilities**: Extracted multi-color palette and cover gradient logic into shared modules. SoftAurora premultiplied alpha and glass opacity for cross-browser consistency.
- **Scroll Preservation**: Preserve scroll position across navigation.
- **Cast UI**: Recovery message on real launch failure, "Stop casting" label, queue stream/art URL rebuild from current token. Receiver CSP hardened with per-page script hashes.

### Infrastructure
- **Rootless Podman**: Enable rootless Podman lingering so DB container survives logout.

## [v1.0.0-rc.5] - 2026-06-10

### Architecture & Performance
- **Entity-First Client Boot**: The client no longer loads the full track list at boot. Views render from lightweight entity lists (artists/albums/genres); tracks are fetched per-entity on demand via the new `useEntityTracks` hook. `fetchLibraryFromServer` fetches entities + directories in parallel, then reconciles the restored play queue via `POST /api/library/tracks/exists`.
- **Server-Side Search**: `GET /api/library/search` runs trigram-indexed ILIKE queries (tracks, artists, albums) with per-user `is_loved`. `GlobalSearch` debounces input and aborts the prior request per keystroke. Empty query → empty result; results are capped.
- **Server-Precomputed Album Metadata**: `getAllAlbums` computes track_count, derived_year, derived_genres, derived_release_type, and art_hash server-side via a LATERAL aggregate over tracks grouped by album_id. The client's `deriveAlbumMetadata` prefers these fields and only falls back to track derivation if absent.
- **Per-Entity Track Endpoints**: `getTracksBy{Artist,Album,Genre}` accept userId for per-user is_loved. New endpoints: `GET /api/artists/:id/appears-on` (collaborations), `GET /api/playlists/:id/suggestions` (bounded candidate pool), `GET /api/library/tracks`, `GET /api/library/directories`, `POST /api/library/tracks/exists`.
- **Playlist Suggestion Pool**: `getPlaylistSuggestionPool` returns a bounded pool (≤500) of tracks sharing the playlist's artists, genres, or album-artists, ordered so shared-artist matches survive the cap. The existing client overlap-scoring then ranks the pool.
- **Gzip Compression**: Added `compression` middleware to gzip JSON/text responses, reducing the ~26MB library payload significantly. SSE streams are excluded to avoid buffering real-time scan/progress updates.
- **Slow-Query Observability**: Refactored slow-query logging to split connection-acquire time from execution time by acquiring the pool client explicitly. Reveals whether a slow query is pool pressure or SQL cost.
- **In-Memory Settings Cache**: `system_settings` and `user_settings` are read through in-memory Maps with 30s TTL and write-through on set, eliminating repeated pool round-trips. Progress-polled keys excluded.
- **Materialized View for Similar Artists**: `artist_audio_profiles` MV precomputes per-artist averaged musicnn + effnet vectors. `getSimilarArtistsByAudioProfile` reads candidates from the MV instead of re-aggregating the whole library. Refreshed after analysis batch writes features.
- **Rendering Churn Reduction**: Decomposed App shell into memoized sub-components, memoized always-mounted components, preserved artist/album filter+sort memoization across route changes, and extracted library derivations to survive route unmount. Pre-warms tab route chunks on hover/focus/pointerdown. Replaced correlated EXISTS with LEFT JOIN in playlist-track loaders.
- **Virtualized Grids**: Virtualized album/artist card grids in LibraryHome and the playlist grid with lazy-loaded thumbnails. Bumped PWA art cache maxEntries from 500 to 4000. Measurement gate on `VirtualizedCardGrid` prevents mounting hundreds of cards at once (each firing /api/art requests) when containerWidth is 0, which caused OOM on large libraries under HTTP/1.1. Fixed resize feedback loop crash.
- **DB Scaling for 100k+ Libraries**: Fetch dedup/cancellation and render churn improvements targeting large libraries.

### Library & Metadata
- **Incremental Scan**: New `art_hash` and `file_mtime` columns enable reprocessing only changed files. Art is encoded at scan time via the new `artCache` service (`sharp` moved to production deps). Hash-addressed `/api/art` endpoint serves pre-encoded AVIF cache. Content-hash art URLs and size-aware AlbumArt.
- **Album Disc Hero**: Album detail view shows a disc platter that rolls out from behind the cover. Uses Cover Art Archive "Medium" images when available (real printed disc/vinyl-label scans), falls back to a procedural vinyl label built from local cover art. Backend adds `caaGetReleaseImages`, `pickMediumImage`, `pickFrontImage`, `getRepresentativeReleaseMbid`, and `GET /api/providers/album/media-image`.
- **Taxonomy-Grouped Genre View**: Genre grid reorganized into taxonomy-grouped aurora cards when MBDB taxonomy is available.
- **Track File Size**: `file_size` stored in `tracks` and backfilled on scan; surfaced in Subsonic responses.

### Subsonic / OpenSubsonic
- **Extended Endpoints**: Implemented play queue, lyrics, similar songs, and `getUser` on the `/rest` surface.
- **Symfonium Compatibility**: `search3` query="" treated as match-all for full-library sync. `getOpenSubsonicExtensions` served without auth so Symfonium can discover apiKey auth. Fixed album list pagination, sorting, and scan status. URL-safe song IDs via base64url encoding. Subsonic client compat fixes for suffix, size, created, filters, and rate limit.
- **OpenSubsonic Service Toggle**: Admin enable/disable toggle in System settings. `openSubsonicEnabled` added to store state. `/rest` returns error `50` when disabled.
- **API Keys Tab**: Subsonic API key management moved to dedicated Settings tab with rotate and hard-delete support.
- **LLM Playlists Read-Only**: LLM-generated playlists marked read-only via Subsonic; hub refresh triggered on generation.

### Playback
- **Configurable Played Threshold**: User-configurable played threshold with fixed play/skip recording timing.
- **Wake Lock & Sleep Timer**: Screen wake lock during playback and a sleep timer with scrobble failure surfacing.
- **MediaSession Stop Action**: Added `stop` action handler to Media Session controls.
- **Autoplay Handling**: `PlaybackManager.playUrl` treats `NotAllowedError` as paused (no `nextTrack()` cascade). `onRehydrateStorage` coerces persisted 'playing' to 'paused' on reload.
- **Incidental Offline Playback**: Made incidental offline playback reliable.
- **Last.fm Signature Fix**: Use byte-order sort for Last.fm API signatures.

### UI
- **Filter UI Consolidation**: Replaced `FacetPopover` and `MobileFilterOverlay` with shared `ContextMenuPortal` (desktop popover / mobile bottom-sheet). Genre facet gains hierarchical drill-down via `GenreFacetMenu` when MBDB taxonomy is available. `QueryBuilderModal` goes fullscreen on mobile.
- **Love → Like Rename**: UI labels renamed from "love"/"favorite" to "like"/"liked" for consistency. Internal field names and Last.fm/ListenBrainz integration remain "love".
- **Shareable Playlist Links**: Public read-only snapshot links for playlists.
- **Scrobbling Tab**: Extracted Scrobbling tab from Account settings into its own section.
- **Mobile Tab Feedback**: Instant visual feedback on mobile tab taps.
- **View Transition Removal**: Removed the view transition system introduced in rc.4.

### Security
- **Rate Limiting**: Added rate limiting to all route groups; hardened invite preview endpoint.
- **Admin Auth on Mutations**: Required admin auth on library mutation endpoints.
- **HLS Path Validation**: Hardened HLS segment path validation against directory traversal.
- **Playlist Insert Cap**: Capped playlist track inserts to prevent unbounded bulk queries.

### Infrastructure
- **Container Runtime Detection**: Hardened container runtime detection with absolute path resolution. PM2/systemd often run with a minimal PATH that omits /usr/bin, causing spurious "No container runtime found". Probes common install locations with `fs.accessSync` before falling back to PATH resolution.

### Documentation
- Added `docs/library_data_loading.md` covering the entity-first boot flow, per-entity track fetching, server-side search, queue reconciliation, and the on-demand full-library cache for admin tools. Updated `architecture_overview.md` and `production_guide.md` with HTTP/2/3 reverse proxy guidance. Refreshed README with rc.4 features and high-level comparative features.

## [v1.0.0-rc.4] - 2026-05-26

### API
- **OpenSubsonic Compatibility**: Full API-key-only `/rest` surface for Subsonic clients — browsing, search, playlists, stream/download/HLS, cover art, stars, ratings, scrobbling, and compatibility stubs. Legacy u/p and token/salt auth rejected with OpenSubsonic error codes 41/42. Keys are SHA-256–hashed; the raw key is shown once at creation.
- **Subsonic Key Management**: `GET/POST/DELETE /api/auth/subsonic-api-keys` for listing, creating, and revoking Aurora-managed Subsonic API keys. Includes per-key rate limiting and last-used-at tracking.
- **Single-Playlist Endpoint**: `GET /api/playlists/:id` returns one playlist with tracks, eliminating the N+1 fetch pattern when opening a single playlist detail view.
- **Track Rating**: `setTrackRatingForUser` for Subsonic 1–5 star ratings stored in `user_playback_stats`.
- **Trigram Search Indexes**: GIN `gin_trgm_ops` indexes on `tracks(title, artist, album)` for fast Subsonic search2/search3 ILIKE queries.

### UI
- **View-Transition Morphing**: All detail pages (album, artist, playlist) now use `document.startViewTransition` + per-entity `view-transition-name` so cover art and avatars morph smoothly between list and detail views. Falls back to instant navigation on browsers without the API or when the user prefers reduced motion.
- **Hero State Skeletons**: Album, artist, and playlist detail routes receive hero placeholder data via router state, allowing them to render title, art, and metadata instantly before the store hydrates.
- **Route Prefetch**: Hover, focus, and pointer-down on album cards, artist cards, playlist cards, Hub tiles, and search results warm up the lazy-loaded detail chunk so navigation is near-instant.
- **GlobalSearch Overhaul**: Replaced inline Tailwind with named CSS classes. Added pill expansion animation, mobile full-screen overlay with 180ms slide-out close, result row hover translate, and `prefers-reduced-motion` guards.
- **Mobile Now Playing Sheet**: Deferred unmount via `data-state` (`open`/`closing`) with dedicated enter/exit keyframes so the slide-down animation completes before the DOM is removed.
- **Context Menu Cleanup**: Removed unused `showMobileHandle` prop and the drag-handle strip from mobile sheets.
- **Hub Navigation**: All Hub card, tile, and unique-collection clicks now pass hero state through `withViewTransition` for morphing cover art. Jump tiles also prefetch their target on hover/focus.
- **Subsonic API Key UI**: New "OpenSubsonic API Keys" section in Account settings to create, copy, and revoke keys with prefix display, creation date, last-used date, and revoked state.

### Performance
- **Playlist Single-Fetch**: Detail views use `fetchPlaylistFromServer(id)` to load one playlist instead of refreshing all playlists. Falls back to bulk refresh only on 404.
- **View-Transition `flushSync`**: Navigation inside `startViewTransition` callbacks uses `flushSync` to commit the DOM synchronously so the browser captures the post-navigation state for the morph.

## [v1.0.0-rc.3] - 2026-05-19

### Library
- **Facet Filters & Query Builder**: Artists and Albums now have sort, facet, and advanced query filtering with a visual query builder modal supporting AND/OR condition groups
- **Filter API**: `POST /api/filter/artists` and `/api/filter/albums` with validated SQL field references and ILIKE queries
- **GIN Trigram Indexes**: `artists(name, genres, community_tags, area)` and `albums(title, artist_name, tags)` for index-backed wildcard text search at scale
- **Merged Artist Redirects**: Merged rows preserved as redirect pointers (`merged_into` UUID column) instead of deletion, preventing re-creation on library refresh
- **Manual Artist Merge**: New "Manual merge" section in Artist Entities to merge any two artists by name with side-by-side preview cards and audit trail in `artist_duplicate_reviews`
- **Album Merge Conflict Handling**: `UNIQUE(title, artist_name)` violations now fold tracks into the survivor album instead of failing

### UI
- **SoftAurora WebGL Backdrop**: Animated aurora bands on Login and Invite Register pages via `ogl` renderer
- **Reduced Motion Toggle**: Appearance settings now offers a persistent reduced-motion preference independent of OS-level `prefers-reduced-motion`
- **Settings Modal Redesign**: Grouped nav (User/App/Server/Admin), search with auto-switch, ESC close, body scroll lock, compact layout via matchMedia
- **Settings Tabs Redesign**: Account (profile hero, password form, deletion flow), Library (coverage stats, folder rows, analysis progress), Artist Entities (overview, guide cards, review queue, manual merge), Live Music (hero toggle, overview grid, collapsible location, auto-subscribe strip)
- **Modal Accessibility**: ConfirmModal/PromptModal now have focus traps, `aria-labelledby`/`aria-describedby`, `role="dialog"`, and restore-focus-on-unmount. PromptModal supports `inputType`, `autoComplete`, `confirmLabel`
- **Filter Bar Spacing**: `.filter-zone` wrapper with consistent bottom margin (24px desktop, 18px mobile, 28px coarse-touch) to prevent layout compression
- **~2500 lines of new CSS**: Filter rack, settings panels, switch toggles, merge preview cards, live music panels, unified responsive grids

## [v1.0.0-rc.2] - 2026-05-19

### Security
- **Scoped Token Auth**: Separate `mediaAccessToken` and `sseAccessToken` JWTs (scope-limited, 7-day expiry) for HLS/Cast URLs and SSE streams — account JWT never exposed in URLs
- **Password Policy**: Minimum 12 characters enforced across all creation surfaces (register, setup, admin create, password change)
- **DB Recovery Token**: `AURORA_DB_RECOVERY_TOKEN` env var for unauthenticated database maintenance when auth cannot be verified
- **SSE Token Encoding**: All EventSource connections use `encodeURIComponent` for token parameters

### UI
- **PlayerShell**: Desktop player redesigned as a compositional floating-pill / full-width-docked slab with animated transition between modes
  - Top-edge chevron toggle (`bend`) for float ↔ dock switching
  - Signal chain chip: hover-expanding pill showing quality → codec → bitrate
  - Ticker title in float mode for long track names
  - `usePlayerPlacement` hook for responsive placement
  - 660 lines of new CSS: shell, bar-row grid, transport, volume, chain, waveform

### Cast Reliability
- Session preservation: `SESSION_ENDED` with active rejoin now stores session ID and calls `requestSessionById` instead of dropping
- Stale hydration cancellation: monotonically increasing `rejoinHydrationRunId` cancels outdated rejoin loops
- Stale media status discard: refreshes discarded when session ID changes between call and callback
- Remote-player disconnect during rejoin preserved as recovering state

## [v1.0.0-rc.1] - 2026-04-30

### Core Architecture
- Client-server music player with React + Express + PostgreSQL
- JWT authentication with per-user libraries, playlists, and recommendations
- PWA support with Workbox service worker and offline-capable caching

### Audio & Playback
- Gapless local file playback via FFmpeg-backed HLS streaming
- Google Cast (Chromecast) integration with custom CAF receiver UI
- Multi-output device selection (system default, specific speakers)
- Media Session API controls for background playback
- Prebuffering and next-track prewarm for smooth transitions

### AI Playlist Generation (Hub)
- Library-relative LLM concept compiler that interprets concepts against actual local library
- Explicit candidate pools: core, adjacent, root, acoustic, discovery, bridge
- Recovery ladder: exact → adjacent → same-root → acoustic → bridge → discovery
- Per-playlist diagnostics: pool sizes, relaxation level, diversity metrics
- Configurable tuning: Genre Cohesion, Playlist Diversity, Discovery Bias, Artist Spread

### Recommendation Engine
- 21-dimensional vector similarity: 8D acoustic + 1280D Discogs-EffNet embeddings
- pgvector HNSW indexes for fast similarity search
- Library profile layer: analyzed coverage, artist entropy, per-genre health
- Hop-cost genre math via MusicBrainz hierarchical taxonomy (~2,000 genres)
- 3-step genre pipeline: SQL match → LLM batch → KNN fallback

### Artist Management
- Normalized artist keys for variant resolution (Tiësto/Tiesto, N'to/NTO)
- Duplicate detection with manual merge/dismiss workflow
- Compound credit splitting (preserves "Nick & Jay", splits "A, B & C")
- Collaboration album surfacing (50%+ track credit = co-primary on both artist pages)

### Smart Playlists
- Daylist: time-of-day aware with bucket-based freshness
- On Repeat: listening pattern analysis
- Repeat Rewind: past favorites
- Time Capsules: seasonal/yearly rewind
- SmartHub persistence with transaction safety and advisory locking

### UI/UX
- Premium "Matte Glass" dark theme with responsive design
- Hub with crossfade animations and crossfaded tile transitions
- Queue save-as-playlist functionality
- Horizontal scroll rails with arrow navigation
- Virtualized library views for large collections
- Shared context menu primitives for mobile/desktop
- Performance-optimized: lazy routes, LRU-cached dominant colors, optimized waveform rendering

### Deployment
- One-line install script for Ubuntu/Debian
- PM2 or systemd service management
- Reverse proxy (Nginx) configuration for HTTPS
- Production guide in `docs/production_guide.md`

### Documentation
- `docs/architecture_overview.md` - System architecture diagram and component breakdown
- `docs/music_recommendation_engine.md` - Engine details and vector schema
- `docs/production_guide.md` - Deployment, environment config, troubleshooting
- `docs/API.md` - API endpoints reference
