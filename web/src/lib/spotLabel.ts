/**
 * The spotlight community label (design choice 2026-09-24, variant B of five): the app's
 * display face at title size, two-tone - the words in text ink, the # marks in the domain's
 * hue - cut out of the edges and nodes beneath it by a halo in the ground colour. It reads as
 * a place name on a map, and stands apart from the domain-coloured dots, which the previous
 * light domain tint did not.
 *
 * Measured and painted in SCREEN pixels (the caller converts the box to world units for the
 * placement); `paint` draws with its top-left corner at (x, y).
 */

export interface SpotLabelColors {
  hue: number
  dark: boolean
  bg: string
  text: string
}

const FONT = '600 19px "Bricolage Grotesque", "Instrument Sans", system-ui, sans-serif'
/** Horizontal breathing room either side of the glyphs, inside the halo. */
const PAD_X = 5
const PAD_Y = 2
const HEIGHT = 25
const HALO_PX = 5

export function measureSpotLabel(ctx: CanvasRenderingContext2D, text: string): { w: number; h: number } {
  ctx.font = FONT
  return { w: ctx.measureText(text).width + 2 * PAD_X, h: HEIGHT }
}

export function paintSpotLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, c: SpotLabelColors): void {
  ctx.font = FONT
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.lineWidth = HALO_PX
  ctx.strokeStyle = c.bg
  ctx.strokeText(text, x + PAD_X, y + PAD_Y)
  // The domain hue as ink: dark enough on the light ground, light enough on the dark one.
  const hashInk = `hsl(${c.hue} 62% ${c.dark ? 68 : 48}%)`
  let cx = x + PAD_X
  for (const part of text.split(/(#)/)) {
    if (part === '') continue
    ctx.fillStyle = part === '#' ? hashInk : c.text
    ctx.fillText(part, cx, y + PAD_Y)
    cx += ctx.measureText(part).width
  }
}

/** The display face at any size - the Areas captions use it at their zoom-derived size. */
export const regionFont = (px: number): string => `600 ${px}px "Bricolage Grotesque", "Instrument Sans", system-ui, sans-serif`

/**
 * An Areas caption in the same voice as the spotlight's label, at a smaller size: centred on
 * `cx`, its top at `top` (screen pixels), halo scaled to the type.
 */
export function paintRegionLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, top: number, px: number, c: SpotLabelColors): void {
  ctx.font = regionFont(px)
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const x = cx - ctx.measureText(text).width / 2
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, px * 0.28)
  ctx.strokeStyle = c.bg
  ctx.strokeText(text, x, top)
  const hashInk = `hsl(${c.hue} 62% ${c.dark ? 68 : 48}%)`
  let at = x
  for (const part of text.split(/(#)/)) {
    if (part === '') continue
    ctx.fillStyle = part === '#' ? hashInk : c.text
    ctx.fillText(part, at, top)
    at += ctx.measureText(part).width
  }
}

