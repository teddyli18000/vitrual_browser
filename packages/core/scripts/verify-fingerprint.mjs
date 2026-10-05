#!/usr/bin/env node
/**
 * verify-fingerprint.mjs — read the LIVE fingerprint surface of a real profile, assert its
 * consistency properties, then run that profile against a table of oracle and real sites.
 *
 * WHY THIS EXISTS, AND WHY IT IS TWO THINGS
 *
 * The owner's GitHub login was risk-controlled with "Automated (bot) activity on your network
 * (IP 103.152.113.33)". Two independent causes were found, and this script keeps them apart, because
 * blurring them produces a test that fails for a reason nobody can fix — and the next person "fixes"
 * it by weakening the assertion.
 *
 *   (a) OURS — and the assertion for it was WITHDRAWN, which is the honest outcome. An
 *       `innerWidth/innerHeight > 0` property was written here and then removed, because it cannot go
 *       red against reality: `_castToProperties` filters falsy values (`if (!data) continue`) and
 *       `properties.json` carries no defaults, so the key never reaches CAMOU_CONFIG and Firefox
 *       reports its real viewport — measured at `inner 1770x1246` on the unfixed build. An assertion
 *       that cannot distinguish the state it names from any other state is decoration; the geometry
 *       property below is what actually holds that line.
 *   (b) NOT OURS. That IP is a US datacenter address (Fremont CA, AS46997 Black Mesa Corporation).
 *       No browser change makes a hosting ASN look residential, and CI runs from a datacenter too —
 *       so a blocked real site is REPORTED, not failed.
 *
 * THE TWO VERDICT CLASSES, WHICH MUST NOT BLUR
 *   - ORACLE sites (third-party checkers) FAIL the run when they name a concrete inconsistency of
 *     ours. Those are actionable and ours.
 *   - REAL sites REPORT. A captcha or a block from a datacenter ASN is expected and never fails.
 *   - `UNREAD` is NEITHER. A site whose verdict cannot be extracted must never look like a pass —
 *     that is how a decorative guard is born (the packaging guard that scanned zero modules and
 *     passed everything).
 *
 * The property assertions and the verdict parser are pure functions of a plain object / a string, so
 * the CHECKER WIRING can be exercised without a browser. That is not coverage of reality: the live run
 * is the coverage, and a fixture only shows that an assertion is wired to the operands it names.
 *
 * Usage:
 *   node packages/core/scripts/verify-fingerprint.mjs --live              # launch a profile, read it
 *   node packages/core/scripts/verify-fingerprint.mjs --fixture good|geometry|contradiction
 *   node packages/core/scripts/verify-fingerprint.mjs --oracle-fixture <name>
 *   …--skip-sites                                                         # properties only
 *
 * Build prerequisite: `pnpm --filter @vfox/core build` (this imports ../dist/index.js).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/* ------------------------------------------------------------------------------------ the table */

/**
 * Every site, in one list.
 *
 * `kind`:
 *   - `oracle` — a third-party checker. FAILS the run on a named inconsistency of ours.
 *   - `real`   — a site a user actually uses. REPORTS captchas/blocks; fails only when the page does
 *                not render at all while every fingerprint property passed.
 *   - `data`   — a page that DISPLAYS values and has no verdict to give (the `browserleaks-*` pages,
 *                whose text is documentation prose plus a data table). Verdict `DATA` when values were
 *                read, and the page's own assertions are applied where something real is checkable.
 *                Treating these as verdict targets was a design error, not an extraction bug.
 *
 * `scope` is a list of candidate selectors for the RESULT REGION, tried in order. This matters more
 * than it looks: an anti-detect checker's page is guaranteed to contain the vocabulary we scan for —
 * browserscan describes itself as "a human-machine verification system using WebDriver and other
 * automation tools" in its own chrome, which produced a false FAIL on the first live run. The verdict
 * must come from the result region, and when no selector matches, the fallback is recorded in the
 * finding rather than silently trusted.
 *
 * Extraction is text-based rather than selector-value-based on purpose: third-party selectors change
 * without telling us, and a parse that stops matching degrades to UNREAD (visible) rather than
 * silently matching nothing (invisible).
 */
