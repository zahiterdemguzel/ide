# Mobile design system

How the phone app looks, and the rules that keep six screens reading as one product.
The *behaviour* of each screen lives in [remote-access.md](remote-access.md); this file
is only the visual system.

It came from a Claude Design exploration (project `fa03207f-eb02-4fb7-a689-bd781697abd0`,
"IDE Remote Redesign.dc.html"). That doc explored four directions for the Sessions home
and rolled the chosen one — **`2d`** — across the other screens as turn 3. The light
theme (`2c`) was explored and **abandoned**; nothing in the app is light, and a "let's
add light mode" change would be re-opening a closed decision, not finishing one.

## Where the tokens live

`mobile/src/theme.ts` is the source. Screens must pull from it rather than spelling out
hexes — the Ports screen was rebuilt precisely because it had drifted to `#2a2a2a` /
`#0a84ff` / `#333`, none of which were tokens.

The palette is the desktop IDE's (GitHub-dark), so the phone and the machine it drives
look like one product. Beyond `color`, the file carries:

- `type` — the recurring text roles. **`type.category`** is the signature one: 11px/700
  at `.6px` tracking, uppercase, hue-coloured. It labels every grouped list in the app
  (NEEDS YOU / WORKING / SETTLED / STAGED / CHANGES / FORWARDING).
- `radius.card` = **14** — the system's signature. Cards are 14 and nothing else is.
  Tool/thinking cards and menus are 12, inputs and buttons 10, badges 6, pills 999.
- `tint` + `alpha()` — the tinted-badge formula, as a function rather than a table so a
  new hue needs no new tokens: a `.12` wash for the fill, a `.35` line for the border,
  the solid hue for the text. Every status badge, count pill and glow is this formula.
- `inset` — **only `minTop`**, a floor for a device that reports no top inset at all.
  There is deliberately no `statusBar` and no `homeIndicator` token, and neither should
  come back: the design mocks an iPhone (notch 54, gesture bar 40) and *both* numbers are
  wrong on Android, which shipped as two real bugs — an over-tall top frame, and a dead
  strip above the system's own navigation bar. **Every frame measures**
  (`Math.max(useSafeAreaInsets().top, inset.minTop)`); see *The bottom edge* below.
- `TAB_BAR_HEIGHT` — the bar's height *before* the gesture inset is added under it.
  It lives in `theme.ts` rather than `App.tsx` because a full-screen Modal covers the
  tab bar, so the Sessions model menu has to know how tall it is — and importing that
  from `App.tsx` would be a cycle.
- `motion` — `spin: 700`, `orbit: 2400`, `flash: 1200`.

## The bottom edge

