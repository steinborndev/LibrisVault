/**
 * GET /api/v1/health — liveness + a queue/jobs snapshot. Public (no auth) so the systemd
 * unit (M5) and smoke checks can probe it. Feeds the dashboard "Übersicht" tab (SPEC.md §6.1).
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { isAutoCommitDisabled } from '../../pipeline/vault-guards.js'

export function registerHealthRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/health', async () => {
    return {
      status: 'ok',
      // No vaultRoot here: this route is public (PUBLIC_PATHS), and once the token-mode
      // remote-bind seam is used it must not leak filesystem layout to the unauthenticated.
      // The authenticated settings route exposes it for the UI.
      // False = setup mode; drives the app-wide "set up your credential" banner.
      credentialConfigured: ctx.config.auth !== null,
      // True on a hosted read-only instance; the UI swaps write surfaces for demo notices.
      demoMode: ctx.config.demoMode,
      // The research agents extension (docs/agents/SPEC.md) is on: the UI shows its surfaces.
      fellows: ctx.fellows !== undefined,
      /*
       * False means the vault plugin's own hook is committing this service's writes out from
       * under it (hard rule 1). Read live rather than cached from startup: the flag is one
       * file in the vault, and a `git clean` in the vault takes it away without restarting us.
       * Safe on a public route: it says whether a guard holds, never where the vault is.
       */
      autoCommitDisabled: isAutoCommitDisabled(ctx.config.vaultRoot),
      queue: ctx.queue.stats(),
      jobs: ctx.store.counts(),
      // Client-side pre-checks (the dropzone warns before uploading a file the server
      // would 413) — TASKS-M3 §5 noted this as the missing proactive half of the cap.
      limits: { maxUploadBytes: ctx.config.server.maxUploadBytes },
    }
  })
}
