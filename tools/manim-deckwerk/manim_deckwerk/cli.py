"""manim-deckwerk: keep a manim-slides scene in sync with a DeckWerk deck.

    manim-deckwerk init talk/                      # empty deck folder
    manim-deckwerk sync scene.py Talk talk/        # render, import, upsert
    manim-deckwerk sync scene.py Talk talk/ --no-render --dry-run
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .sync import find_slide_agent, init_deck, sync


def main() -> None:
    p = argparse.ArgumentParser(prog="manim-deckwerk", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("init", help="create an empty deck folder")
    pi.add_argument("deck", type=Path)
    pi.add_argument("--title", default="Untitled")

    ps = sub.add_parser("sync", help="render a scene and sync it into a deck")
    ps.add_argument("scene_file", type=Path)
    ps.add_argument("scene")
    ps.add_argument("deck", type=Path)
    ps.add_argument("-q", "--quality", choices="lmhk", default="h",
                    help="manim quality (default h = 1080p60)")
    ps.add_argument("--no-render", action="store_true", help="use the existing slides/ output")
    ps.add_argument("--after", help="for a first sync: put new slides after this slide (id or number; 0 = first)")
    ps.add_argument("--dry-run", action="store_true", help="print the transaction, change nothing")
    ps.add_argument("--slide-agent", help="path to DeckWerk's bin/slide-agent")

    a = p.parse_args()
    if a.cmd == "init":
        init_deck(a.deck, a.title)
        print(json.dumps({"created": str(a.deck.resolve())}))
        return
    report = sync(a.scene_file, a.scene, a.deck,
                  slide_agent=find_slide_agent(a.slide_agent), quality=a.quality,
                  do_render=not a.no_render, after=a.after, dry_run=a.dry_run)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