The mock is an iPhone, where the gesture bar is a constant 40 — and taking that
literally was a bug on Android. **We are not edge-to-edge** (Expo SDK 52's default),
so Android's system navigation bar is *not part of our window*: `insets.bottom` is
`0`, the OS paints that strip itself, and a hardcoded 40 reserved space the system
already owned — leaving a dead gap above a black bar on a gesture-nav device.

So:

- Anything clearing the bottom edge reads **`useSafeAreaInsets().bottom`**, never a
  constant. It's the real number on iOS and 0 on Android.
- **`androidNavigationBar` in `app.json` paints the system's own strip** `#161b22`,
  so it matches the tab bar instead of showing black. That's the only thing that can
  colour it while we're not edge-to-edge — a View can't reach outside the window.
- **A tab screen must not add a bottom inset at all.** The tab bar sits below it and
  already reserves whatever the device needs; padding the list too just puts dead
  space above the bar. Only full-screen routes with no tab bar (Notifications) clear
  it themselves.

If this app ever goes edge-to-edge, `insets.bottom` starts reporting a real number on
Android and the tab bar absorbs it automatically — but `androidNavigationBar` stops
applying, and the bar's own background becomes what shows through.

## The pieces

`mobile/src/components/ui.tsx` holds the shared primitives (`Card`, `CategoryLabel`,
`StatusBadge`, `Pill`, `Divider`, `Button`, `IconButton`, `UsageRing`).
`UsagePanel.tsx` is the popup the ring opens — a screen-level piece rather than a
primitive, so it sits beside `ScreenHeader` instead.

**The spinner and the status dot are deliberately not there.** `StateDot` already draws
both — and celebrates a finished run, which the design never mocked — so it stays the one
place a session's state becomes a colour. Reach for it instead of re-rolling a spinner.
(`Card`'s orbiting edge *is* in `ui.tsx`: it's a property of the surface, not of the state.)

`ScreenHeader` is every tab's header, and the navigator's own is **off**
(`headerShown: false` in `MainTabs`): the design puts a 28px large title under the
project row, and a stock header has room for the row but not the title. The drawers stay
in `MainTabs` — one of each for the whole hub — and screens reach them through
`ChromeContext` rather than each wiring up a drawer of its own.

The header gradient (`#161b22` → `#12161d`) is drawn with `react-native-svg`, which was
already a dependency for the file icons. A gradient package would be a **native module,
and therefore a rebuild of every dev client** for one rectangle. Three things about it
are load-bearing:

- **`ScreenHeader`'s outer View carries no padding** — the gutter is on an inner
  `content` View. This is not style: **Yoga insets absolutely-positioned children by
  their parent's padding**, unlike CSS, where the containing block is the padding box.
  With the gutter on the outer View, `StyleSheet.absoluteFill` gave the Svg
  `left/right: 16`, so the gradient stopped short of the edges and the page's near-black
  showed through at the frame's edge. Putting padding back on that View re-breaks it.
- **The gradient's `id` is per-instance** (`useId`). The tab navigator keeps all four
  headers mounted at once, and react-native-svg resolves `url(#id)` against a registry
  that duplicate ids collide in. A constant `id="hdr"` is four headers fighting over one
  def.
- **The top inset is measured** (`Math.max(useSafeAreaInsets().top, inset.minTop)`), never
  the mock's 54 — that number is an iPhone notch, and an Android status bar is roughly
  half it. This goes for **every** frame, not just this one: `FilesScreen`'s viewer bar
  and `NotificationsScreen`'s header measure the same way, which is why `inset.statusBar`
  no longer exists. Horizontal insets are added to the gutter so a landscape display
  cutout eats the *content*'s margin while the gradient still bleeds under it. The flat
  `backgroundColor: color.surface` under the Svg is a floor: if the gradient ever fails
  to paint, the frame reads as its own colour rather than as a hole.

**`title` is required** — every tab is titled, and the frame is a heading rather than a
toolbar. Git briefly went title-less on the argument that its branch chip already said
where you were; it didn't hold up, because the chip names the *branch*, not the screen,
and one untitled frame among four read as the screen that had lost its title.
`subtitle` and `children` stay optional.

## Darkening the screen

**When a modal dims the screen, it dims *all* of it — the status bar included.**
Every scrim `Modal` sets **`statusBarTranslucent`**; without it, Android gives the
modal a window that starts *below* the status bar, so the whole app dims except an
undimmed strip across the top. This shipped as a real bug in `UsagePanel` and was
then found in every other scrim modal (both drawers, the model menu, the git sheets,
`ErrorDialog`, `BadgeMenu`) — so the rule is a checklist item for any new overlay,
not a per-component fix.

The prop moves the modal's origin to the top of the *screen*, while the app's own
window still starts below the status bar (we are not edge-to-edge — see *The bottom
edge*). So anything inside the modal positioned from an app-window measurement —
`useSafeAreaInsets().top`, `measureInWindow` — must add **`MODAL_TOP_SHIFT`**
(exported from `theme.ts`; `StatusBar.currentHeight` on Android, 0 on iOS) to line
back up. `UsagePanel` and `BadgeMenu` need it (top-anchored); bottom-anchored things
(the model menu, the git bottom sheets) don't, and the drawers don't either because
their `SafeAreaView` (react-native-safe-area-context) measures its own window and
pads itself.

## The motion signals

All four say "running" or "just landed", and none is decoration — which is why, like the
desktop's, none is gated behind reduced-motion (see `sessions.css`: Windows reports
"reduce" whenever OS animations are off, which would silently kill the only liveness cue).

- **Working spinner** — `StateDot`, 700ms.
- **Working orbit** — `Card`'s `orbit` prop, 2400ms. A bright segment of the hue laps the
  card's whole border, corners included, over a dim full-perimeter track; an orbiting card
  sets its own `borderColor: transparent` so the lap isn't drawn over a second static
  edge. A **needs-you** card is lit but still; only **working** moves.

  It's an SVG `Rect` stroke, not a View: only a stroked path follows the rounded corners.
  The segment is one dash of a two-dash-per-perimeter pattern, and the perimeter is
  computed *exactly* (`2(W−2r) + 2(H−2r) + 2πr` — four straights plus four quarter-corners
  making one circle), so sliding `strokeDashoffset` by one perimeter per cycle seams
  invisibly. An approximation drifts a little each lap and stutters at the seam.

  **This is the one animation that can't use the native driver** — RN can't hand SVG props
  to it, so it ticks on the JS thread. Affordable only because it's bounded by what's on
  screen: only *working* cards mount it. Don't reach for this shape for something that
  could be on every row.

  **The orbit replaced a `ShimmerBar`** — a 2px track along the card's bottom edge with a
  bar sweeping left to right. A running card carried both for a while and read as two
  unrelated animations arguing; the orbit says the same thing around the whole frame, so
  the shimmer went. It was the component's only caller, so it's gone from `ui.tsx` too.
  If a *linear* progress signal is ever wanted again, it's in this file's git history —
  but think first about whether the orbit already says it.