const SITE_TARGETS = [
  // ---------------------------------------------------------------- oracle sites (FAIL on a lie)
  {
    name: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    kind: 'oracle',
    parse: 'creepjs',
    // NO `waitMs` here. #82 removed it because it ADDED a fixed wait on top of the poll — 55 s total —
    // while the comment below says a fixed duration is the problem.
    //
    // `scope` names containers the inventory PROVED exist. The previous list — `#lies`, `.lies`,
    // `[class*="lie"]`, `#fingerprint` — returned 0 matches on every single one: they were guessed from
    // memory, which is the third time in this runner that guessing a page's markup has cost a round.
    scope: ['#fingerprint-data', 'fuzzy-fingerprint', '#fp-app'],
    // EXPAND COLLAPSED PANELS FIRST. The inventory lists dozens of `toggle-open-creep-*` /
    // `toggle-close-creep-*` ids, so the panels are collapsible and a COLLAPSED panel's content is very
    // likely not in the DOM at all — which is exactly what `#lies: 0 matches` plus a 3999-character
    // body containing no count looks like. `toggle-open` is the state needed when they are closed.
    expand: '[id^="toggle-open-creep-"]',
    // If expanding still produces no panel, poll for the VERDICT SHAPE rather than for an element — a
    // percentage near "trust", or the word "lies" — inside the app container. CreepJS's full analysis is
    // slow and a CI runner is not fast, so this budget is longer than the element poll. The output says
    // WHICH of the two paths produced content, so a run cannot be read as one when it was the other.
    textPattern: /\b(\d+\s+lies?|trust[^\d%]{0,20}\d{1,3}\s*%)\b/i,
    textTimeoutMs: 45_000,
    waitFor: ['#fingerprint-data', 'fuzzy-fingerprint', '#fp-app'],
    panelTimeoutMs: 30_000,
  },
  {
    name: 'sannysoft',
    url: 'https://bot.sannysoft.com/',
    kind: 'oracle',
    parse: 'sannysoft',
    waitMs: 5_000,
  },
  {
    name: 'browserscan',
    url: 'https://browserscan.net/bot-detection',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 10_000,
    scope: ['[class*="result"]', '[class*="detect"]', 'main', 'article'],
  },
  {
    name: 'pixelscan',
    url: 'https://pixelscan.net/fingerprint-check',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 12_000,
    scope: ['[class*="result"]', '[class*="check"]', 'main'],
  },
  {
    name: 'deviceandbrowserinfo',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 8_000,
    scope: ['[class*="result"]', 'main', 'article'],
  },
  {
    name: 'browserleaks-canvas',
    url: 'https://browserleaks.com/canvas',
    kind: 'data',
    waitMs: 8_000,
    scope: ['#content', 'main'],
  },
  {
    name: 'browserleaks-webgl',
    url: 'https://browserleaks.com/webgl',
    kind: 'data',
    waitMs: 8_000,
    scope: ['#content', 'main'],
  },
  {
    name: 'browserleaks-webrtc',
    url: 'https://browserleaks.com/webrtc',
    kind: 'data',
    waitMs: 10_000,
    scope: ['#content', 'main'],
    // The one checkable assertion on this page, and a real leak test: if WebRTC reports a public
    // address that is not the one we exited from, that is a leak and it fails us.
    assertNoForeignIp: true,
  },
  {
    name: 'browserleaks-fonts',
    url: 'https://browserleaks.com/fonts',
    kind: 'data',
    waitMs: 8_000,
    scope: ['#content', 'main'],
  },
  {
    name: 'coveryourtracks',
    url: 'https://coveryourtracks.eff.org/',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 15_000,
    scope: ['#test-result', '[class*="result"]', 'main'],
    // The live run read the EFF's intro prose ("A Project of the Electronic Frontier Foundation See
    // how t…"), which is page chrome: this page has no verdict until its own test is run.
    clickBefore: '#click-me, a[href*="test"], button[type="submit"]',
  },
  {
    name: 'amiunique',
    url: 'https://amiunique.org/fingerprint',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 12_000,
    scope: ['[class*="result"]', 'main'],
  },
  {
    name: 'whoer',
    url: 'https://whoer.net/',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 12_000,
    scope: ['[class*="result"]', '.score', 'main'],
  },
  {
    name: 'iphey',
    url: 'https://iphey.com/',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 12_000,
    // NO `main` fallback: iphey's own marketing copy lives in `main` and contains "Bot Check", which
    // produced a false FAIL. With only result-region selectors, a miss is recorded as
    // "[read from the whole body: …]" so a reviewer can see the scope failed rather than the page.
    scope: ['[class*="result"]', '[class*="check"]', '[class*="score"]'],
  },
  {
    name: 'areyouheadless',
    url: 'https://arh.antoinevastel.com/bots/areyouheadless',
    kind: 'oracle',
    parse: 'generic',
    waitMs: 8_000,
  },

  // --------------------------------------------------------------------- real sites (REPORT only)
  {
    name: 'github-login',
    url: 'https://github.com/login',
    kind: 'real',
    expectForm: 'login',
    waitMs: 0,
  },
  {
    name: 'bing',
    url: 'https://www.bing.com/',
    kind: 'real',
    expectSelector: 'input[name="q"], #sb_form_q',
    waitMs: 3_000,
  },
  {
    name: 'duckduckgo',
    url: 'https://duckduckgo.com/',
    kind: 'real',
    expectSelector: 'input[name="q"], #searchbox_input',
    waitMs: 4_000,
  },
  {
    name: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Main_Page',
    kind: 'real',
    expectSelector: '#searchInput, .mw-search-input, #mw-content-text',
    waitMs: 2_000,
  },
  {
    name: 'reddit',
    url: 'https://www.reddit.com/',
    kind: 'real',
    expectSelector: 'faceplate-search-input, input[name="q"], shreddit-app, #siteTable',
    waitMs: 6_000,
  },
  {
    name: 'amazon',
    url: 'https://www.amazon.com/',
    kind: 'real',
    expectSelector: '#twotabsearchtextbox, input[name="field-keywords"]',
    waitMs: 4_000,
  },

  // --------------------------------------------------- aggressive anti-bot, where a bad fingerprint
  // shows up first. These refuse a browser whose fingerprint does not hold together, which is exactly
  // what this product is for — so they are the most informative real targets in the list.
  {
    name: 'google',
    url: 'https://www.google.com/',
    kind: 'real',
    expectSelector: 'textarea[name="q"], input[name="q"]',
    waitMs: 3_000,
  },
  {
    name: 'google-search',
    url: 'https://www.google.com/search?q=test',
    kind: 'real',
    expectSelector: '#search, #rso, div[data-sokoban-container]',
    waitMs: 4_000,
  },
  {
    name: 'taobao',
    url: 'https://www.taobao.com/',
    kind: 'real',
    expectSelector: '#q, input[name="q"], .search-combobox-input',
    waitMs: 5_000,
  },
  {
    name: 'jd',
    url: 'https://www.jd.com/',
    kind: 'real',
    expectSelector: '#key, input[name="keyword"]',
    waitMs: 4_000,
  },
  {
    name: 'linkedin',
    url: 'https://www.linkedin.com/',
    kind: 'real',
    expectSelector:
      'input[aria-label*="Search"], .search-global-typeahead__input, form[action*="login"]',
    waitMs: 5_000,
  },
  {
    name: 'x',
    url: 'https://x.com/',
    kind: 'real',
    expectSelector:
      'input[data-testid="SearchBox_Search_Input"], div[data-testid="primaryColumn"], a[href="/login"]',
    waitMs: 6_000,
  },
  {
    name: 'aliexpress',
    url: 'https://www.aliexpress.com/',
    kind: 'real',
    expectSelector: 'input[name="SearchText"], #search-key',
    waitMs: 5_000,
  },

  // ------------------------------------------- common public sites that must simply work, including
  // the owner's own region. A fingerprint that breaks a page's own JavaScript is invisible to a
  // screenshot AND to a fingerprint checker, which is why each one names an element the site's own JS
  // and layout produce. No target logs in or submits a form: pages are loaded, nothing is entered.
  {
    name: 'baidu',
    url: 'https://www.baidu.com/',
    kind: 'real',
    expectSelector: '#kw, input[name="wd"]',
    waitMs: 3_000,
  },
  {
    name: 'bilibili',
    url: 'https://www.bilibili.com/',
    kind: 'real',
    expectSelector: '.nav-search-input, #nav_searchform input',
    waitMs: 4_000,
  },
  {
    name: 'zhihu',
    url: 'https://www.zhihu.com/',
    kind: 'real',
    expectSelector: 'input[placeholder*="搜索"], .Input, button[aria-label*="搜索"]',
    waitMs: 4_000,
  },
  {
    name: 'weibo',
    url: 'https://weibo.com/',
    kind: 'real',
    expectSelector: 'input[type="text"], #search-input, .woo-input',
    waitMs: 5_000,
  },
  {
    name: '163',
    url: 'https://www.163.com/',
    kind: 'real',
    expectSelector: '#search-input, .search-input, input[type="text"]',
    waitMs: 3_000,
  },
  {
    name: 'csdn',
    url: 'https://www.csdn.net/',
    kind: 'real',
    expectSelector: '#toolbar-search-input, input[placeholder*="搜索"]',
    waitMs: 4_000,
  },
  {
    name: 'qq',
    url: 'https://www.qq.com/',
    kind: 'real',
    expectSelector: 'input[type="text"], .search-input, #searchBtn',
    waitMs: 3_000,
  },
  {
    name: 'stackoverflow',
    url: 'https://stackoverflow.com/',
    kind: 'real',
    expectSelector: 'input[name="q"], .s-topbar--searchbar--input',
    waitMs: 3_000,
  },
  {
    name: 'microsoft',
    url: 'https://www.microsoft.com/',
    kind: 'real',
    expectSelector: 'input[type="search"], #searchInput, form[role="search"] input',
    waitMs: 4_000,
  },
  {
    name: 'apple',
    url: 'https://www.apple.com/',
    kind: 'real',
    expectSelector: '#globalnav, nav#globalnav, .globalnav-link',
    waitMs: 3_000,
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/',
    kind: 'real',
    expectSelector: 'input#search, input[name="search_query"]',
    waitMs: 5_000,
  },
  {
    name: 'facebook',
    url: 'https://www.facebook.com/',
    kind: 'real',
    expectSelector: 'input[name="email"], #email, div[role="main"]',
    waitMs: 5_000,
  },
  {
    name: 'instagram',
    url: 'https://www.instagram.com/',
    kind: 'real',
    expectSelector: 'input[name="username"], form#loginForm, article',
    waitMs: 5_000,
  },
  {
    name: 'netflix',
    url: 'https://www.netflix.com/',
    kind: 'real',
    expectSelector: 'a[href*="login"], div[data-uia="header"], .netflix-logo',
    waitMs: 4_000,
  },
]

/**
 * Targets we know we are missing, listed so the gap is a visible ROW in the table rather than a note
 * that fires on every run and becomes noise people learn to ignore.
 */
const PENDING_TARGETS = [{ name: 'workbuddy', reason: 'the owner has not supplied the URL yet' }]

/** Markers a page uses to say "this browser is automated". */
const AUTOMATION_MARKERS = [
  /\byou are (a )?bot\b/i,
  /\bbot detected\b/i,
  /\bautomation (detected|flag|tool)/i,
  /\bautomated\b/i,
  /\bheadless\b/i,
  /\bwebdriver\b/i,
  /\bselenium\b/i,
  /\bpuppeteer\b/i,
]

/** Markers a page uses to say "nothing suspicious found". */
const CLEAN_MARKERS = [
  /\bnot a bot\b/i,
  /\bno automation\b/i,
  /\bpassed\b/i,
  /\bconsistent\b/i,
  /\bno (mismatch|inconsistenc|contradiction|automated)/i,
]

/**
 * A clean marker is only a VERDICT when something corroborates it.
 *
 * `you are human` appears on deviceandbrowserinfo as a verdict ("Are you a bot? ✅ You are human!"
 * beside `"isBot": false`) and on a Cloudflare challenge as an INSTRUCTION to the user ("Verify you
 * are human"). The phrase alone cannot tell them apart, so a clean claim needs a result-shaped token
 * beside it; without one the verdict is UNREAD rather than PASS, because the alternative is a
 * challenge page reporting a green fingerprint result.
 */
const CLEAN_CORROBORATION = [
  /"isbot"\s*:\s*false/i,
  /\bisbot\b[^.]{0,20}false/i,
  /\bresult\b/i,
  /\bscore\b/i,
  /\bverdict\b/i,
  /\bdetected\b/i,
  /✅/,
  /\buniqueness\b/i,
]

