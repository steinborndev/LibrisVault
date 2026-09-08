# Graph timelapse

The vault's growth, drawn by the app itself: 1080x1080, labels off, domain colours, nothing
but the drawing area. Built for a promo clip, kept because it is the only view of the vault
that shows *time*.

## Why git and not the graph API

A `GraphNode` carries `mtimeMs`, which is when the page last CHANGED. A page written in April
and edited yesterday would date from yesterday - the wrong way round for a timelapse. Git has
the right answer and a better one: the whole state of the vault at any commit, so the edges
grow with the nodes instead of nodes popping into a finished web.

## Running it

```
# 1. one graph snapshot per sampled commit (a few minutes, no cost)
cd server && npx tsx src/cli/graph-timelapse.ts --vault ~/vault --out /tmp/frames --steps 140

# 2. either a PNG sequence, five stills per snapshot -> 20 s at 30 fps
node ../scripts/timelapse/frames.cjs /tmp/frames /tmp/png 5

# 3. or a WebM straight out of the browser, no encoder needed
node ../scripts/timelapse/video.cjs /tmp/frames /tmp/video 20
```

Both drivers need the dashboard running on `localhost:8421`; they intercept `/api/v1/graph`
to serve the snapshots and drive the reload through the app's own SSE path, so what gets
photographed is the real renderer on real data.

## The two things that make it watchable

**Sampling is by page count, not by time.** This vault grew 47 pages in April, 3 in May and
450 in August. Sampled evenly over time, a third of the film would be an empty screen.

**The camera and the layout are fixed before the rewind.** The last snapshot is loaded first,
the camera fitted to it, and only then is the film rewound to the beginning. The canvas keeps
its position memory per page path, so a node appears where it will stay instead of the whole
layout churning on every addition - which is the difference between a growth animation and a
seizure.

## The MP4

`frames.cjs` is the source to encode from: it writes exactly 1080x1080 and has no lead-in,
where `video.cjs` records the whole browser session and therefore carries its own setup as a
few seconds at the front.

```
ffmpeg -framerate 30 -i /tmp/png/f%05d.png \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart timelapse.mp4
```

`yuv420p` and `+faststart` are not decoration: without the first, some players refuse the
file; without the second, the whole thing has to download before it plays, which on a social
timeline means it does not play.

There is no system ffmpeg on this machine and installing one needs a password. Two ways
round it, in order of preference:

- `sudo apt install ffmpeg` - the ordinary answer, if someone is at the keyboard.
- `npm i --no-save ffmpeg-static` in a scratch directory, which fetches a full static build.
  Playwright ships an `ffmpeg` of its own under `~/.cache/ms-playwright/ffmpeg-*/`, but it is
  a stripped build with only `libvpx` and `png` and no mp4 muxer - it can make the WebM that
  `video.cjs` already makes, and nothing else.