- **Finish flash** — `SessionsScreen`'s `FinishFlash`, 1200ms, matching the desktop's
  `sess-finish-flash`: a 34% green wash fading out on `working → completed`.

### Why the finish celebration is driven from the screen

`StateDot` detects `working → completed` itself, which works wherever it stays mounted
(ChatScreen). **In the sessions list it cannot**: that transition moves the row from the
Working section to Settled, and `SectionList` remounts a row that changes section — so the
dot arrives already `completed` and its own prev-state tracking sees nothing happen.
`SessionsScreen` keeps a `seenState` map that outlives the remount and passes the verdict
down as `celebrate` / `justFinished`. Don't "simplify" that back into the dot.

## Deviations from the mock, and why

Worth knowing before "fixing" one of these back:

- **The New-session button stays the docked split button**, not the mock's floating FAB.
  That was an explicit call: keep the layout the app has always had (and the desktop's
  own `#new-session` / caret pair), restyled to the new system — a pill radius, and the
  model name behind a divider instead of inside the label. The model dropdown the FAB
  specified hangs off the caret half.
- **Session cards keep their archive / restore / delete buttons.** The mock draws only a
  chevron; following it literally would have dropped the actions with nothing to replace
  them.
- **A `completed` row with uncommitted work also grows an icon-only commit button**
  (`git-commit-outline`, green) that fires the same `commit-session` request as
  ChatScreen's commit; it swaps to a spinner of the same footprint while in flight, and
  disappears (rather than disabling) when there's nothing to commit or after the push.
- **Notifications is a pushed stack screen, not a fifth tab.** The mock draws it with a
  back chevron (so: pushed) but never mocks an entry point, and every other mock shows a
  strictly 4-tab bar. The bell in `ScreenHeader` is that entry point — invented, because
  the design left the hole.
- **Alerts are three kinds, not the mock's five — and they're real, not a fixture.**
  `3e` draws waiting-for-answer, session-finished, committed-and-pushed, push-rejected
  and approaching-usage-limit; `AlertKind` keeps `input` (green), `error` (red) and
  `usage` (yellow) — one colour per kind. An alerts list is for what needs attention:
  a run finishing or a push landing is routine good news, already visible on the sessions
  list, and would bury the one that actually went wrong. This is a decision, not an
  omission — restoring them re-opens it. `AlertFeed` (mounted once in `App.tsx`, inside
  the provider) derives alerts on the phone from what the connection already pushes:
  `status` transitions into `needs-input`/`interrupted` (deduped per session; a stale
  `input` alert is dropped when the session moves on) and a 60s `get-usage` poll that
  warns once per 5-hour window above 75%. The store is in-memory only; a protocol-side
  alert log (`query-notifications`/`notifications-changed`) would replace only AlertFeed.
- **The usage ring keeps the green→yellow→red ramp** rather than the mock's flat green,
  and carries a **centre label**: the arc is how much of the 5-hour window is spent, the
  middle is when it comes back. Fitting a label is why it's 30px with a 2.5 stroke rather
  than the mock's 24/4 — a 24px ring thinned enough to open a hole leaves ~8px of text,
  which is inside the ring but not readable. Tapping it opens `UsagePanel` — a popup
  anchored under the ring — with both rolling windows' percentages and resets, i.e. what
  the desktop's toolbar meter shows side by side but a phone header has no room for. Its
  Android modal/inset handling is subtle and documented in
  [remote-access.md](remote-access.md); don't simplify it without reading that.
- **Git's branch row and Changes/History switch are on the page, not in the frame.**
  The mock packs the title, the branch/pull/push row and the switch all into the header
  block, which made the frame most of the screen. The frame keeps the title (like every
  other tab — see *The pieces*); only the controls moved below it. That move inverts
  their surfaces: a recessed `bg` fill reads as a well against the header's gradient but
  vanishes into the page, so on the page the branch chip, the pull/push buttons and the
  segmented track are `surface` and read as raised, with the ahead/behind badge ring
  following to `bg`. Sessions keeps its segmented control *in* the frame — it's three
  tabs of the same list, not a toolbar of separate controls.
- **File icons stay `FileIcon`** (the desktop's generated set). The mock's
  `logo-javascript` ionicons are placeholders — turn 1's own note says so.
- **The file editor keeps CodeView's `#1e1e1e` surface.** The two swap in place, and a
  GitHub-dark input behind VS-Code-themed syntax would look like a different file.

## Still open

The design's own follow-ups, none of them done: the **project drawer** and **run drawer**
are referenced but were never mocked, and no mock covers **Console/Terminal**, **Pair**,
or **commit history** — those screens are on the tokens but not on the redesign.