/** Heuristics for "this is a challenge or risk-control page, not the page we asked for". */
const INTERSTITIAL_SIGNATURES = [
  /automated \(bot\) activity/i,
  /unusual traffic/i,
  /verify your (identity|account)/i,
  /risk.?control/i,
  /are you a robot/i,
  // NO bare `/\bsuspended\b/i` or `/\bblocked\b/i` here. Both matched ordinary prose on pages that
  // were not blocking us at all — CreepJS says "blocked" about its own features and bing and amiunique
  // say "suspended" — and a false REPORT short-circuits the oracle path, so it also swallowed the
  // `[looked in: …]` dump that is the diagnostic. A block claim needs a PHRASE, not a word.
  // Cloudflare's actual wording. browserscan and pixelscan both sit behind Cloudflare, which makes
  // this the likeliest way the table goes quietly green — a challenge page says "Verify you are
  // human", and `you are human` on its own used to be enough for a PASS.
  /verify you are human/i,
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /cf-?challenge|cf_chl|turnstile/i,
  /\bddos protection by\b/i,
]

/** Captcha/block signals for real sites. Recorded, never fatal. */
const BLOCK_SIGNATURES = [
  ...INTERSTITIAL_SIGNATURES,
  /\bcaptcha\b/i,
  /\brecaptcha\b/i,
  /\bhcaptcha\b/i,
  /access denied/i,
  /request unsuccessful/i,
  /\bsorry,? (you have been|something)/i,
]

const SURFACE_FIELDS = [
  'innerWidth',
  'innerHeight',
  'outerWidth',
  'outerHeight',
  'screenWidth',
  'screenHeight',
  'screenAvailWidth',
  'screenAvailHeight',
  'devicePixelRatio',
  'userAgent',
  'platform',
  'oscpu',
  'languages',
  'timezone',
  'webdriver',
  'hardwareConcurrency',
  'webglVendor',
  'webglRenderer',
]

const failures = []
const notes = []

function note(message) {
  notes.push(message)
  console.log(`note  ${message}`)
}
function check(name, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!passed) failures.push(`${name}: ${detail}`)
  return passed
}

/* ------------------------------------------------------------------ the consistency properties */

function platformFamily(platform) {
  const value = String(platform ?? '')
  if (/^Win/i.test(value)) return 'windows'
  if (/^Mac/i.test(value)) return 'macos'
  if (/^Linux/i.test(value)) return 'linux'
  return 'unknown'
}
/**
 * Which OS a user agent claims.
 *
 * TRAP, recorded here so nobody "aligns" us with Chrome later. A well-known anti-detect benchmark
 * flags a macOS user agent that is not frozen to `10_15_7`, "the value real Chrome always sends".
 * That is advice for CHROMIUM-BASED products and it does not apply to us: real Firefox on macOS
 * sends `Intel Mac OS X 10.15`, and `10_15_7` is Chrome's and Safari's frozen form. If an oracle ever
 * flags our macOS UA, check it against what real Firefox sends — do not copy the Chromium convention.
 */
function userAgentFamily(userAgent) {
  const value = String(userAgent ?? '')
  if (/Windows/i.test(value)) return 'windows'
  if (/Macintosh|Mac OS X/i.test(value)) return 'macos'
  if (/Linux|X11/i.test(value)) return 'linux'
  return 'unknown'
}
function oscpuFamily(oscpu) {
  const value = String(oscpu ?? '')
  if (/Windows/i.test(value)) return 'windows'
  if (/Mac|Darwin|PPC/i.test(value)) return 'macos'
  if (/Linux/i.test(value)) return 'linux'
  return 'unknown'
}
function isKnownTimeZone(zone) {
  if (typeof zone !== 'string' || !zone.includes('/')) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * The property assertions. A pure function of the surface object — deliberately: it is what lets a
 * failing case be demonstrated without a browser, and it keeps the browser out of the logic.
 */
function checkConsistencyProperties(surface) {
  const number = key => Number(surface[key])

  // THE geometry property, and the only one here that does geometry. `outerWidth` is OUR pinned
  // number from the profile's config while `innerWidth` is the viewport the browser actually has, so
  // this goes red the moment those two disagree — an inner box wider than the window we claim to have
  // set. Same inconsistency class as the chrome check, and the reason it is expressed as a
  // relationship between two independently-sourced numbers rather than as a range.
  check(
    'inner box fits inside the outer box',
    number('innerWidth') <= number('outerWidth') && number('innerHeight') <= number('outerHeight'),
    `inner ${surface.innerWidth}x${surface.innerHeight} vs outer ${surface.outerWidth}x${surface.outerHeight}`,
  )
  check(
    'outer box fits on the screen',
    number('outerWidth') <= number('screenWidth') &&
      number('outerHeight') <= number('screenAvailHeight'),
    `outer ${surface.outerWidth}x${surface.outerHeight} vs screen ${surface.screenWidth}x` +
      `${surface.screenAvailHeight} (avail)`,
  )
  const ratio = number('devicePixelRatio')
  check(
    'devicePixelRatio is a real ratio',
    Number.isFinite(ratio) && ratio > 0 && ratio <= 8,
    `devicePixelRatio=${surface.devicePixelRatio}`,
  )
  check(
    'navigator.webdriver is false',
    surface.webdriver === false,
    `webdriver=${JSON.stringify(surface.webdriver)}`,
  )
  // Valid IANA zone, but deliberately NOT a specific zone: with geoip on and no proxy, the engine
  // derives it from the local IP, so the correct value depends on where this runs.
  check(
    'timezone is a valid IANA zone',
    isKnownTimeZone(surface.timezone),
    `timezone=${JSON.stringify(surface.timezone)}`,
  )
  note(`resolved timezone: ${JSON.stringify(surface.timezone)} (not asserted to a specific zone)`)

  const fromUserAgent = userAgentFamily(surface.userAgent)
  const fromPlatform = platformFamily(surface.platform)
  const fromOscpu = oscpuFamily(surface.oscpu)
  check(
    'the UA, platform and oscpu agree on the operating system',
    fromUserAgent !== 'unknown' &&
      fromUserAgent === fromPlatform &&
      (fromOscpu === 'unknown' || fromOscpu === fromUserAgent),
    `ua=${fromUserAgent} platform=${fromPlatform} (${surface.platform}) oscpu=${fromOscpu} (${surface.oscpu})`,
  )
  check(
    'the WebGL vendor and renderer are both readable',
    Boolean(surface.webglVendor) && Boolean(surface.webglRenderer),
    `${surface.webglVendor} / ${surface.webglRenderer}`,
  )
  return failures.length === 0
}

/* ------------------------------------------------------------------------------- the live read */

async function readSurface(page) {
  return page.evaluate(() => {
    // Two SEPARATE canvas elements: a canvas has exactly one context type, so reading `webgl` from an
    // element that already has a `2d` context returns null.
    const gl = document.createElement('canvas').getContext('webgl')
    const debug = gl?.getExtension('WEBGL_debug_renderer_info')
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      screenAvailWidth: screen.availWidth,
      screenAvailHeight: screen.availHeight,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      oscpu: navigator.oscpu ?? null,
      languages: (navigator.languages ?? []).join(','),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      webdriver: navigator.webdriver,
      hardwareConcurrency: navigator.hardwareConcurrency,
      webglVendor: debug
        ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
        : (gl?.getParameter(gl.VENDOR) ?? null),
      webglRenderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : (gl?.getParameter(gl.RENDERER) ?? null),
    }
  })
}

const GOOD_FIXTURE = {
  innerWidth: 1280,
  innerHeight: 720,
  outerWidth: 1280,
  outerHeight: 800,
  screenWidth: 1920,
  screenHeight: 1080,
  screenAvailWidth: 1920,
  screenAvailHeight: 1040,
  devicePixelRatio: 1,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
  platform: 'Win32',
  oscpu: 'Windows NT 10.0; Win64; x64',
  languages: 'en-US,en',
  timezone: 'Etc/UTC',
  webdriver: false,
  hardwareConcurrency: 8,
  webglVendor: 'Google Inc. (NVIDIA)',
  webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0), or similar',
}

