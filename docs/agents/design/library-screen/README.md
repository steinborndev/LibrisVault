# Library screen design canvas

Working files for the Library screen mockups (SPEC section 10), first design round of
2026-09-05. The published canvas lives at
https://claude.ai/code/artifact/379c5aa8-9b7d-40e8-9bd9-3a9e7eb59ace

- `gen.mjs` renders the four artboards from the dashboard's light-theme tokens and the
  demo vault's department counts (`counts.json`, read from the dev instance's graph API).
- `Main.dc.html` day view, `Night.dc.html` night shift, `Focus.dc.html` focus mode with the
  Fellow popover, `Card.dc.html` docked Fellow card, `Growth.dc.html` the growth model (today, the
  wing opening, a filled wing) from a first-fit auto layout, `Textures.dc.html` floor, wall and
  shelf options with three presets (Archive chosen), `Sprites.dc.html` the style A pose vocabulary (round 2; the
  style B pixel test of round 1 was dropped after the decision). `canvas.json` lays them out.
- Rebuild: `node gen.mjs`, then assemble with the design canvas tool from the artboards.

Everything drawn is synthetic: department names and counts come from the demo vault, the
Fellows and topics are invented.
