"""Generate one voiceover clip per scene with edge-tts, plus word timings for subtitles.

Usage: python tts.py scenes.json <out_dir> [voice] [rate]
Writes <out_dir>/<scene id>.mp3 and <out_dir>/words.json
"""
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

VOICE = sys.argv[3] if len(sys.argv) > 3 else "en-US-AriaNeural"
RATE = sys.argv[4] if len(sys.argv) > 4 else "+5%"


async def synth(text: str, out_path: Path):
    comm = edge_tts.Communicate(text, VOICE, rate=RATE, boundary="WordBoundary")
    words = []
    with out_path.open("wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "text": chunk["text"],
                    "start": chunk["offset"] / 1e7,          # 100-ns ticks -> seconds
                    "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                })
    return words


async def main():
    scenes = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    all_words = {}
    for s in scenes:
        path = out_dir / f"{s['id']}.mp3"
        for attempt in range(3):
            try:
                all_words[s["id"]] = await synth(s["text"], path)
                break
            except Exception as e:  # network hiccups: retry
                if attempt == 2:
                    raise
                print(f"  retrying {s['id']}: {e}")
        print(f"  voiced {s['id']} ({len(all_words[s['id']])} words)")
    (out_dir / "words.json").write_text(json.dumps(all_words, indent=1), encoding="utf-8")


asyncio.run(main())