/**
 * The geometry property, deliberately broken: the viewport is wider than the window we claim to have
 * pinned. This exercises the CHECKER WIRING; it does not claim a real launch can produce this state.
 * The live run is the coverage.
 *
 * There is deliberately no `innerWidth = 0` fixture. The engine cannot produce that state, so an
 * assertion against it could never go red against reality, and it was removed for that reason.
 */
const GEOMETRY_FIXTURE = { ...GOOD_FIXTURE, innerWidth: 1900, innerHeight: 1400 }

/**
 * Every geometric property holds, and the OS claims contradict each other: the UA says Macintosh
 * while `platform` and `oscpu` say Windows.
 */
const CONTRADICTION_FIXTURE = {
  ...GOOD_FIXTURE,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:152.0) Gecko/20100101 Firefox/152.0',
  platform: 'Win32',
  oscpu: 'Windows NT 10.0; Win64; x64',
}

const FIXTURES = {
  good: GOOD_FIXTURE,
  geometry: GEOMETRY_FIXTURE,
  contradiction: CONTRADICTION_FIXTURE,
}

/* ------------------------------------------------------------------------- the verdict parser */

/**
 * Read a verdict out of a page's RESULT TEXT.
 *
 * A **pure function of the text**, deliberately: it is what lets every correction below be proven
 * against the exact strings the live run printed, without a browser.
 *
 * @param {string} kind @param {string} text
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'UNREAD', finding: string }}
 */
function parsePageVerdict(kind, text) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const preview = flat.slice(0, 200)

  if (kind === 'creepjs') {
    // CreepJS labels the count before the number ("Lies 2") in some layouts and after it in others.
    // Searched over the WHOLE text, not the 200-character preview: the live run showed the preview is
    // page chrome ("FP ID: … Fuzzy: … WebRTC…") and the count is further down.
    const counted = /\b(\d+)\s+lies?\b/i.exec(flat)
    const labelled = counted ? null : /\blies?\b[^a-z\d]{0,12}(\d+)/i.exec(flat)
    const lies = counted ?? labelled
    if (!lies) {
      return {
        verdict: 'UNREAD',
        finding:
          `no lie count anywhere in the ${flat.length} characters read — the count is not where ` +
          `this runner looks. First 200 characters: ${preview}`,
      }
    }
    if (Number(lies[1]) === 0) {
      // The trust score is reported even on a pass: peers phrase their published results as "trust
      // score 82%", and a number that goes DOWN across releases is a regression this runner can show,
      // where a binary PASS/FAIL would show nothing at all.
      const score = /\b(?:trust|score)[^\d%]{0,20}(\d{1,3}(?:\.\d+)?)\s*%/i.exec(flat)
      const scoreText = score ? `${score[1]}%` : 'not found on the page'
      note(`${'creepjs trust score'}: ${scoreText} (reported even when the verdict is PASS)`)
      return { verdict: 'PASS', finding: `reports 0 lies, trust score ${scoreText}` }
    }
    return {
      verdict: 'FAIL',
      finding: `reports ${lies[1]} lie(s) — the named contradictions are ours: ${flat.slice(lies.index, lies.index + 400)}`,
    }
  }

  if (kind === 'sannysoft') {
    // Match the row label that precedes "failed" rather than splitting on separators, which cut
    // labels in half on the first attempt.
    const failed = [...flat.matchAll(/([A-Za-z][\w ()./#-]{1,50}?)\s+failed\b/gi)].map(match =>
      match[1].replace(/^.*[|\n]\s*/, '').trim(),
    )
    if (failed.length > 0) {
      return {
        verdict: 'FAIL',
        finding: `${failed.length} failed check(s): ${failed.slice(0, 8).join(' | ')}`,
      }
    }
    if (/\bpassed\b/i.test(flat)) {
      return { verdict: 'PASS', finding: 'no failed rows in the check table' }
    }
    return { verdict: 'UNREAD', finding: `no check table found; first 200 characters: ${preview}` }
  }

  // Generic oracle.
  //
  // 1. A NEGATED marker is a clean statement, not a flag. The first live run failed pixelscan on
  //    "No automated behavior detected" — the page saying the opposite of what the pattern matched.
  const negated = marker =>
    new RegExp(`\\b(?:no|not|zero|0)\\s+(?:\\w+\\s+){0,2}${marker}`, 'i').test(flat)

  // 2. A clean marker needs corroboration to count as a verdict rather than an instruction.
  const corroborated = CLEAN_CORROBORATION.some(pattern => pattern.test(flat))

  const strongBot = /\b(you are (a )?bot|bot detected|automation detected)\b/i.exec(flat)
  if (strongBot && !negated('(?:you are (?:a )?bot|bot detected|automation detected)')) {
    return {
      verdict: 'FAIL',
      finding: `automation flag on the page: "${flat.slice(Math.max(0, strongBot.index - 60), strongBot.index + 140)}"`,
    }
  }

  const strongClean = /\b(not a bot|no automation|you are human|nothing suspicious)\b/i.exec(flat)
  if (strongClean) {
    if (!corroborated) {
      return {
        verdict: 'UNREAD',
        finding:
          'a clean-sounding phrase ' +
          `("${flat.slice(Math.max(0, strongClean.index - 20), strongClean.index + 60)}") with ` +
          'nothing corroborating it — a Cloudflare challenge says the same thing, so it is not ' +
          'treated as a pass',
      }
    }
    return {
      verdict: 'PASS',
      finding: `page says: "${flat.slice(Math.max(0, strongClean.index - 40), strongClean.index + 120)}"`,
    }
  }

  const automation = AUTOMATION_MARKERS.find(pattern => pattern.test(flat))
  if (automation && !negated('(?:automated|automation|webdriver|headless|selenium|puppeteer)')) {
    const at = flat.search(automation)
    const excerpt = flat.slice(Math.max(0, at - 60), at + 140)
    // A GENERIC marker needs corroboration, exactly like a clean claim does. An anti-detect checker's
    // page is guaranteed to contain this vocabulary about itself — iphey's own copy reads "leaks and
    // confirm your proxy or VPN is working as expected. Bot Check Check if your browser behavior
    // triggers…" — and matching that produced a false FAIL that kept the whole step red. Without a
    // result-shaped token beside it, this is UNREAD rather than a verdict, because "the page mentions
    // automation" is not the same claim as "the page says this browser is automated".
    if (!corroborated) {
      return {
        verdict: 'UNREAD',
        finding:
          `the page mentions "${flat.slice(at, at + 40)}" but nothing corroborates it as a verdict ` +
          `rather than its own description: "${excerpt}"`,
      }
    }
    return { verdict: 'FAIL', finding: `automation flag on the page: "${excerpt}"` }
  }

  const clean = CLEAN_MARKERS.find(pattern => pattern.test(flat))
  if (clean) {
    // NO negation guard here. A negated automation phrase is a false positive to suppress on the BOT
    // side only; suppressing the clean side too made "No automated behavior detected … Bot check
    // passed" fall through to UNREAD, which is how this branch was wrong on the first attempt.
    const at = flat.search(clean)
    return {
      verdict: 'PASS',
      finding:
        `page says: "${flat.slice(Math.max(0, at - 40), at + 120)}"` +
        (corroborated ? '' : ' (uncorroborated)'),
    }
  }
  return {
    verdict: 'UNREAD',
    finding: `neither an automation marker nor a clean marker was present; first 200 characters: ${preview}`,
  }
}

/**
 * Synthetic pages, each taken from what a real page ACTUALLY PRINTED, or from a known challenge page.
 * These prove the corrections; the live run is the coverage.
 */
const ORACLE_FIXTURES = {
  // The exact string that produced the false FAIL on pixelscan.
  'pixelscan-negation':
    'Fingerprint No automated behavior detected Bot check passed Uniqueness 1 in 200000',
  // The site describing itself — the whole reason the verdict must come from the result region.
  'browserscan-marketing':
    'BrowserScan is a human-machine verification system using WebDriver and other automation tools to help websites detect bots.',
  // Cloudflare's own wording. This reached PASS before the fix.
  'cloudflare-challenge':
    'Verify you are human Just a moment... Enable JavaScript and cookies to continue',
  // The same phrase doing correct work, with corroboration.
  'deviceandbrowserinfo-clean':
    'Are you a bot? ✅ You are human! "isBot": false, no automated behavior detected',
  'creepjs-lies':
    'FP ID: abc Fuzzy: 1700.00 ms WebRTC Lies 2 webDriver: true platform: Win32 userAgent says Macintosh',
  'creepjs-clean': 'FP ID: abc Lies 0 resistance 0 canvas 0.02',
  'sannysoft-failed':
    'WebDriver (New) failed | Chrome (New) failed | Permissions passed | Plugins passed',
  unreadable: 'Loading…',
}

/** Which parser an oracle fixture exercises. */
const ORACLE_FIXTURE_KINDS = {
  'creepjs-lies': 'creepjs',
  'creepjs-clean': 'creepjs',
  'sannysoft-failed': 'sannysoft',
}

/**
 * What each fixture MUST produce. The counterfactual ASSERTS this rather than only printing, so a
 * later change that quietly re-breaks one of these corrections fails the run.
 *
 * `browserscan-marketing` is expected to FAIL, and that is not a bug: it is the demonstration that
 * reading the whole body is unsafe. In a live run the `scope` selectors hand the parser the result
 * region instead, which is exactly why `scope` exists.
 */
const ORACLE_FIXTURE_EXPECT = {
  'pixelscan-negation': 'PASS',
  // UNREAD, not FAIL: the text is browserscan describing itself and nothing corroborates it as a
  // verdict. It used to be expected FAIL, which is the false positive this expectation was recording
  // as correct behaviour.
  'browserscan-marketing': 'UNREAD',
  // The site describing its own service, including the words "Bot Check" and "automated detection".
  // Nothing corroborates it as a verdict, so it is UNREAD rather than a FAIL.
  'iphey-selfdescription': 'UNREAD',
  'cloudflare-challenge': 'UNREAD',
  'deviceandbrowserinfo-clean': 'PASS',
  'creepjs-lies': 'FAIL',
  'creepjs-clean': 'PASS',
  'sannysoft-failed': 'FAIL',
  unreadable: 'UNREAD',
}

/* ---------------------------------------------------- worker-thread consistency (main vs Worker) */

/**
 * "A real device never disagrees with itself."
 *
 * The published anti-detect benchmark says the checkers verify that a page's MAIN thread and its
 * BACKGROUND WORKER agree on the hardware. Camoufox patches at the C++ level so the two *should*
 * agree, but this project has never measured it — and a disagreement between threads is exactly the
 * class of contradiction that made CreepJS report lies about other products. So it is asserted, and a
 * difference fails us.
 */
/**
 * The fields a WORKER can actually see.
 *
 * `screenWidth` and `devicePixelRatio` are deliberately NOT in this list. `screen` and
 * `devicePixelRatio` are Window-only APIs and do not exist in Worker scope, so they can never agree
 * there — comparing them produced a permanent "4 of 6 fields agree", which reads as two fields
 * pending rather than as a complete check. A permanently partial PASS is the shape of a decorative
 * guard even when the comparison underneath is sound, so the two are excluded rather than counted.
 */
const WORKER_FIELDS = ['hardwareConcurrency', 'webglVendor', 'webglRenderer', 'userAgent']

/**
 * Compare the main thread's values with the worker's.
 *
 * A pure function of two plain objects — deliberately: it is what lets the assertion be shown going
 * red on this machine, where no engine can launch, via `--worker-fixture`.
 *
 * A field the WORKER could not report (a capability the worker does not expose, not a disagreement)
 * is `null`, and that is UNREAD for that field rather than a failure — otherwise a missing
 * OffscreenCanvas would read as "our fingerprint is inconsistent".
 */
function checkWorkerConsistency(main, worker) {
  if (!worker || worker.error) {
    return {
      verdict: 'UNREAD',
      findings: [],
      detail: `the worker could not report anything: ${worker?.error ?? 'no worker result'}`,
    }
  }
  const differences = []
  const unreadable = []
  for (const field of WORKER_FIELDS) {
    const fromWorker = worker[field]
    if (fromWorker === null || fromWorker === undefined) {
      unreadable.push(field)
      continue
    }
    if (String(fromWorker) !== String(main[field])) {
      differences.push(
        `${field}: main=${JSON.stringify(main[field])} worker=${JSON.stringify(fromWorker)}`,
      )
    }
  }
  if (differences.length > 0) {
    return {
      verdict: 'FAIL',
      findings: differences,
      detail: `${differences.length} of ${WORKER_FIELDS.length} fields disagree between threads`,
    }
  }
  if (unreadable.length === WORKER_FIELDS.length) {
    return {
      verdict: 'UNREAD',
      findings: [],
      detail: 'the worker reported no comparable field at all',
    }
  }
  return {
    verdict: 'PASS',
    findings: [],
    detail:
      `${WORKER_FIELDS.length - unreadable.length} of ${WORKER_FIELDS.length} fields agree between ` +
      `threads${unreadable.length ? `; the worker could not report ${unreadable.join(', ')}` : ''}`,
  }
}

/**
 * Read the same values from inside a Worker.
 *
 * Needs a REAL origin — a worker created from `about:blank` sits on an opaque origin and is blocked.
 * The caller navigates to the runner's own loopback page first.
 *
 * WebGL inside a worker needs `OffscreenCanvas`, and where that is unavailable the field comes back
 * `null` rather than wrong. That distinction is the point: "could not measure" must never be reported
 * as "measured and different".
 */
async function readWorkerSurface(page) {
  return page.evaluate(async () => {
    const source = `
      self.onmessage = () => {
        const out = {
          hardwareConcurrency: navigator.hardwareConcurrency ?? null,
          userAgent: navigator.userAgent ?? null,
          screenWidth: typeof screen !== 'undefined' ? screen.width : null,
          devicePixelRatio: typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : null,
          webglVendor: null,
          webglRenderer: null,
        }
        try {
          // A separate OffscreenCanvas for WebGL: one canvas has exactly one context type.
          const gl = new OffscreenCanvas(1, 1).getContext('webgl')
          if (gl) {
            const debug = gl.getExtension('WEBGL_debug_renderer_info')
            out.webglVendor = debug
              ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
              : gl.getParameter(gl.VENDOR)
            out.webglRenderer = debug
              ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER)
          }
        } catch (error) {
          out.webglError = String(error && error.message ? error.message : error)
        }
        self.postMessage(out)
      }
    `
    try {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
      const worker = new Worker(url)
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('the worker did not answer within 10 s')),
          10_000,
        )
        worker.onmessage = event => {
          clearTimeout(timer)
          resolve(event.data)
        }
        worker.onerror = event => {
          clearTimeout(timer)
          reject(new Error(event.message || 'the worker raised an error'))
        }
        worker.postMessage(null)
      })
      worker.terminate()
      URL.revokeObjectURL(url)
      return result
    } catch (error) {
      return { error: String(error?.message ? error.message : error) }
    }
  })
}

