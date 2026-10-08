# Whale-girl desktop-pet character art

Hand-authored flat-vector SVG artwork for the DeepSeek "whale-girl" (鲸鱼娘) desktop pet.
No scripts, no bitmaps, no external references: every file is a standalone SVG document.

## Files

| File | What it is |
| --- | --- |
| `whale-girl.svg` | The full character, `viewBox="0 0 300 300"`, root `width="100%" height="100%"`. This is what the pet window renders. |
| `whale-badge.svg` | Head-only 64x64 round avatar/badge, used as the source for the tray icon. Deliberately simplified so it still reads at 16x16. |
| `preview.png` | Render sheet produced during authoring: all six moods at 300 px, all six at 240 px, plus the badge at 128/64/32/16 px. Not loaded by the app. |
| `png/` | Drop-in folder for PNG artwork — the `png/` subdirectory beside this README, i.e. `pet/assets/whale/png/` (see "Swapping in PNG art"). |

## Character anatomy (all inside the contract ids)

* **Head** (`whale-head`) — warm skin, chibi proportions, roughly 1:2.5 head-to-body.
* **Hair** — deep blue `#2C3E9E`; `whale-hair-back` is the long back mass whose tips fade to cyan
  `#7FE3FF`; `whale-hair-front` is the bangs: a fringe of pointed locks over the forehead plus two side
  locks framing the cheeks, with `#6B8CFF` highlight strands.
* **Whale cowl** (`whale-hood`) — a light-blue whale-shaped hood worn **behind/over** her own head: flat
  whale body, a white belly patch, twin flukes at the crown and a blowhole disc with two drawstrings. Its
  opening is cut wide enough that her face and both eyes sit completely outside it, so it never reads as a
  beard, and her dark hair frames the face between skin and cowl. The cowl drapes to the shoulders, where
  its side panels show beside her neck.
* **Torso** (`whale-body`) — a light hoodie body with a **white whale-belly patch**, a white collar panel
  and a soft blue under-shadow. Two short legs with rounded navy feet hang from the hem.
* **Arms** (`whale-fin-l`, `whale-fin-r`) — two chibi mitten arms. The left hangs down and outward; the
  right is raised toward the hem as if holding it.
* **Whale tail** (`whale-tail`) — a DeepSeek-blue fluke with cyan and `#3A55D9` shading, emerging behind
  her left hip so it stays visible in the silhouette.
* **Face** (`whale-face`, `whale-eye-l/r`, `whale-brow-l/r`, `whale-mouth`, `whale-blush-l/r`) — big
  expressive eyes (sclera + two-tone blue iris + navy pupil + two highlights), a small nose, an open
  smiling mouth with a tongue, thin brows, and blush.

## ID contract (animated by CSS)

`whale-girl.svg` wraps each logical part in a `<g>` with these ids; every id appears exactly once:

```
whale-root        root group of the whole character (mood state / overall motion)
whale-shadow      ground shadow under the character (soft #00000022 ellipse)
whale-tail        whale fluke behind her, pivot at its base
whale-fin-l       her left arm / mitten hand, pivot at the shoulder
whale-fin-r       her right arm / mitten hand, pivot at the shoulder
whale-body        torso, hoodie, belly patch, legs and feet
whale-hair-back   long back hair mass with cyan tips
whale-hood        whale-shaped cowl worn over/behind the head
whale-head        head shape
whale-face        base face: nose, base mouth and cheek shading
whale-eye-l       whole left eye (sclera, iris, pupil, highlights) - blink target
whale-eye-r       whole right eye - blink target
whale-brow-l      left eyebrow
whale-brow-r      right eyebrow
whale-mouth       base neutral (smiling) mouth
whale-blush-l     left cheek blush
whale-blush-r     right cheek blush
whale-hair-front  bangs, side locks and highlight strands
whale-ornament    whale-fluke hairpin + blue hair clip (right side of the head)
```

Animation notes:

- No id-bearing group carries `rotate()` / `scale()` / `matrix()` in its own `transform` attribute, so the
  renderer's `transform-box: fill-box; transform-origin: center` works as intended: `whale-tail` sways
  about its base, `whale-fin-l` / `whale-fin-r` swing about the shoulder, `whale-ornament` bobs at the
  head, and `whale-head` / `whale-hood` / `whale-hair-*` bob as a unit.
