# Library screen design canvas

Working files for the Library screen mockups (SPEC section 10), first design round of
2026-09-05. The published canvas lives at
https://claude.ai/code/artifact/379c5aa8-9b7d-40e8-9bd9-3a9e7eb59ace

**These show the room as first designed, not as it stands.** The main room was refurnished on
2026-09-17 (SPEC section 10.13: ten desks, the book cart, the pinboard, chalkboards, glazed
doors, open cases); the artboards are kept as the record of the design rounds that preceded it.

- `gen.mjs` renders the four artboards from the dashboard's light-theme tokens and the
  demo vault's department counts (`counts.json`, read from the dev instance's graph API).
- `Main.dc.html` the main room by day, `Wing.dc.html` Wing A with a shelf being dragged onto
  Wing B, `Night.dc.html` the main room in the night shift, `Focus.dc.html` focus mode in Wing A
  with the Fellow popover, `Card.dc.html` the docked Fellow card, `Rooms.dc.html` the one-room-
  per-view model with capacity and drag-and-drop rules, `Textures.dc.html` the texture options
  (Archive chosen), `Sprites.dc.html` the style A pose vocabulary. `canvas.json` lays them out.
- Rebuild: `node gen.mjs`, then assemble with the design canvas tool from the artboards.

Everything drawn is synthetic: department names and counts come from the demo vault, the
Fellows and topics are invented.