/**
 * Synthetic main/worker pairs, so `checkWorkerConsistency` can be shown going red without a browser.
 *
 * Each worker starts from the SAME good surface as the main thread, so only the field a fixture names
 * can differ. An empty worker object makes every field unreadable and the `consistent` case comes back
 * UNREAD rather than PASS — which is what happened on the first attempt.
 */
const WORKER_FIXTURES = {
  consistent: { main: {}, worker: { ...GOOD_FIXTURE } },
  'hardware-mismatch': { main: {}, worker: { ...GOOD_FIXTURE, hardwareConcurrency: 4 } },
  'webgl-mismatch': {
    main: {},
    worker: { ...GOOD_FIXTURE, webglRenderer: 'ANGLE (Intel, Intel UHD Graphics 620)' },
  },
  unavailable: { main: {}, worker: { error: 'OffscreenCanvas is not defined' } },
}

/** What each worker fixture MUST produce, asserted rather than only printed. */
const WORKER_FIXTURE_EXPECT = {
  consistent: 'PASS',
  'hardware-mismatch': 'FAIL',
  'webgl-mismatch': 'FAIL',
  unavailable: 'UNREAD',
}

/* ------------------------------------------------------------------------------------ the runner */

async function exitIp() {
  for (const url of ['https://api.ipify.org?format=json', 'https://ifconfig.me/ip']) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) continue
      const text = (await response.text()).trim()
      const parsed = text.startsWith('{') ? JSON.parse(text).ip : text
      if (parsed) return parsed
    } catch {
      // Try the next one.
    }
  }
  return null
}

