# Replacement assessment — framework-root candidate chain → `@rh/shared/framework.js`

Per `rh-replacement-assessment.md`. This is **functional code**, not a fact correction, so an
assessment is required before the change lands.

Date: 2026-08-19. Branch: `fix/identity-refs-framework-resolver`.

---

## What

Three scripts each carry their own copy of an ordered, `existsSync`-guarded chain that resolves
the framework checkout at runtime:

| File | Lines | Literals carried |
|---|---|---|
| `packages/oversight/scripts/rh-config-integrity.js` | 113–136 | repo nesting (`:114`), `OneDrive`+workspace-leaf (`:130`) |
| `packages/output/scripts/rh-fw.js` | 44–72 | repo nesting (`:46`), `OneDrive`+workspace-leaf (`:65`) |
| `packages/output/scripts/rh-daily-validate.js` | 79–92 | repo nesting (`:89`), `OneDrive`+workspace-leaf (`:87`) |

`rh-config-integrity.js:111` states the coupling explicitly:

> `// NOTE: the candidate chain below intentionally mirrors rh-fw.js and`
> `// rh-daily-validate.js. Keep the three in step if the layout changes.`

**Replaced with:** one resolver in `packages/shared/framework.js`, imported by all three. The
chain *shape* is preserved exactly; only the machine-specific *values* move out of code and into
configuration (`~/.claude/oversight.json`) plus runtime self-location.

## Evidence

1. **`packages/cli/tests/run.js` is 89 pass / 1 fail on `main`** — measured 2026-08-19.
   `test-no-identity-refs.js` reports 2 violations, both in `rh-config-integrity.js`
   (`:114`, `:130`). This is the repo's own stated zero-hardcoded-paths convention failing.

2. **The test has a quote-style blind spot, so the real violation count is 5, not 2.**
   `SPLIT_IDENTITY` is built as `'One"+"Drive'\s*,\s*'Work"+"space'` — a **single-quote-only**
   regex. The identical literals in `rh-fw.js:46`, `rh-fw.js:65` and `rh-daily-validate.js:87`
   are **double-quoted** and slip through:

   ```
   rh-fw.js:46:            "toolbeltross", "toolbeltross-public", "rh-claude-framework",
   rh-fw.js:65:            path.join(process.env.USERPROFILE, "OneDrive", "Workspace")
   rh-daily-validate.js:87: path.join(process.env.USERPROFILE, "OneDrive", "Workspace")
   ```

   Verified by `grep` on 2026-08-19. Fixing only the two flagged lines would turn the suite green
   while leaving three identical violations shipped in the public repo — going green on a test
   bug rather than on the convention. The quote-agnostic fix to the regex is a **strengthening**,
   not the prohibited weakening.

3. **F-19 root cause (a)**: paths *captured at install* rot on relocation, while
   runtime-resolved `existsSync`-guarded chains **survived the 2026-07-27 OneDrive→local move**.
   The chain is the good pattern and must not be deleted.

## Value lost

- **Three independent copies** that could each be patched in isolation. In practice this is a
  cost, not a benefit — the `:111` NOTE exists precisely because divergence is silent — but it
  does mean a future edit to one caller's needs now touches shared code, so the blast radius of
  a mistake is wider.
- **Self-containment of `rh-fw.js`.** It currently requires nothing but `fs`/`path`/`url`. It
  now requires `./lib/framework` from the installed `~/.claude/scripts/lib/`. Mitigated: the
  installer already ships `lib/{config,file-lock,fs-atomic,env}.js` to that exact directory by
  the same mechanism, and the require is wrapped so a missing module degrades to the existing
  fail-open (`exit 0`) rather than throwing inside a hook.
- **Nothing else.** No caller loses a resolution path; the chain order is preserved verbatim.

## Value gained

- The public repo stops shipping the maintainer's GitHub org nesting and personal workspace
  folder name — the convention the test encodes, honoured for real rather than for the two
  lines that happened to be caught.
- The `:111` "keep the three in step" invariant becomes **structural** instead of a comment
  asking humans to remember. Divergence is now impossible rather than merely discouraged.
- Resolution gains a **self-location** step (`__dirname`-relative), which is exact for every
  in-source run and costs two `existsSync` calls — cheaper than today's chain walk.
- The nesting fragment becomes machine-local config, which is where F-19 says re-keyed-on-
  migration values belong, with discovery as the backstop when config is absent or stale.

## Value *not* claimed

The `frameworkRoot` key that `init` writes into `oversight.json` **is** an install-time capture,
the F-19(a) class. It is a **fast path, not a source of truth**: it is `existsSync`-guarded and
falls through to the candidate chain and self-location when stale. A relocation therefore
degrades to today's behaviour, never worse.

## Recommendation

**Replace** — consolidate into `@rh/shared/framework.js`, preserve the chain order and
`RH_FRAMEWORK_ROOT`'s outright-win precedence, and make the test quote-agnostic so all five
violations are covered rather than the two that regex accident happened to catch.

## Interaction with adjacent rules

- `rh-work-verification.md` — outer seam is a real `init` against a disposable HOME followed by
  `rh-oversight-self-test.js` from the installed location (37/37), not just the test runner.
- `rh-oversight-doc-sync.md` — `rh-config-integrity.js` and `rh-fw.js` are oversight enforcement
  surfaces; the design doc's hook/script inventory is reviewed in the same change.
