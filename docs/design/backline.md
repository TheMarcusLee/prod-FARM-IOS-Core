# Backline design system

Backline is the product name. It replaces "iOS Farm", "Phone Farm", "Farm" and every trace of the
upstream project's branding (Handler, Agniverse, gethandler.ai, the curry footer) on every surface:
dashboard, desktop app, phone app, docs, window titles, app icons, package descriptions.

The canvas this was designed on: https://claude.ai/code/artifact/148f3c5b-12f7-488d-863e-81a83df90158

Screenshots of the built dashboard live in `docs/design/screenshots/`. Regenerate them with
`npm run preview:dashboard`, which serves the whole dashboard against twelve invented phones on
127.0.0.1:3999 without touching a rig.

## Concept

A control center, not a dashboard. The home view is **the wall**: every phone's screen, live,
numbered, selectable. Batch actions act on the selection. Click a tile and the right panel becomes the
expanded viewer with hardware controls, the running task's log and the next post. A second view,
**Schedule**, is a timeline: each phone is a track, posts are clips coloured by account, a playhead
marks now. The wall answers "what is happening", Schedule answers "what happens tonight".

Reference feel: Apple's pro apps in their light appearance. White panels on cool grey, real depth from
borders and one soft shadow level, deliberate controls, restraint. Not a card grid with hairlines,
not a dark panel with a neon accent, no monospace numerals, no emoji anywhere.

## Tokens

Every surface uses these exact values. Web: `static/dashboard/backline.css` (`--bl-*` variables).
Desktop renderer: same CSS variables in `apps/desktop/src/renderer/app.css`. Mobile:
`apps/mobile/src/theme/index.tsx` `light`/`dark` palettes.

| token | light | dark | use |
|---|---|---|---|
| bg | #f4f5f7 | #0f1115 | window / page background |
| panel | #ffffff | #171a20 | sidebars, cards, tiles, inspector |
| panel-2 | #f0f1f4 | #1f232b | inset areas, segmented control track, sliders |
| line | #e3e6eb | #2a2f39 | every border |
| line-strong | #c5cad3 | #3a4150 | checkbox borders, dividers that must read |
| text | #1e2430 | #e6e9ee | primary text |
| text-2 | #3c4350 | #b8bfca | secondary text, nav items |
| text-3 | #5b6270 | #8b93a1 | labels, meta |
| text-4 | #9aa1ad | #5f6775 | placeholders, timestamps |
| accent | #2f6fe4 | #5b8def | selection, active nav, "posting" state, links |
| accent-soft | #e8f0fe | #1b2a48 | active nav background, selected tile ring base |
| ok | #2f9e5b | #3fb768 | live, online, succeeded |
| warn | #c9931f | #d8ab3c | idle-with-caveat, degraded |
| bad | #d7503c | #ef6f61 | failed, needs-you, destructive |
| bad-soft | #fdf1ef | #3a1f1b | needs-you callout background |
| ink | #1e2430 | #e6e9ee | filled primary button background (light) |

Account colours (identity, used only on clips, chips and the inspector): sage #a3c497 / #7fa66a,
lilac #b9a6dc / #9a86c9, coral #e6a48f / #d9836b, sky #9dbfdd / #6aa0c9, mustard #dcc27a / #c9a94a,
then rose #e0a3c4 / #c77ea6, mint #9fd3c3 / #6fb39f, slate #b3bccd / #8593ab. Assign in order of
account creation; text on a fill uses the darker tone.

Type: **Hanken Grotesk** (Google Fonts) for everything, weights 400/500/600/700, `font-variant-
numeric: tabular-nums`. No display face, no mono. Scale: 11 / 12 / 12.5 / 13.5 (body) / 14 / 17
(page title) / 24 (phone screen title). Letter-spacing -0.01em at 17+, -0.02em at 24+.
Mobile uses the system font (SF / Roboto) at the same scale; do not bundle a font on the phone.