/** The result region's text, or the whole body with a recorded caveat. */
async function resultText(page, target) {
  const tried = []

  // EXPAND COLLAPSED PANELS BEFORE READING. A collapsed panel's content is not in the DOM, and the
  // inventory showed this page's panels are toggled by `toggle-open-creep-*` / `toggle-close-creep-*`.
  // Bounded, and the number clicked is reported so a run says how much was actually opened.
  if (target.expand) {
    let clicked = 0
    let matched = 0
    try {
      const toggles = page.locator(target.expand)
      matched = await toggles.count()
      for (let index = 0; index < Math.min(matched, 60); index += 1) {
        try {
          await toggles.nth(index).click({ timeout: 2_000 })
          clicked += 1
        } catch {
          // A toggle that will not click is not fatal.
        }
      }
    } catch (error) {
      tried.push(`expand failed: ${String(error?.message ?? error).split('\n')[0]}`)
    }
    tried.push(`expanded ${clicked} of ${matched} panel toggle(s) via ${target.expand}`)
  }

  // Wait for a PANEL to exist rather than for a duration, when the target declares one. A fixed wait on
  // a page whose real content is produced by a Web Worker is a race: CreepJS's header is in the DOM
  // while every analysis panel is still absent.
  if (target.waitFor) {
    const budget = target.panelTimeoutMs ?? 20_000
    const deadline = Date.now() + budget
    let appeared = null
    while (Date.now() < deadline && !appeared) {
      for (const selector of target.waitFor) {
        try {
          if ((await page.locator(selector).first().count()) > 0) {
            appeared = selector
            break
          }
        } catch {
          // Try the next selector.
        }
      }
      if (!appeared) await page.waitForTimeout(1_000)
    }
    tried.push(
      appeared
        ? `panel appeared: ${appeared}`
        : `no panel appeared within ${budget} ms (polled: ${target.waitFor.join(', ')})`,
    )

    // Second path: if no element appeared, poll for the verdict SHAPE. The output distinguishes the two
    // so a run cannot be read as "the panel appeared" when it was the text pattern, or vice versa.
    if (!appeared && target.textPattern) {
      const textBudget = target.textTimeoutMs ?? 45_000
      const textDeadline = Date.now() + textBudget
      while (Date.now() < textDeadline && !appeared) {
        const text = (await page.locator('body').innerText().catch(() => '')) || ''
        if (target.textPattern.test(text)) {
          appeared = 'text pattern'
          break
        }
        await page.waitForTimeout(2_000)
      }
      tried.push(
        appeared === 'text pattern'
          ? `a verdict-shaped text pattern appeared within ${textBudget} ms`
          : `no verdict-shaped text pattern appeared within ${textBudget} ms either`,
      )
    }
  }

  for (const selector of target.scope ?? []) {
    try {
      const locator = page.locator(selector).first()
      if ((await locator.count()) === 0) {
        tried.push(`${selector}: 0 matches`)
        continue
      }
      const text = await locator.innerText({ timeout: 5_000 })
      tried.push(`${selector}: ${text ? text.trim().length : 0} chars`)
      if (text && text.trim().length > 0) return { text, scope: selector, tried }
    } catch (error) {
      tried.push(`${selector}: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
  const body =
    (await page
      .locator('body')
      .innerText()
      .catch(() => '')) || ''
  tried.push(`body: ${body.trim().length} chars`)

  // `body.innerText` does NOT include shadow-root content, and CreepJS renders its result blocks into
  // shadow roots — the leading explanation for "3947 characters read and no lie count". The shadow
  // text is collected and reported separately so the dump shows whether it contributed.
  const shadow = await page
    .evaluate(() => {
      const parts = []
      const walk = root => {
        for (const element of root.querySelectorAll('*')) {
          if (element.shadowRoot) {
            parts.push(element.shadowRoot.textContent || '')
            walk(element.shadowRoot)
          }
        }
      }
      walk(document)
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    })
    .catch(() => '')
  tried.push(`shadow roots: ${shadow.length} chars`)

  // Dump the element names ACTUALLY present. This is the durable half of the diagnostic: `panel
  // appeared` tells us whether timing was the whole story, while this list tells us what the page
  // renders in this build. Guessing a page's markup from memory is how the two false FAILs happened.
  const inventory = await page
    .evaluate(() => {
      const custom = new Set()
      const classes = new Set()
      for (const element of document.querySelectorAll('*')) {
        const tag = element.tagName.toLowerCase()
        if (tag.includes('-')) custom.add(tag)
      }
      // Classes are the other half of the inventory, and a selector would key on them: the ids told us
      // the panels are toggles, and the class names are what a container selector would actually use.
      for (const element of document.querySelectorAll('[class]')) {
        for (const name of element.classList) classes.add(name)
      }
      return {
        custom: [...custom].slice(0, 40),
        ids: [...document.body.querySelectorAll('[id]')].map(element => element.id).slice(0, 40),
        classes: [...classes].slice(0, 60),
      }
    })
    .catch(() => ({ custom: [], ids: [], classes: [] }))
  tried.push(`custom elements: ${inventory.custom.join(', ') || 'none'}`)
  tried.push(`ids: ${inventory.ids.join(', ') || 'none'}`)
  tried.push(`classes: ${inventory.classes.join(', ') || 'none'}`)

  return { text: shadow.length > 0 ? `${body}\n${shadow}` : body, scope: null, tried }
}

/** Every public IPv4/IPv6-looking token on a page, for the WebRTC leak comparison. */
function publicAddressesIn(text) {
  const found = new Set()
  for (const match of String(text).matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) found.add(match[0])
  for (const match of String(text).matchAll(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{1,4}\b/gi)) {
    found.add(match[0])
  }
  return [...found].filter(
    address => !/^(?:0\.|127\.|10\.|192\.168\.|169\.254\.|::1$|fe80:)/i.test(address),
  )
}

/**
 * Read a DATA page — one that displays values and has no verdict to give.
 *
 * `browserleaks` is the case that taught us this: canvas, WebGL, WebRTC and fonts are *data* displays
 * whose text is documentation prose plus a table, and expecting a pass/fail from them was a design
 * error rather than an extraction bug. Rather than nine permanent UNREADs (which trains people to
 * ignore the column), the values are extracted and asserted where something real is checkable.
 */
function checkDataTarget(target, text, ip) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (flat.length < 40) {
    return { verdict: 'UNREAD', finding: `only ${flat.length} characters of data came back` }
  }

  if (target.assertNoForeignIp) {
    const addresses = publicAddressesIn(flat)
    if (addresses.length === 0) {
      return {
        verdict: 'UNREAD',
        finding: `no address found in ${flat.length} characters, so no leak can be confirmed or denied`,
      }
    }
    if (ip && addresses.includes(ip)) {
      return {
        verdict: 'PASS',
        finding: `the page reports our exit address ${ip} and no other public address (found ${addresses.join(', ')})`,
      }
    }
    const foreign = addresses.filter(address => address !== ip)
    if (foreign.length > 0 && ip) {
      return {
        verdict: 'FAIL',
        finding: `LEAK: the page reports ${foreign.join(', ')} while we exited from ${ip}`,
      }
    }
    return {
      verdict: 'PASS',
      finding: `the page reports ${addresses.join(', ')} (exit IP unknown, so only one address is asserted)`,
    }
  }

  return {
    verdict: 'DATA',
    finding: `${flat.length} characters of values read: ${flat.slice(0, 180)}`,
  }
}

async function checkTargets(browser, propertiesHeld) {
  const ip = await exitIp()
  console.log('')
  console.log(`=== site check (exit IP ${ip ?? 'could not be determined'})`)

  const rows = []
  for (const target of SITE_TARGETS) {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = await context.newPage()
    try {
      const response = await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      })
      // Four different causes used to share one UNREAD label. A server error means the site is down
      // and proves nothing either way; a 4xx means the site refused us; a block page is the same kind
      // of event; and a page that rendered without the element we expect is a layout change. They are
      // labelled apart so the table says which happened.
      const status = response?.status() ?? 0
      if (status >= 500) {
        rows.push({
          name: target.name,
          verdict: 'UNREACHABLE',
          finding: `HTTP ${status} from ${ip ?? 'unknown'} — the site itself is failing, so this proves nothing either way`,
        })
        continue
      }
      if (status >= 400) {
        rows.push({
          name: target.name,
          verdict: 'REPORT',
          finding: `HTTP ${status} from ${ip ?? 'unknown'} — the site refused us`,
        })
        continue
      }

      // Some checkers only produce a verdict after their own test button is clicked. Tried, and when
      // the selector does not match the UNREAD says so rather than looking like an extraction bug.
      if (target.clickBefore) {
        try {
          const button = page.locator(target.clickBefore).first()
          if ((await button.count()) > 0) await button.click({ timeout: 10_000 })
        } catch (error) {
          note(
            `${target.name}: the test button did not click ` +
              `(${String(error?.message ?? error).split('\n')[0]})`,
          )
        }
      }
      if (target.waitMs > 0) await page.waitForTimeout(target.waitMs)
      const { text, scope, tried } = await resultText(page, target)
      const unscoped =
        target.kind !== 'real' && scope === null
          ? ' [read from the whole body: no result-region selector matched]'
          : ''
      const flat = text.replace(/\s+/g, ' ').trim()

      // BLOCK_SIGNATURES, not just INTERSTITIAL_SIGNATURES: "Sorry, you have been blocked" is the site
      // refusing us (whoer printed exactly that), which is a REPORT rather than a failed extraction.
      const interstitial = BLOCK_SIGNATURES.find(pattern => pattern.test(flat))
      if (interstitial) {
        // A challenge or block page is NEVER a verdict, for any kind of target. This is the fix for
        // the path that reached PASS on Cloudflare's "Verify you are human".
        rows.push({
          name: target.name,
          verdict: 'REPORT',
          finding:
            `${target.kind === 'real' ? 'the site was' : 'the page was'} behind a ` +
            `challenge/block (${interstitial}) from ${ip ?? 'unknown'} — no verdict is ` +
            `possible. It says: "${flat.slice(0, 160)}"` +
            // The dump is printed for a REPORT too. "We think this was blocked" and "here is what the
            // page actually said, and where we looked for it" are both useful, and the second is what
            // corrects the first — a false REPORT used to swallow the diagnostic entirely.
            (target.kind === 'real' ? '' : ` [looked in: ${tried.join('; ')}]`),
        })
        note(`${target.name}: challenge/block page matched ${interstitial}; not read as a verdict`)
        continue
      }

      if (target.kind === 'data') {
        // A DATA page displays values and has no verdict to give. `browserleaks-*` is the case that
        // taught us this: every one of its pages is documentation prose plus a data table, so
        // expecting a pass/fail was a design error rather than an extraction bug. The values are
        // extracted and asserted where something real is checkable, instead of nine permanent
        // UNREADs training people to ignore the column.
        const outcome = checkDataTarget(target, flat, ip)
        rows.push({
          name: target.name,
          verdict: outcome.verdict,
          finding: outcome.finding + unscoped,
        })
        if (outcome.verdict === 'FAIL') {
          failures.push(`${target.name} (data target) failed its assertion: ${outcome.finding}`)
        }
        continue
      }

      if (target.kind === 'real' && target.expectForm === 'login') {
        const password = await page.locator('input[type="password"]').count()
        const username =
          (await page
            .locator('input[name="login"], input#login_field, input[type="email"]')
            .count()) > 0
        if (password > 0 && username) {
          rows.push({ name: target.name, verdict: 'PASS', finding: 'the login form rendered' })
        } else if (propertiesHeld) {
          const finding =
            'the login form did not render while every fingerprint property passed, so this is on ' +
            `our side. Title "${await page.title()}"`
          rows.push({ name: target.name, verdict: 'FAIL', finding })
          failures.push(`${target.name}: ${finding}`)
        } else {
          rows.push({
            name: target.name,
            verdict: 'REPORT',
            finding: 'no login form, but a fingerprint property already failed',
          })
        }
        continue
      }

      if (target.kind === 'real') {
        // Does the page RENDER and work? A block/captcha is recorded, never fatal.
        const block = BLOCK_SIGNATURES.find(pattern => pattern.test(flat))
        let found = 0
        try {
          found = await page.locator(target.expectSelector).count()
        } catch {
          found = 0
        }
        if (found > 0) {
          rows.push({
            name: target.name,
            verdict: 'PASS',
            finding: `rendered and working (${found} match for "${target.expectSelector}")`,
          })
        } else if (block) {
          rows.push({
            name: target.name,
            verdict: 'REPORT',
            finding:
              `blocked/captcha (${block}) from ${ip ?? 'unknown'} — recorded, not failed. It says: ` +
              `"${flat.slice(0, 160)}"`,
          })
        } else {
          rows.push({
            name: target.name,
            verdict: 'UNREAD',
            finding:
              `the page rendered ${flat.length} characters but nothing matched ` +
              `"${target.expectSelector}" — a layout change or a bot page, NOT a block (no block ` +
              `signature was present). Title "${await page.title()}". It says: "${flat.slice(0, 120)}"`,
          })
        }
        continue
      }

      const parsed = parsePageVerdict(target.parse, flat)
      // On UNREAD, dump WHERE the runner looked and how much each place held. `creepjs` read 3947
      // characters and found no lie count, which means the count is not in body.innerText at all —
      // so the next correction comes from this list rather than from another guess.
      const where = parsed.verdict === 'UNREAD' ? ` [looked in: ${tried.join('; ')}]` : ''
      rows.push({
        name: target.name,
        verdict: parsed.verdict,
        finding: parsed.finding + unscoped + where,
      })
      if (parsed.verdict === 'FAIL') {
        failures.push(`${target.name} (oracle) named an inconsistency of ours: ${parsed.finding}`)
      }
      if (parsed.verdict === 'UNREAD') {
        note(
          `${target.name}: the verdict could NOT be read. Neither a pass nor a fail — the extraction ` +
            'needs updating, and until then this site proves nothing.',
        )
      }
    } catch (error) {
      // Unreachable, timed out, crashed — never aborts the remaining targets.
      const message = String(error?.message ?? error).split('\n')[0]
      const unreachable = /timeout|ENOTFOUND|ECONNREFUSED|ERR_|net::/i.test(message)
      rows.push({
        name: target.name,
        verdict: unreachable ? 'UNREACHABLE' : 'UNREAD',
        finding: `${message} (from ${ip ?? 'unknown'})`,
      })
      note(`${target.name} could not be read from ${ip ?? 'unknown'}: ${message}`)
    } finally {
      await page.close().catch(() => {})
    }
  }

  for (const pending of PENDING_TARGETS) {
    rows.push({
      name: pending.name,
      verdict: 'PENDING',
      finding: `not configured: ${pending.reason}`,
    })
  }

  console.log('')
  const width = Math.max(...rows.map(row => row.name.length), 'target'.length)
  console.log(`${'target'.padEnd(width)}  ${'verdict'.padEnd(11)}  finding`)
  console.log(`${'-'.repeat(width)}  ${'-'.repeat(11)}  ${'-'.repeat(40)}`)
  for (const row of rows) {
    console.log(`${row.name.padEnd(width)}  ${row.verdict.padEnd(11)}  ${row.finding}`)
  }

  const counts = {}
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] ?? 0) + 1
  console.log('')
  console.log(
    `summary: ${Object.entries(counts)
      .map(([verdict, count]) => `${count} ${verdict}`)
      .join(', ')}`,
  )
  console.log(
    'LIMIT: a green oracle result is one third-party opinion, on one day, from one datacenter IP.\n' +
      '       It is not proof of undetectability. A PASS means these particular checks, run today\n' +
      '       from this IP, named nothing — and an UNREAD means the site proved nothing at all.\n' +
      '       A PASS on a PUBLIC site means the site served us a page and its own JavaScript ran.\n' +
      '       It does NOT mean the site considers us human, and it says nothing about the TLS and\n' +
      '       behavioural layers, which the commercial anti-detect products cannot see either.\n' +
      '       No target logs in or submits a form: pages are loaded, nothing is entered.',
  )

  const unread = rows.filter(row => row.verdict === 'UNREAD' || row.verdict === 'UNREACHABLE')
  if (unread.length > 0) {
    note(
      `${unread.length} of ${rows.length} targets could not be read ` +
        `(${unread.map(row => row.name).join(', ')}). Neither passes nor failures, and not coverage.`,
    )
  }
}

