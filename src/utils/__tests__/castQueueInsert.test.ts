import {
  RECEIVER_MESSAGE_MAX_BYTES,
  receiverControlAvailable,
  toReceiverQueueItem,
} from '../castWatchdogPolicy';

/**
 * Prod 2026-09-08..10, ~6h of casting:
 *
 *   21  Cast queue append: no media session, requesting status
 *   20  Appended track to Cast queue
 *    6  Cast queue append failed: no media session
 *
 * Each failure is Infinity silently not feeding the queue. Same condition #70
 * solved for transport: the SDK's media session is gone while the receiver
 * plays on, and the aurora namespace is still up.
 */

// The shape chrome.cast.media.QueueItem serialises to, as buildQueueItem makes it.
const senderItem = () => ({
  itemId: null,
  media: {
    contentId: 'https://aurora.onecloud.dk/api/stream/abc/playlist.m3u8?quality=256k&token=TKN&codec=aac',
    contentType: 'application/vnd.apple.mpegurl',
    streamType: 'BUFFERED',
    hlsSegmentFormat: 'ts',
    duration: null,
    tracks: null,
    textTrackStyle: null,
    metadata: {
      metadataType: 3,
      title: 'Habits (Stay High)',
      artist: 'Tove Lo',
      images: [{ url: 'https://aurora.onecloud.dk/art/1.jpg', height: null, width: null }],
    },
    customData: { queueEntryId: 'queue-abc-123', token: 'TKN', codec: 'aac', diagnosticsVerbose: false },
  },
  autoplay: true,
  preloadTime: 30,
  activeTrackIds: null,
  customData: null,
});

describe('toReceiverQueueItem', () => {
  it('produces the shape the Stage 0 spike proved insertItems accepts', () => {
    // Spike, 2026-09-02: a JSON copy of a queue item with itemId removed was
    // inserted, given a fresh id and placed where asked.
    const out = toReceiverQueueItem(senderItem())!;
    expect(out).not.toHaveProperty('itemId');
    expect(out.autoplay).toBe(true);
    expect(out.preloadTime).toBe(30);
  });

  it('removes a real itemId, not just a null one', () => {
    // An item taken from the session's own queue carries the id the SDK gave
    // it; re-inserting with that id would collide with the original.
    const fromSession = { ...senderItem(), itemId: 7 };
    expect(toReceiverQueueItem(fromSession)).not.toHaveProperty('itemId');
  });

  it('keeps everything that makes the item playable and identifiable', () => {
    const media = toReceiverQueueItem(senderItem())!.media as Record<string, any>;
    expect(media.contentId).toContain('token=TKN');
    expect(media.contentId).toContain('codec=aac');
    expect(media.contentType).toBe('application/vnd.apple.mpegurl');
    expect(media.hlsSegmentFormat).toBe('ts');
    // queueEntryId is how aurora-status identifies the item once it plays.
    expect(media.customData.queueEntryId).toBe('queue-abc-123');
    expect(media.metadata.title).toBe('Habits (Stay High)');
  });

  it('drops null fields the SDK would otherwise have to interpret', () => {
    const out = toReceiverQueueItem(senderItem())!;
    expect(out).not.toHaveProperty('activeTrackIds');
    expect(out).not.toHaveProperty('customData');
    expect(out.media).not.toHaveProperty('duration');
    expect(out.media).not.toHaveProperty('tracks');
  });

  it('does not mutate the item the sender still holds', () => {
    const original = senderItem();
    toReceiverQueueItem(original);
    expect(original.itemId).toBeNull();
    expect(original.activeTrackIds).toBeNull();
  });

  it('refuses an item with nothing to play', () => {
    // A dead item in the device queue stops playback when it is reached.
    const noUrl = senderItem();
    noUrl.media.contentId = '';
    expect(toReceiverQueueItem(noUrl)).toBeNull();
    expect(toReceiverQueueItem({ autoplay: true })).toBeNull();
    expect(toReceiverQueueItem(null)).toBeNull();
    expect(toReceiverQueueItem('item')).toBeNull();
  });

  it('refuses something that cannot be serialised', () => {
    const circular: Record<string, unknown> = { media: { contentId: 'x' } };
    circular.self = circular;
    expect(toReceiverQueueItem(circular)).toBeNull();
  });

  it('fits comfortably inside one namespace message', () => {
    const message = { type: 'aurora.queue.insert', requestId: 1, position: 'end', items: [toReceiverQueueItem(senderItem())] };
    expect(JSON.stringify(message).length).toBeLessThan(RECEIVER_MESSAGE_MAX_BYTES / 20);
  });
});

describe('receiverControlAvailable for queue insertion', () => {
  const fresh = { statusAgeMs: 2_000, freshMs: 20_000 };

  it('needs the queue-insert capability specifically', () => {
    // The receiver that shipped with #70 accepts transport but not inserts.
    expect(receiverControlAvailable({ ...fresh, caps: ['control'], capability: 'queue-insert' })).toBe(false);
    expect(receiverControlAvailable({ ...fresh, caps: ['control', 'queue-insert'], capability: 'queue-insert' })).toBe(true);
  });

  it('still defaults to the transport capability', () => {
    expect(receiverControlAvailable({ ...fresh, caps: ['control'] })).toBe(true);
    expect(receiverControlAvailable({ ...fresh, caps: ['queue-insert'] })).toBe(false);
  });
});
