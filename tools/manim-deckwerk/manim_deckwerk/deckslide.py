"""A manim-slides `Slide` whose segments can carry stable names.

Plain manim-slides identifies segments only by position, so inserting a
`next_slide()` early in a scene shifts every later segment. Naming a segment
gives it an identity the DeckWerk sync can hold on to across re-renders:

    class Talk(DeckSlide):
        def construct(self):
            self.name_slide("title")          # names the segment in progress
            ...
            self.next_slide(name="equation")  # ends it; names the next one

Names are written to `slides/<Scene>.deckwerk.json` next to manim-slides' own
`slides/<Scene>.json`. Unnamed segments fall back to their position.
"""

from __future__ import annotations

import json
from typing import Any

from manim_slides import Slide


class DeckSlide(Slide):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._dw_names: list[str | None] = []
        self._dw_current: str | None = None

    def name_slide(self, name: str) -> None:
        """Name the segment currently being built."""
        self._dw_current = name

    def _dw_record(self, before: int) -> None:
        # manim-slides appends finished segments to self._slides; give each
        # new one the name that was current while it was being built.
        for _ in range(len(self._slides) - before):
            self._dw_names.append(self._dw_current)
            self._dw_current = None

    def next_slide(self, *args: Any, name: str | None = None, **kwargs: Any) -> None:
        before = len(self._slides)
        super().next_slide(*args, **kwargs)
        self._dw_record(before)
        self._dw_current = name

    def _add_last_slide(self) -> None:
        before = len(self._slides)
        super()._add_last_slide()
        self._dw_record(before)

    def _save_slides(self, *args: Any, **kwargs: Any) -> None:
        super()._save_slides(*args, **kwargs)
        names = self._dw_names[: len(self._slides)]
        names += [None] * (len(self._slides) - len(names))
        named = [n for n in names if n]
        if len(named) != len(set(named)):
            raise ValueError(f"duplicate DeckSlide names in {self}: {named}")
        path = self._output_folder / f"{self}.deckwerk.json"
        path.write_text(json.dumps({"names": names}, indent=2))
