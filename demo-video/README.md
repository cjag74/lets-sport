# Let's Sport — demo video

`demo.mp4` is a ~70 second, 1920x1080, 30 fps walkthrough of the app with an AI voiceover, burned-in subtitles and soft background music.

## Regenerate it

```bash
npm install
npm run build
```

The build is fully automatic (takes about 2 minutes):

1. **Voiceover** — `tts.py` voices each scene in `scenes.json` with edge-tts (`en-US-AriaNeural`, +5% rate) and saves word timings.
2. **Demo app** — starts `../server.js` on port 3055 with a throwaway database (`build/demo.db`) and seeds the demo games. Your real `data/letssport.db` is never touched.
3. **Recording** — `record.mjs` drives Chromium with Playwright at 1920x1080, with a drawn cursor and smooth mouse movement. Each scene lasts as long as its narration plus a short pause.
4. **Subtitles** — `demo.srt` is built from the spoken word timings (max 2 lines, ≤42 characters per line).
5. **Music** — a gentle, upbeat I–vi–IV–V loop synthesized with ffmpeg (no third-party audio). It sits ~25 dB under the voice, ducks further via `sidechaincompress` while the narrator speaks, and fades in/out.
6. **Mix** — final loudness about −16 LUFS, H.264 + AAC, with subtitles burned in.

## Files

| File | What it is |
|---|---|
| `demo.mp4` | Final video |
| `demo.srt` | Subtitles (also burned into the video) |
| `script.md` | Scene-by-scene script |
| `scenes.json` | Narration text per scene (edit this to change the voiceover) |
| `audio/` | Per-scene voice clips, `narration.wav`, `music.wav`, `final_mix.wav` |
| `build.mjs`, `record.mjs`, `tts.py` | The build pipeline |
| `build/` | Temporary frames and intermediates (safe to delete) |

## Requirements

- Node.js 22.5+, ffmpeg (`winget install Gyan.FFmpeg`), Python 3.12 with `pip install edge-tts`
- Playwright Chromium: `npx playwright install chromium`
- Internet access: edge-tts uses Microsoft's online speech service (no API key), and the Google Maps embeds load live.

Options: `DEMO_VOICE=en-US-JennyNeural npm run build` to change the voice; `FFMPEG`, `FFPROBE`, `PYTHON` and `DEMO_PORT` to override tools or the port.