Spacing: 4, 6, 8, 10, 12, 14, 16, 18, 20, 24. Radii: 6 (small controls, number chips), 8
(buttons, inputs, nav items), 10 (callouts), 12 (tiles, cards), 14 (phone tiles), 999 (pills).
Shadow: one level only, `0 1px 2px rgba(30,36,48,.10)` on raised segmented thumbs and popovers.
Selection ring: `0 0 0 3px rgba(47,111,228,.18)` plus a 1.5px accent border.

Icons: stroke SVG on a 16 grid (24 on the phone), stroke 1.6, round caps, `currentColor`. The set
lives in `src/ui/icons.ts`; add to it rather than inlining new glyphs. Never emoji, never icon fonts.

## Layout

Desktop shell (`src/ui/shell.ts` `renderShell`): 208px sidebar (brand, nav, rig status), 56px
toolbar (page title, page actions, right cluster), content. Content pages are full-bleed inside
that; panels are `bl-panel`. Control Center is three columns: 216px filter panel, the wall, 336px
inspector. Schedule is a full-width timeline with a 150px track-name gutter. Min width 1180;
below it the shell scrolls sideways rather than squeezing, and the toolbar stays on one line.

The wall's tile size slider has three notches — S 120px, M 150px, L 210px — as the minimum
column width of `repeat(auto-fill, minmax(…, 1fr))`. Medium is the default, and at 1440x900 it
gives the wall four columns: 1440 - 208 sidebar leaves 1232, minus the 216 filter panel and the
336 inspector leaves 680, minus 16px padding either side and three 12px gaps is four 153px tiles.

Nav, in order: Control Center, Schedule, Content, Runbooks, Accounts, Alerts, (divider), Devices,
Rig, Settings. Alerts carries an unread count.

Phone app tabs: Wall, Schedule, Content, Alerts, Rig. Settings lives under Rig. 44pt targets. The
device screen locks touch while a task runs; hold to unlock.

Desktop app: one window titled Rig, same tokens, service rows in plain words, the worker's live log,
Restart all / Prepare iPhones / Diagnostics.

## Components

- Buttons: `bl-btn` (white, line border), `bl-btn-primary` (ink fill, white text), `bl-btn-danger`
  (bad fill). Height 32 desktop, 44 phone. Label case: sentence case.
- Segmented control: `bl-seg` track panel-2, thumb white with the one shadow.
- Chips: pill, 1px line; selected = ink fill white text.
- Number chip (device picker): 6px radius, panel-2; selected accent fill; offline at 40% opacity.
- Tile (wall): panel, 1.5px line, 12px radius, 6px padding; screen area 8px radius; footer row =
  checkbox · number · name · state dot+word. Selected = accent border + ring. Failed = bad border.
  Offline/no-frame = panel-2 screen with a one-line label.
- Inspector rows: label text-3 left, value text right, 12.5px, 10px gap.
- Callout "needs you": bad-soft background, 1px #f3c9c2 border, 10px radius, title 600, one action.
- Sliders: 4px track panel-2 / accent fill, 16px white thumb with accent border.
- Timeline clip: 28px tall, 5px radius, account fill + 1px darker border, label 11.5px 500. Running
  clip shows a progress overlay; failed clip = bad-soft fill + 1.5px bad border + alert glyph;
  retry = white fill + dashed bad border.
- Log block: panel-2, 10px radius, rows of timestamp (text-4) + text; the current line 600.
- Empty states: one sentence in text-3 plus the one action that fixes it. Never a spinner alone.
- Tables: only where rows are genuinely tabular (executions history). 12.5px, line dividers, no
  zebra.

## Copy

Sentence case everywhere. Say what happened and what to do: "Post failed, the Post button was not
found. Retrying at 19:30." Not "Execution error (exit 1)". Device names are what the operator typed;
the number badge (01–99) is the operator's handle for a slot. No exclamation marks, no jokes.

## States vocabulary

online (ok), posting (accent), busy (accent, non-post task), offline (text-4), disabled (text-4,
40% tile), error / needs you (bad). Exactly these words.
