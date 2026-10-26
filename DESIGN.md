# DESIGN.md

## Overview

Aurora is a product UI for listening to an owned music library. The physical scene is a listener moving between a desktop browser, a phone PWA, and a living-room TV in the evening. The interface should feel quiet, premium, and immediate, with album art and playback state doing most of the emotional work.

The visual world is Northern Lights over glass: matte translucent surfaces, soft green and teal glow, dark space, frosted daylight, and precise controls. Use the existing implementation tokens in `src/index.css` as the source of truth.

## Register

product

## Theme

Dark mode is the canonical atmosphere: deep night, luminous album art, emerald playback controls, and restrained aurora bloom. It is the default mental model for screenshots, TV, Cast receiver, and immersive playback.

Light mode is frosted daylight: pale blue-grey air, white glass, low-contrast bloom, and the same emerald playback anchor. It should feel like the same product in a brighter room, not a separate theme.

Design dark first, then verify light parity.

## Color

Use CSS custom properties from `src/index.css`. Do not hard-code raw colors inside components.

Core brand roles:

- `--aurora-green`: primary brand and playback action.
- `--aurora-extra-glow`: active emerald glow and high-energy accents.
- `--aurora-teal`: secondary aurora spectrum and progress blend.
- `--aurora-blue`: cool atmospheric support.
- `--aurora-pink`: rare red-shift accent for destructive or error states.
- `--aurora-play-gradient`: the play button signature.
- `--glass-bg`, `--glass-border`, `--glass-blur`, `--glass-shadow`: material system.

Color strategy is restrained. Emerald is the active state, not a paint bucket. Most surfaces should be tinted neutrals, album-art color, or glass. The aurora spectrum should appear in progress fills, subtle page atmosphere, receiver backgrounds, and selected hero moments.

Do not introduce new semantic colors casually. If a warning state is needed, prefer text, icon, and global toast behavior before adding another color role.

## Typography

Use two families:

- `Cal Sans` for all `h1`–`h4` headings, display text, section emphasis, and player labels.
- `DM Sans` for body, metadata, settings, lists, buttons, tabs, controls, and dense product UI.

Rules:

- Page and modal titles should use strong scale contrast. All `h1`–`h4` headings use `var(--font-display)` (Cal Sans), regular weight (`400`), `letter-spacing: 0.05em`, and no synthetic font styles; do not carry over negative tracking from Syne.
- All button and tab labels use `var(--font-body)` (DM Sans), regular weight (`400`), and `letter-spacing: 0.05em`, including nested labels and controls inside display-font containers. Do not synthesize heavier faces.
- PlayerControls titles and labels use regular weight (`400`) and `letter-spacing: 0.05em`; the Cal Sans title must not use synthetic bold.
- Metadata should recede until active or hovered.
- Time, bitrate, queue position, duration, and progress numerics must use tabular figures.
- Do not add a third font.
- Do not use decorative gradient text for normal UI.

## Material And Surfaces

Aurora glass is matte, not shiny. It should feel like frosted audio equipment, not floating plastic.

Use glass only when it supports hierarchy:

- Player controls, mini players, modals, drawers, settings surfaces, queue surfaces, and receiver panels can use glass.
- Avoid glass as decorative card filler.
- Avoid stacking glass more than two levels deep.
- Borders are hairline and low-alpha.
- Shadows are soft lift or emerald glow, never hard separators.

If a panel needs high readability, use the existing surface variant instead of increasing blur and opacity until the glass becomes muddy.

## Core Components

### Buttons

General app actions use the global button system in `src/index.css`: `.btn` plus `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-danger-fill`, `.btn-tab`, `.btn-dashed`, `.btn-icon`, `.btn-sm`, and `.btn-lg`.

Playback controls are their own primitives, not generic buttons:

- Secondary controls use small circular glass buttons.
- The primary play button is an emerald disc with `--aurora-play-gradient` and glow.
- Desktop and mobile should share the same visual language, with mobile sized down or up only for touch comfort.

### Cast (in the Connect menu)

Cast has no button of its own: it is a choice in the Connect card (Connect menu step 2, 2026-10-26), next to the user's devices and "This device".

Rules:

- The Connect button stands where the Cast button was: it shows a Cast icon while casting and a spinner while Cast connects, rejoins or recovers, both in the primary colour. No status text.
- "Cast to a device" opens Chrome's device picker; while casting, "This device · Stop casting" stops it.
- Never put `<google-cast-launcher>` in the card: the card unmounts (#40).
- Do not add a separate Cast mini player, Cast modal, or persistent Cast banner.
- Actionable Cast failures use the global toast system with Retry when available.

### Player Controls

Desktop `PlayerControls` is the only desktop footer playback surface. It owns progress, current track, Cast device label, quality readout, and the main playback controls.

Mobile uses the existing `MobileMiniPlayer` plus full `MobileNowPlaying`. Do not add a parallel mini player or Cast-specific overlay. When casting, the mobile mini player should show remote context in place, not create another layer.

### Toasts

Use one global toast system. Toasts are for transient actionable messages and recovery notices.

Do not create feature-specific banners for Cast health, preload status, or playback warnings. If a state needs persistent presence, it belongs in the relevant control surface.

### Progress And Sliders

Progress is calm at rest and more tactile on hover or drag:

- Thin rail.
- Aurora fill.
- Tabular time labels.
- Thumb revealed on interaction where pointer input exists.
- Touch controls must remain usable without hover.

### Album Art

Album art is always rounded, clipped, and treated as a first-class visual object. Never show raw square art. Art can seed ambient gradients, but do not let extracted colors break text contrast.

### Queue

Queue UI should feel like session control, not file management. Use clear current, next, and recently played states. Queue editing should not interrupt playback unless the user explicitly starts a new context.

## Layout

Aurora should not collapse into identical card grids. Use cards when the item benefits from cover art, click target, and quick action together. Use rows when scanning, ordering, or managing.

Patterns:

- `page-container` for detail-view spacing.
- Existing album and library grids for cover collections.
- Hub should lead with listening context and then offer jump-back-in choices.
- Settings should remain a product settings surface, not a preferences dump.
- Mobile shell is bottom tabs, mini player, and optional full now-playing. Respect safe areas.

Spacing should follow the existing 8-point rhythm with purposeful variation. Avoid hard dividers where glass borders and whitespace already provide separation.

## Cast Receiver

The custom receiver in `public/receiver.html` is Aurora dark, always.

It should be minimal, TV-legible, and lightweight:

- Blurred album-art atmosphere.
- Large current track metadata.
- Clear playback and queue context.
- TV-safe margins.
- No default CAF chrome visible as the primary experience.
- No heavy DOM, expensive animation, or frequent layout work that can stall older Chromecast devices.

The receiver is a living-room surface, not a debug panel. Logs belong in `logs/cast-receiver.log`, not on-screen.

## Motion

Motion should communicate state and tactility.

Use short transitions around 150ms to 250ms for hover, focus, player state, and drawer or modal entrance. Avoid animating layout properties. Do not use bounce or elastic motion. Infinite motion must be rare and gated by `prefers-reduced-motion`.

Allowed recurring motion:

- Loading or connecting spinner inside a control slot.
- Subtle progress or playback affordance.
- Receiver ambient motion only if it stays lightweight.

## Accessibility

Accessibility is part of the component contract.

- Controls must have accessible names.
- Non-button interactive elements are not acceptable.
- Focus-visible must remain visible.
- Keyboard playback and settings navigation must keep working.
- Critical state cannot be color-only.
- Touch targets should be at least 44px.
- Reduced motion users should get equivalent state feedback.
- Primary text must meet WCAG AA expectations in both themes.

Muted metadata may recede visually, but never use muted styling for required instructions, errors, or current critical state.

## Implementation Map

Primary design files:

- `src/index.css`: tokens, global button system, shared player and Cast control styling.
- `src/components/PlayerControls.tsx`: desktop playback surface.
- `src/components/MobileMiniPlayer.tsx`: mobile compact playback surface.
- `src/components/MobileNowPlaying.tsx`: mobile expanded playback surface.
- `src/components/ConnectMenu.tsx`: the Connect button and card, including Cast (`src/hooks/useCastStatus.ts` for its state).
- `src/components/cast/CastHealthToasts.tsx`: Cast health bridge into global toasts.
- `src/components/Toast.tsx`: toast item behavior.
- `src/components/ToastContainer.tsx`: global toast stack.
- `public/receiver.html`: custom Cast receiver.

When adding UI, extend these systems before inventing new primitives.

## Non-negotiables

- No duplicate mini players.
- No Cast-only playback modal.
- No persistent Cast status banner.
- No default receiver UI as the intended experience.
- No raw color literals in components.
- No new font family.
- No nested glass cards beyond two levels.
- No generic Material dashboard density.
- No decorative glass just to fill space.
- No playback feature without loading, error, reduced-motion, and keyboard behavior.