/* ---------------------------------------------------------------------------------------- main */

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const fixture = argument('fixture')
const oracleFixture = argument('oracle-fixture')
const workerFixture = argument('worker-fixture')
const live = process.argv.includes('--live')
const skipSites = process.argv.includes('--skip-sites')

if (!fixture && !live && !oracleFixture && !workerFixture) {
  console.error(
    `usage: verify-fingerprint.mjs --live | --fixture ${Object.keys(FIXTURES).join('|')} | ` +
      `--oracle-fixture ${Object.keys(ORACLE_FIXTURES).join('|')} | ` +
      `--worker-fixture ${Object.keys(WORKER_FIXTURES).join('|')} [--skip-sites]`,
  )
  process.exit(2)
}

// The counterfactual for the WORKER-consistency assertion: two plain objects through the same
// comparison the live run uses, so "this can go red" is answered with output rather than argument.
if (workerFixture) {
  if (!Object.hasOwn(WORKER_FIXTURES, workerFixture)) {
    console.error(
      `unknown worker fixture "${workerFixture}"; expected one of ${Object.keys(WORKER_FIXTURES).join(', ')}`,
    )
    process.exit(2)
  }
  // A fixture with no explicit main values uses the same good surface the property fixtures use, so
  // only the field(s) the fixture names can differ.
  const pair = WORKER_FIXTURES[workerFixture]
  const main = { ...GOOD_FIXTURE, ...pair.main }
  const outcome = checkWorkerConsistency(main, pair.worker)
  console.log(`=== worker fixture (${workerFixture}) — no browser needed`)
  for (const field of WORKER_FIELDS) {
    console.log(
      `      ${field.padEnd(20)} main=${JSON.stringify(main[field])} worker=${JSON.stringify(pair.worker?.[field] ?? null)}`,
    )
  }
  console.log(
    `      verdict: ${outcome.verdict} (expected ${WORKER_FIXTURE_EXPECT[workerFixture]})`,
  )
  console.log(`      detail:  ${outcome.detail}`)
  for (const finding of outcome.findings) console.log(`      difference: ${finding}`)
  if (outcome.verdict !== WORKER_FIXTURE_EXPECT[workerFixture]) {
    failures.push(
      `worker fixture ${workerFixture}: expected ${WORKER_FIXTURE_EXPECT[workerFixture]} but got ${outcome.verdict}`,
    )
  }
  report()
}

