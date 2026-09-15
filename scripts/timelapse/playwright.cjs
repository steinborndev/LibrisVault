/**
 * Where the two timelapse drivers get Playwright from.
 *
 * It is not a dependency of this repo and should not become one: the drivers are a promo
 * tool run by hand a few times a year, and a browser download in everyone's `npm ci` is a
 * high price for that. So it is resolved at run time, from the environment first:
 *
 *   PLAYWRIGHT_MODULE=/path/to/playwright/index.js   an explicit module path
 *   PLAYWRIGHT_MODULE=playwright                     a plain name, resolved normally
 *
 * and otherwise as an ordinary `require('playwright')`, which finds it when the machine has
 * one installed somewhere Node looks. The line used to be an absolute path into one
 * developer's npx cache, which is both a leak and broken for everyone else.
 */
module.exports = function requirePlaywright() {
  const fromEnv = process.env.PLAYWRIGHT_MODULE
  for (const spec of [fromEnv, 'playwright'].filter(Boolean)) {
    try {
      return require(spec)
    } catch {
      /* try the next one, and report both if none works */
    }
  }
  console.error(
    'playwright not found. Install it (npm i -g playwright && playwright install chromium),\n' +
      'or point PLAYWRIGHT_MODULE at an existing copy:\n' +
      '  PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.js node scripts/timelapse/frames.cjs ...',
  )
  process.exit(1)
}
