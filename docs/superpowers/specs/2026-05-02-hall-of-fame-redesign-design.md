# Hall of Fame Redesign — "After Hours Dark Dossier"

## Goal

Replace the current Hall of Fame page (generic dark-gradient grid of yellow-bordered tiles) with a thematic case-file archive that visually commits to the mugshot premise the app already uses. The redesign should remove "AI slop" defaults — uniform rounded grid, soft radial gradients, polite uppercase tracking — and replace them with specific, tactile elements (manila folders under a desk lamp, rubber stamps, typewriter metadata).

## Scope

In scope:

- `.gallery-screen`, `.gallery-header`, `.clear-gallery-button`, `.gallery-grid`, `.gallery-card`, `.gallery-card-copy`, `.gallery-empty` styles in `src/styles.css`
- The card markup inside the `v-for` in `src/App.vue` (lines ~845–854) — restructured into header strip / mugshot panel / metadata strip / status stamp
- The empty-state markup (lines ~856–859) — replaced with a single-folder treatment

Out of scope:

- Vue logic, data shape, `entry.kind` semantics, sync, Firebase
- The 2-col → 1-col mobile breakpoints (kept as-is, with values re-tuned to fit new card width)
- Any other screen (`.viewer-screen`, `.admin-screen`, `.start-panel-shell`, etc.)

## Visual Design

### Page background ("after hours" desk)

- Base: dark walnut `#1a120b` with a low-opacity wood-grain noise (CSS `background-image` using a small repeating SVG or a `data:` URL — no external asset).
- Lamp pool: a single radial gradient anchored at roughly `25% 12%`, warm `rgba(255, 224, 158, 0.18)` fading to transparent over ~36rem. This is the only warm light on the page; everything outside the pool reads cooler/darker.
- Vignette: subtle radial darkening at the corners so the lamp pool feels punched out of darkness.

### Header

- Top strip: monospace, letter-spaced — `FOCUSMAXXER // INTERNAL AFFAIRS — CASE ARCHIVE`. Color: brass `#c9a86a`. Reads as nameplate engraving.
- Wordmark: a single torn manila scrap, taped down with two `::before`/`::after` cellophane-tape strips at the top corners (semi-transparent off-white, slight skew). On the scrap: `HALL OF FAME` in a heavy slab-serif (we already have `--font-display`) printed in red ink, slight rotation `-1.5deg`. Edge of the scrap uses a CSS `mask-image` with an SVG torn-edge path so the bottom is uneven.
- Subline below the wordmark: `FILES ON RECORD: {{ hallOfFame.length }} // JURISDICTION: SIGMA COUNTY` in typewriter font, brass color.

### Clear button — "INCINERATE ARCHIVE"

- Red wax-seal styling: circular-ish blob (`border-radius: 48% 52% 50% 50%` for organic edge), background `#a01a22` with inner gradient suggesting wax sheen, slight `box-shadow` for thickness. Text: `INCINERATE` in tight slab-serif, embossed (text-shadow 1px dark above + 1px light below).
- Slight rotation `2deg`.
- Disabled state: drained color, "PENDING…" copy.

### Card — manila dossier under lamplight

Each card is ~280px wide, deterministic rotation between -2° and +2° using `entry.id`-derived hash so position is stable across re-renders.

Internal structure (top → bottom):

1. **Folder tab strip** — top edge of the card sticks up ~14px on the left (a `::before` element) like a manila folder tab. Tab contains: `CASE #` + last 4 of `entry.id` in monospace. Background slightly darker than the card body.
2. **Date stamp** — top-right, formatted `2026-05-02 // 14:11`, monospace, brass, low opacity (~0.7).
3. **Mugshot panel** — `entry.imageUrl`, desaturated (`filter: saturate(0.6) contrast(1.1)`), with a black height-rule strip overlaid at the bottom of the photo: `5'2  5'4  5'6  5'8  5'10  6'0` in monospace, white on black. The strip is a sibling element absolutely positioned over the photo bottom.
4. **Metadata strip** — typewriter font, key-value rows separated by leader dots:
   - `NAME ………… {{ auraTitle }}`
   - `CHARGE ……… {{ offense }}`
   - `AURA Δ ……… {{ auraScore }}`
   Implemented as a flex row with a `::after` of repeating dots filling the space between key and value.
