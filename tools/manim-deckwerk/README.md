# manim-deckwerk

Write animations in manim, edit the deck in DeckWerk. Each manim-slides segment
becomes a video element with a stable id (`manim-<Scene>-<name>`). The first
sync puts each segment on its own full-bleed slide. Later syncs find the
element wherever it now is and swap only the clip, its poster and its loop
flag. Moving, resizing, cropping, effects, text added next to it, slides added
between, and reordering all survive a re-render.

## Use

```bash
cd tools/manim-deckwerk
uv venv && uv pip install -e .            # pins manim<0.20; 0.22 breaks manim-slides 5.7
# slide-agent is found in this checkout's bin/; override with SLIDE_AGENT=...

manim-deckwerk init examples/talk --title "My talk"
manim-deckwerk sync examples/demo.py Demo examples/talk          # render (-qh) + sync
manim-deckwerk sync examples/demo.py Demo examples/talk -q l     # fast draft
manim-deckwerk sync examples/demo.py Demo examples/talk --dry-run --no-render
```

Then open `talk/` in DeckWerk. Sync again whenever the scene changes. With the
editor open, DeckWerk should apply it as one undoable entry named
`manim sync: <Scene>`. That path is untested so far; only the closed-editor
path has been run.

## Naming segments

Subclass `DeckSlide` instead of `Slide` and name segments:

```python
from manim_deckwerk import DeckSlide

class Demo(DeckSlide):
    def construct(self):
        self.name_slide("title")            # the segment in progress
        ...
        self.next_slide(name="loss")        # ends it, names the next one
        ...
        self.next_slide(name="orbit", loop=True, notes="speaker notes")
```

A plain `Slide` works too, but segments are then keyed by position, so adding
a `next_slide()` early in the scene shifts every later clip onto the wrong
deck slide.

## Rules

- What the render owns: `src`, `poster`, `loop`, `autoplay`. Everything else on
  the element is yours.
- New segments go after the slide holding the previous segment.
- A segment removed from the scene deletes its slide if the clip is the only
  thing on it; otherwise only the clip is removed and the slide stays.
- Notes are written once, when a segment's slide is created.
- `auto_next`, `playback_rate` and static image segments have no DeckWerk
  equivalent and are skipped with a warning.
- Old clips stay in `assets/` after a re-render (no pruning yet).