// The counterfactual for the ORACLE path: drive the verdict parser with a page that really printed
// what produced the bug. Same parser the live oracles use.
if (oracleFixture) {
  if (!Object.hasOwn(ORACLE_FIXTURES, oracleFixture)) {
    console.error(
      `unknown oracle fixture "${oracleFixture}"; expected one of ${Object.keys(ORACLE_FIXTURES).join(', ')}`,
    )
    process.exit(2)
  }
  const text = ORACLE_FIXTURES[oracleFixture]
  const kind = ORACLE_FIXTURE_KINDS[oracleFixture] ?? 'generic'
  console.log(`=== oracle fixture (${oracleFixture}, parsed as "${kind}") — no browser needed`)
  console.log(`      page text: ${JSON.stringify(text)}`)
  // Both halves of the challenge fix are shown here: the interstitial pre-check runs BEFORE the
  // parser in a live run, so a challenge page is REPORTed and never parsed at all — and the parser
  // itself refuses to read an uncorroborated "you are human" as a pass.
  const interstitial = INTERSTITIAL_SIGNATURES.find(pattern => pattern.test(text))
  console.log(
    `      interstitial: ${interstitial ? `MATCHED ${interstitial} — a live run REPORTs this page and never parses it` : 'not matched'}`,
  )
  const parsed = parsePageVerdict(kind, text)
  console.log(
    `      verdict:   ${parsed.verdict} (expected ${ORACLE_FIXTURE_EXPECT[oracleFixture]})`,
  )
  console.log(`      finding:   ${parsed.finding}`)
  if (parsed.verdict !== ORACLE_FIXTURE_EXPECT[oracleFixture]) {
    failures.push(
      `oracle fixture ${oracleFixture}: expected ${ORACLE_FIXTURE_EXPECT[oracleFixture]} but got ` +
        `${parsed.verdict} — ${parsed.finding}`,
    )
  }
  report()
}

let surface
let workerSurface = null
let browser = null
let closeCore = null

if (fixture) {
  if (!Object.hasOwn(FIXTURES, fixture)) {
    console.error(
      `unknown fixture "${fixture}"; expected one of ${Object.keys(FIXTURES).join(', ')}`,
    )
    process.exit(2)
  }
  surface = FIXTURES[fixture]
  console.log(
    `=== fixture mode (${fixture}) — no browser, but the same assertions the live run uses`,
  )
} else {
  const headless = /^(1|true|yes|on)$/i.test(process.env.VFOX_SMOKE_HEADLESS ?? '')
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vfox-fingerprint-'))
  console.log(`=== live mode (data dir ${dataDir}, headless ${headless})`)

  const { createCore } = await import('../dist/index.js')
  const core = await createCore({ dataDir })
  const profile = await core.profiles.create({
    name: `verify-fingerprint-${Date.now()}`,
    launch: { headless, startUrl: 'about:blank' },
  })
  closeCore = async () => {
    await core.runtime.stop(profile.id).catch(() => {})
    await core.close().catch(() => {})
    await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  }

  // `runtime.launch` THROWS when the engine cannot start rather than returning a status — verified.
  // Without this catch the spawn failure arrives as an uncaught exception and a stack trace, which is
  // exactly the output that gets misread as a fingerprint defect.
  let runtime
  try {
    runtime = await core.runtime.launch(profile.id)
  } catch (error) {
    console.error(`FAIL  the profile could not be launched: ${error.message}`)
    console.error(
      "      A browser cannot start in this project's local sandbox, so this is expected here and\n" +
        '      is the finding in CI. Run it in CI or on an unconfined machine.',
    )
    await closeCore()
    process.exit(2)
  }
  if (runtime.status !== 'running' || !runtime.wsEndpoint) {
    console.error(`FAIL  the profile did not launch with a wsEndpoint (status ${runtime.status}).`)
    await closeCore()
    process.exit(2)
  }

  const { firefox } = await import('playwright-core')
  browser = await firefox.connect(runtime.wsEndpoint)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()

  // A worker needs a REAL origin: one created from `about:blank` sits on an opaque origin and is
  // blocked, which would read as "the worker could not report" rather than as a measurement. The
  // runner serves its own one-page origin instead.
  const { createServer } = await import('node:http')
  const origin = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>vfox-fingerprint</title><p>loopback origin</p>')
  })
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
  const originUrl = `http://127.0.0.1:${origin.address().port}/`
  await page.goto(originUrl, { waitUntil: 'load' })
  surface = await readSurface(page)
  workerSurface = await readWorkerSurface(page)
  await new Promise(resolve => origin.close(resolve))
}

console.log('')
console.log('=== fingerprint surface')
for (const field of SURFACE_FIELDS) console.log(`      ${field}: ${JSON.stringify(surface[field])}`)

console.log('')
console.log('=== consistency properties')
const held = checkConsistencyProperties(surface)

// Main thread vs background worker. "A real device never disagrees with itself", so any difference in
// the fields the worker can report is a hard finding and fails us. A field the worker could not
// report at all is UNREAD, not a disagreement.
if (browser) {
  console.log('')
  console.log('=== worker-thread consistency (main thread vs Worker)')
  const workerOutcome = checkWorkerConsistency(surface, workerSurface)
  console.log(`${workerOutcome.verdict}  ${workerOutcome.detail}`)
  for (const finding of workerOutcome.findings) console.log(`      difference: ${finding}`)
  if (workerOutcome.verdict === 'FAIL') {
    failures.push(
      'worker-thread inconsistency (a real device never disagrees with itself): ' +
        workerOutcome.findings.join('; '),
    )
  }
  if (workerOutcome.verdict === 'UNREAD') {
    note('the worker consistency check could not measure anything, so it proves nothing either way')
  }
} else {
  note('fixture mode: the worker-thread check needs a browser and was not run')
}

if (browser && !skipSites) {
  await checkTargets(browser, held)
} else if (!browser) {
  note('fixture mode: the real site check needs a browser and was not run')
} else {
  note('the site check was skipped with --skip-sites')
}

await closeCore?.()
report()

/** Print the summary and exit non-zero on any failure. */
function report() {
  console.log('')
  console.log('='.repeat(72))
  if (notes.length > 0) {
    console.log(`notes (${notes.length}):`)
    for (const entry of notes) console.log(`  - ${entry}`)
  }
  if (failures.length > 0) {
    console.error(`\nFAILED: ${failures.length} check(s)`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('all fingerprint consistency properties hold')
  process.exit(0)
}