5. **Status stamp** (overflows the card edges, `overflow: visible` on the card):
   - `negative` → red rotated rubber stamp `WANTED — AT LARGE`. Double-ringed border, slight ink-broken texture via mix of low-opacity noise and asymmetric `text-shadow`. Rotation `-8deg`. Sits in the bottom-right, partially off the card.
   - `positive` → gold foil seal `COMMENDED — SIGMA OF VALOR`. Same shape language but circular with star ornaments, gold gradient `#d8b25a` → `#a37e2c`. Sits in the bottom-left.

### Folder color shading by lamp distance

Cards near the top-left of the grid are brighter (`filter: brightness(1.0)`). Cards farther from the lamp pool are progressively cooler/darker. Approximation: apply `filter: brightness(0.92)` to cards in rows ≥ 3 via `:nth-child` ranges. Cheap, no per-card calculation needed. Subtle effect — cards still readable.

### Empty state

A single full-size manila folder centered in the lamp pool, slightly open. A Post-it note paper-clipped to it reads `No cases on file. Yet.` in handwritten-style font (fallback to italic of the existing terminal font if no handwritten font is available — no new font load). The Post-it is rotated `-3deg`. The folder is rotated `1deg`. The "JURISDICTION" subline is hidden in this state.

### Motion

- Initial render: cards stagger-fade in. Each card starts at `opacity: 0; transform: translateY(8px) rotate(0deg)`, settles to its assigned rotation with a ~250ms ease. Stagger delay: 60ms, capped at 12 cards (no need to stagger 50 deep).
- Hover: card lifts `translateY(-6px)`, rotation snaps to 0°, drop-shadow deepens. 180ms ease.
- `prefers-reduced-motion`: cards fade in only, no rotation animation, no hover lift. Final rotations still applied (so the page doesn't suddenly look sterile), just no motion to get there.

## Implementation Notes

- **No new asset files.** All textures (wood grain, paper noise, torn edge mask, height-rule strip) are inline SVG / CSS gradients / `data:` URLs. This keeps the redesign a pure code change and avoids polluting `public/`.
- **Stable rotation hash.** Add a small computed helper in the `v-for` that derives a rotation from `entry.id`, e.g. `rotationFor(entry.id)` returning `-2`, `0`, or `2` based on a character-sum mod. Avoids re-render jitter and keeps it test-free.
- **Mobile.** At ≤560px, cards go to single column, rotation is forced to 0°, status stamps shrink ~15% to stay on-card. The folder-tab and torn-paper wordmark scale down proportionally. Lamp pool re-anchors to `50% 0%` so the warm light still reads on a narrow viewport.
- **Performance.** No box-shadow on a per-card hover transition above ~12 cards visible at once is fine on mobile Safari; if it judders, drop the shadow transition and only animate transform.
- **Accessibility.** Status stamps include visually-hidden text already implied by the markup (`auraTitle` is the strong tag). The decorative folder tab and date stamp use `aria-hidden="true"`. Mugshot keeps its existing `alt`.

## File Changes

- `src/App.vue`: rewrite the inside of the `v-for` `<article class="gallery-card">` block (~lines 845–854) and the `.gallery-empty` block (~lines 856–859). Add a small `rotationFor(id)` helper to the `<script setup>` section. The header block (lines 835–843) gets restructured to add the typewriter subline and the torn-paper wordmark wrapper.
- `src/styles.css`: replace the entire `Hall of Fame gallery` section (~lines 899–1055). New section is roughly the same size — no big bloat.

No other files touched.

## Risks / Open Questions

- **Browser support for SVG masks** (the torn-paper edge): Safari 14+ supports `mask-image: url(data:...)`, which covers the demo target. Fallback if needed: a plain `clip-path: polygon(...)` with hand-drawn jagged points.
- **Custom fonts.** This design references "typewriter" and "handwritten" feel — verify what `--font-terminal` and `--font-display` resolve to before assuming. If `--font-terminal` is already a typewriter-ish mono, no new fonts. If it isn't, fall back to `Courier Prime`-style system stack: `'Courier New', ui-monospace, monospace`. No new web-font loads.
- **Hackathon demo timing.** Variant B (dark) was chosen partly because it screenshots well for socials. If demo lighting is bright/projector-washed, paper variant A would actually read better — but that decision is made and we're not re-litigating it.
