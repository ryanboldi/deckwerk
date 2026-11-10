"""Render a manim-slides scene and sync its segments into a DeckWerk deck.

Each manim-slides segment becomes one video element with a stable id,
`manim-<Scene>-<name or index>`. The first sync puts each one on a new
full-bleed slide. Later syncs find the element wherever it now lives in the
deck and swap only what the render owns (the clip, its poster, loop), so
anything done to it in the editor (moving, resizing, cropping, effects, text
added on top, reordering slides) survives a re-render.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

QUALITY = {"l": "-ql", "m": "-qm", "h": "-qh", "k": "-qk"}

# Fields the render owns. Everything else on an existing element is the
# user's and is copied through untouched.
OWNED = ("src", "poster", "loop", "autoplay")
# Editor-side state that the live inspect reports more freshly than deck.json.
LIVE_GEOMETRY = ("x", "y", "w", "h", "rot", "z", "opacity")
LIVE_MEDIA = ("fit", "sourceBox", "effects", "borderColor", "borderWidth", "borderRadius")


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


@dataclass
class Segment:
    index: int
    key: str
    file: Path
    loop: bool
    notes: str


class SlideAgent:
    def __init__(self, exe: str, deck: Path):
        self.exe = exe
        self.deck = deck

    def run(self, *args: str, check: bool = True) -> dict:
        proc = subprocess.run([self.exe, *args], capture_output=True, text=True)
        if check and proc.returncode != 0:
            raise RuntimeError(
                f"slide-agent {' '.join(args[:2])} failed ({proc.returncode}):\n"
                f"{proc.stderr.strip()}\n{proc.stdout.strip()}"
            )
        out = json.loads(proc.stdout) if proc.stdout.strip() else {}
        out["_exit"] = proc.returncode
        return out


def find_slide_agent(explicit: str | None) -> str:
    for cand in (explicit, os.environ.get("SLIDE_AGENT"), shutil.which("slide-agent")):
        if cand:
            return cand
    home = os.environ.get("DECKWERK_HOME")
    if home and (Path(home) / "bin/slide-agent").exists():
        return str(Path(home) / "bin/slide-agent")
    # Installed from tools/manim-deckwerk inside a DeckWerk checkout.
    repo = Path(__file__).resolve().parents[3] / "bin/slide-agent"
    if repo.exists():
        return str(repo)
    raise SystemExit("can't find slide-agent: pass --slide-agent, or set SLIDE_AGENT or DECKWERK_HOME")


def render(scene_file: Path, scene: str, quality: str) -> None:
    cmd = ["manim-slides", "render", QUALITY[quality], scene_file.name, scene]
    log(f"$ {' '.join(cmd)}  (in {scene_file.parent})")
    # manim logs to stdout; keep stdout for the JSON report.
    subprocess.run(cmd, cwd=scene_file.parent, check=True, stdout=sys.stderr)


def safe(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", s).strip("-")


def load_segments(slides_dir: Path, scene: str) -> list[Segment]:
    cfg_path = slides_dir / f"{scene}.json"
    if not cfg_path.exists():
        raise SystemExit(f"{cfg_path} not found; render the scene first")
    cfg = json.loads(cfg_path.read_text())
    sidecar = slides_dir / f"{scene}.deckwerk.json"
    names = json.loads(sidecar.read_text())["names"] if sidecar.exists() else []
    if names and len(names) != len(cfg["slides"]):
        log(f"warning: {sidecar.name} names {len(names)} segments but the render has "
            f"{len(cfg['slides'])}; ignoring names")
        names = []
    if sidecar.exists() and sidecar.stat().st_mtime < cfg_path.stat().st_mtime - 5:
        log(f"warning: {sidecar.name} is older than {cfg_path.name}; was the scene "
            "switched from DeckSlide to Slide?")

    segs = []
    for i, s in enumerate(cfg["slides"]):
        if s.get("type", "video") != "video" or s.get("src"):
            log(f"warning: segment {i + 1} is a static '{s.get('type')}' slide; skipped")
            continue
        for field, default in (("auto_next", False), ("playback_rate", 1.0)):
            if s.get(field, default) != default:
                log(f"warning: segment {i + 1} sets {field}={s[field]}, which DeckWerk "
                    "has no equivalent for; ignored")
        name = names[i] if names else None
        segs.append(Segment(
            index=i,
            key=safe(name) if name else f"{i + 1:02d}",
            file=(slides_dir.parent / s["file"]).resolve(),
            loop=bool(s.get("loop", False)),
            notes=s.get("notes", "") or "",
        ))
    return segs


def first_frame(video: Path, out: Path) -> Path:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video), "-frames:v", "1", str(out)],
        check=True,
    )
    return out


def read_deck(agent: SlideAgent) -> tuple[dict, str, bool]:
    """Full deck JSON with live editor geometry overlaid, its revision, liveness."""
    ctx = agent.run("inspect", str(agent.deck), "--all")
    deck = json.loads((agent.deck / "deck.json").read_text())
    # deck.json can trail the open editor by an autosave; the live inspect
    # carries the geometry and crop a person may have just changed.
    live = {e["id"]: e for sc in ctx.get("scenes", []) for e in sc["elements"]}
    for slide in deck.get("slides", []):
        for el in slide.get("elements", []):
            seen = live.get(el["id"])
            if not seen:
                continue
            for k in LIVE_GEOMETRY:
                if k in (seen.get("authored") or {}):
                    el[k] = seen["authored"][k]
            for k in LIVE_MEDIA:
                if k in (seen.get("media") or {}):
                    el[k] = seen["media"][k]
    return deck, ctx["deckRevision"], bool(ctx.get("live"))


def sync(
    scene_file: Path,
    scene: str,
    deck_dir: Path,
    *,
    slide_agent: str,
    quality: str = "h",
    do_render: bool = True,
    after: str | None = None,
    dry_run: bool = False,
) -> dict:
    scene_file = scene_file.resolve()
    deck_dir = deck_dir.resolve()
    if not (deck_dir / "deck.json").exists():
        raise SystemExit(f"{deck_dir} is not a deck (no deck.json); run `manim-deckwerk init` first")
    agent = SlideAgent(slide_agent, deck_dir)

    if do_render:
        render(scene_file, scene, quality)
    segs = load_segments(scene_file.parent / "slides", scene)
    if not segs:
        raise SystemExit("the render produced no video segments")

    # Import clips and their first-frame posters in one call; asset import
    # dedupes by content hash, so an unchanged clip comes back at the same src.
    with tempfile.TemporaryDirectory() as tmp:
        posters = [first_frame(s.file, Path(tmp) / f"{scene}-{s.key}.png") for s in segs]
        paths = [str(s.file) for s in segs] + [str(p) for p in posters]
        imported = agent.run("asset", "import", str(deck_dir), *paths)
        if imported.get("failures"):
            raise SystemExit(f"asset import failed: {imported['failures']}")
        assets = imported["assets"]
        if len(assets) != len(paths):
            # Identical files collapse to one asset in a batch, so the output
            # can't be matched up by position; import one at a time instead.
            assets = [agent.run("asset", "import", str(deck_dir), p)["assets"][0] for p in paths]
    clip_src = [a["src"] for a in assets[: len(segs)]]
    poster_src = [a["src"] for a in assets[len(segs):]]
    durations = [a.get("duration") for a in assets[: len(segs)]]

    deck, revision, live = read_deck(agent)
    canvas = deck.get("canvas", {"w": 1920, "h": 1080})
    where: dict[str, tuple[dict, dict]] = {}
    for slide in deck.get("slides", []):
        for el in slide.get("elements", []):
            where[el["id"]] = (slide, el)

    prefix = f"manim-{safe(scene)}-"
    ops: list[dict] = []
    report = {"updated": [], "unchanged": [], "inserted": [], "removed": [], "warnings": []}

    # Where the next new slide goes: after the slide holding the previous
    # segment, so a segment added mid-scene lands mid-sequence.
    if after is not None:
        anchor = resolve_slide(deck, after)
    else:
        anchor = deck["slides"][-1]["id"] if deck.get("slides") else None

    for seg, src, poster, dur in zip(segs, clip_src, poster_src, durations):
        eid = prefix + seg.key
        if eid in where:
            slide, el = where[eid]
            new = dict(el)
            new.update(src=src, poster=poster, loop=seg.loop, autoplay=True)
            # A trim set in the editor is kept unless the new clip is too
            # short for it; a stale out-point would stop a loop after one pass.
            if dur and new.get("end") is not None and new["end"] > dur:
                report["warnings"].append(f"{eid}: trim end {new['end']}s is past the new clip's "
                                          f"{dur:.2f}s; reset to the full clip")
                new["start"], new["end"] = 0, None
            if all(el.get(k) == new.get(k) for k in OWNED):
                report["unchanged"].append(eid)
            else:
                ops.append({"op": "replaceElement", "slideId": slide["id"], "elementId": eid, "element": new})
                report["updated"].append(eid)
            anchor = slide["id"]
        else:
            sid = f"slide-{eid}"
            n = 2
            while any(s["id"] == sid for s in deck.get("slides", [])):
                sid, n = f"slide-{eid}-{n}", n + 1
            ops.append({
                "op": "insertSlides",
                "afterSlideId": anchor,
                "slides": [{
                    "id": sid,
                    "name": f"{scene} · {seg.key}",
                    "background": {"color": "#000000", "image": None},
                    "notes": seg.notes,
                    "elements": [{
                        "id": eid, "type": "video",
                        "x": 0, "y": 0, "w": canvas["w"], "h": canvas["h"], "z": 1,
                        "src": src, "poster": poster, "fit": "contain",
                        "autoplay": True, "loop": seg.loop, "muted": True,
                        "start": 0, "end": None,
                    }],
                    "timeline": [],
                }],
            })
            report["inserted"].append(eid)
            anchor = sid

    # Segments that no longer exist in the scene.
    current = {prefix + s.key for s in segs}
    for eid, (slide, el) in where.items():
        if not eid.startswith(prefix) or eid in current:
            continue
        if len(slide["elements"]) == 1:
            ops.append({"op": "deleteSlide", "slideId": slide["id"]})
        else:
            ops.append({"op": "deleteElements", "slideId": slide["id"], "elementIds": [eid]})
            report["warnings"].append(f"{eid} removed from slide {slide['id']}, which keeps its other objects")
        report["removed"].append(eid)

    report["live"] = live
    if not ops:
        report["result"] = "nothing to do"
        return report

    txn = {
        "version": 1,
        "expectedRevision": revision,
        "label": f"manim sync: {scene}",
        "operations": ops,
    }
    if dry_run:
        report["transaction"] = txn
        return report
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(txn, f)
    try:
        res = agent.run("transaction", "apply", str(deck_dir), f.name, check=False)
    finally:
        os.unlink(f.name)
    if res["_exit"] == 3:
        raise SystemExit("the deck changed while syncing (revision conflict); run sync again")
    if res["_exit"] != 0:
        raise SystemExit(f"transaction failed: {json.dumps(res, indent=2)}")
    report["result"] = {k: v for k, v in res.items() if k != "_exit"}
    return report


def resolve_slide(deck: dict, ref: str) -> str | None:
    if ref == "0":
        return None
    slides = deck.get("slides", [])
    if ref.isdigit():
        i = int(ref)
        if not 1 <= i <= len(slides):
            raise SystemExit(f"--after {ref}: deck has {len(slides)} slides")
        return slides[i - 1]["id"]
    if any(s["id"] == ref for s in slides):
        return ref
    raise SystemExit(f"--after {ref}: no such slide")


def init_deck(deck_dir: Path, title: str) -> None:
    if (deck_dir / "deck.json").exists():
        raise SystemExit(f"{deck_dir}/deck.json already exists")
    deck_dir.mkdir(parents=True, exist_ok=True)
    (deck_dir / "deck.json").write_text(json.dumps({"version": 1, "title": title, "slides": []}, indent=2))
    (deck_dir / "theme.css").touch()