- `whale-eye-l` and `whale-eye-r` are each a self-contained, rounded group containing the entire eye
  including both highlights. `transform: scaleY(...)` about the group centre therefore reads as a clean
  blink, with nothing left floating behind.
- The base face is a complete, valid idle character: with every `exp-*` group hidden you get the neutral
  smiling girl shown first in `preview.png`.

## Expression-group contract

Six sibling groups live directly inside `whale-root`:

```
exp-idle        empty - the base face IS idle
exp-happy       closed smiling eyes, open grin, extra blush, sparkles
exp-thinking    one raised brow, wry mouth, thought bubble, cyan arc
exp-working     open mouth, cyan gear with teeth below the head
exp-sleepy      closed eyes, sleeping "o" mouth, three "z" polygons
exp-surprised   raised brows, open "o" mouth, sweat drop, motion ticks
```

Each group holds **only what differs from idle** (eye/brow arcs, a replacement mouth, and symbols).
**No `exp-*` group carries an inline `style` attribute** — the host is responsible for visibility, e.g.:

```css
#exp-happy, #exp-thinking, #exp-working, #exp-sleepy, #exp-surprised { display: none }
[data-mood="happy"] #exp-happy { display: inline }
[data-mood="working"] #exp-working { display: inline }
/* ...same pattern for thinking / sleepy / surprised */
```

Because the base eyes and mouth stay visible, a mood group is drawn *on top of* them; the replaced
features (closed-eye arcs, the different mouth) are painted over their base counterparts. If you prefer
hard swaps, add `[data-mood="happy"] #whale-eye-l, [data-mood="happy"] #whale-eye-r { display: none }`
alongside the mood rule.

There is no `<style>` element, no `<script>`, no `<foreignObject>`, no `<image>`, no `<text>`, no
`url(#...)` reference and no XML comment in either file, so they are safe to inline directly into the
renderer's DOM.

## Palette

| Role | Hex |
| --- | --- |
| DeepSeek blue (whale tail, hair clip, cowl accents, iris) | `#4D6BFE` |
| Blue highlight (hair shine, tail lobes, cowl shading) | `#6B8CFF` |
| Blue shadow / secondary | `#3A55D9` |
| Hair base | `#2C3E9E` |
| Cyan tips / accent (hair ends, fluke, symbols, gear) | `#7FE3FF` |
| Deep navy outlines, pupils, brows, lashes | `#1B2559`, `#232A4D` |
| Skin | `#FFE3D5`, shade `#F3C4AE` |
| Blush | `#FF9AA8` |
| Hoodie / cowl cloth | `#DCE6FF`, shading `#B9C8F0` |
| White (belly patch, collar, sclera, highlight) | `#FFFFFF` |
| Soft ground shadow | `#00000022` |

All fills are flat, hand-authored `path` / `ellipse` / `circle` / `rect` / `polygon` geometry. There are no
gradients, no filters and no randomness, so nothing degrades at 200-300 px. Every coordinate stays inside
`y <= 292`, so the ground shadow is never clipped.

## Swapping in PNG art

The whole SVG can be replaced with raster artwork without touching the id contract's consumer:

1. Drop frames into `pet/assets/whale/png/` (the `png/` subdirectory beside this README) using the mood names,
   e.g. `idle.png`, `happy.png`, `thinking.png`, `working.png`, `sleepy.png`, `surprised.png`.
   Square, ideally 256x256 or 512x512, transparent background, same character framing.
2. The window's art loader (`pet/pet.js`, `mountPngArtwork`) probes that directory at startup and
   uses the PNGs automatically; the mood id (`data-mood`) maps 1:1 onto the file name, and a missing
   mood falls back to `idle.png`.
3. Keep `whale-badge.svg`, or supply `png/tray.png` (16-32 px, with `png/icon.png` as the fallback)
   for the tray icon: `pet/electron-main.cjs` looks for `tray` first, then `icon`.

Nothing in `whale-girl.svg` / `whale-badge.svg` needs to change in that case — the PNGs simply take over
rendering, and the SVGs remain as the vector fallback.
