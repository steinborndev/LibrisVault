/**
 * Fixture spread for a project with `exactOptionalPropertyTypes` (2026-09-08).
 *
 * The tests build their objects as `base` plus overrides, and an override of `undefined` is
 * how they say "this fixture does not have that field" - a run with no label, a settled run
 * with no result. Under `exactOptionalPropertyTypes` that is not what `{ label: undefined }`
 * means: the type spells "absent" as the key being absent, and a present key holding
 * `undefined` is a different thing it refuses.
 *
 * So the spread deletes those keys instead of setting them. The fixtures keep the wording
 * they had, and they now mean what they say.
 */
export function fixture<T extends object>(base: T, over: { readonly [K in keyof T]?: T[K] | undefined }): T {
  const out = { ...base } as Record<string, unknown>
  for (const key of Object.keys(over)) {
    const value = (over as Record<string, unknown>)[key]
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  return out as T
}
