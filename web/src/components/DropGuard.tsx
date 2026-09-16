/**
 * Swallows file drops that land anywhere but a real drop target.
 *
 * This is what is LEFT of the window-level drop handler (2026-09-16). It used to be a target
 * of its own: a drop anywhere in the app raised a full-screen blue veil and uploaded the files
 * on the spot. That made the drop itself the commitment, which is precisely what the Inbox
 * dropzone had already stopped doing - it holds a file and waits for the button, so there is
 * one moment of "yes, this one". Two doors with two different answers to "have I started
 * anything yet" is one door too many, and the wrong one was the easier to hit: the veil
 * covered the whole window, so a drop that missed the box by a pixel ingested without asking.
 *
 * What the window handler was ALSO doing has to stay, and it is the reason this file exists
 * rather than nothing at all: without `preventDefault`, a browser handed a dropped PDF opens
 * it, and the dashboard is gone from the tab. So a stray drop is now caught and dropped on the
 * floor. A drop on something that marks itself with `data-drop-target` is left entirely alone,
 * because that element is handling it.
 */

import { useEffect } from 'react'
import { ownsDrop } from '../lib/dropTarget.ts'

function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files')
}

export function DropGuard(): null {
  useEffect(() => {
    // `dragover` has to be prevented as well: without it the drop event never fires and the
    // browser navigates on its own, which is the behaviour this exists to stop.
    const swallow = (e: DragEvent): void => {
      if (!hasFiles(e) || ownsDrop(e.target)) return
      e.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
  return null
}
