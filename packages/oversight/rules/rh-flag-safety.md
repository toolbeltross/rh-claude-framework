---
description: "Preview and check flags are only as safe as the parser that receives them; a silently-ignored flag makes a command destructive-by-typo"
keywords: [CLI, flags, --help, --dry-run, dry run, argv, parser, argument parsing, unknown flag, typo, destructive, preview, subcommand, installer, exit code]
severity: warn
---

# Flag Safety

## Principle

**A flag is only as safe as the specific parser that receives it.** A parser that cannot
*reject* an argument cannot meaningfully have *accepted* one — silence on an unrecognised flag
is indistinguishable from acceptance, and the command proceeds with its default behaviour. When
that default is a write, the safe-looking form of the command is destructive.

The dangerous case is not the exotic flag. It is the **typo one character away from the safe
flag**, because there is no reading in which the operator wanted the write.

## The two silences

This failure needs two independent gaps to line up, and both are common:

1. **Position-scoped help.** A dispatcher matches `--help` only in the command slot
   (`argv[2]`), so `tool --help` is correct and safe while `tool <subcommand> --help` falls
   through to the subcommand untouched.
2. **A parser with no rejecting branch.** The subcommand's argument loop is a chain of
   `if`/`else if` comparisons with **no final `else`**, so any unrecognised token is discarded
   without comment.

Either alone is survivable. Together they turn a request for *help* or a request for a
*preview* into a real write, with no error, and no difference between the command the operator
meant and the command that ran.

## How to apply

**Before running any command whose failure mode is a write** — installers, deployers,
migrators, sync tools, anything that touches a shared surface:

1. **Do not learn the flags by running the command.** `<subcommand> --help` is a guess about the
   parser, not a query of it. Read the argument loop, or the dispatcher, or `--help` **in the
   command slot only**.
2. **Confirm the parser has a rejecting `default` / `else` branch** before trusting any
   preview, check, or dry-run flag. If unrecognised input is silently dropped, the preview flag
   offers no protection against its own misspelling.
3. **Verify the flag you typed is the flag that exists** — exactly, character for character.
   `--dryrun` and `--dry-run` are different arguments; only one of them is a preview.
4. **Prefer a disposable target over a careful command.** Where the tool supports redirection
   (`HOME`, a `--prefix`, a temp root), run against a throwaway directory and assert the file
   count. That defends against a mistyped flag; reading the flag list does not.
5. **After the fact, assert the blast radius rather than assuming it.** If a write did happen,
   measure what changed — file-by-file, and semantically, not just by line count. "It printed
   reassuring output" is not evidence.

## When a tool is the offender, fix the tool

Guidance is the weaker half. A tool in this class should either accept `--help` at every
position, or refuse unrecognised flags before doing any filesystem work — ideally both. Prefer
fixing the parser to documenting the hazard, and retire the documentation when the fix deploys.

## What this rule does NOT cover

- **Flags that are merely wrong but harmless** — a bad `--format` on a read-only report is a
  usability issue, not this failure.
- **Interactive confirmation prompts.** A tool that asks before writing has already closed this
  gap; note that `--yes` / `--no-prompt` / non-TTY stdin frequently reopen it.
- **Whether the write itself was correct.** That is `rh-work-verification.md`'s outer-seam
  question. This rule is about the command never having been intended.

## Interaction with adjacent rules

- **`rh-work-verification.md`** — its outer-seam standard is the *after*; this rule is the
  *before*. A check that cannot fail has not passed, and a flag that cannot be rejected has not
  been accepted; the two are the same defect at different ends of the operation.
- **`rh-input-parsing.md`** — that rule governs parsing the *user's* message before acting.
  This one governs the *machine's* parsing of what you then type at it.
- **`rh-multi-session.md`** — the blast radius of an unintended write is widest on a shared
  surface, where other live sessions inherit it mid-turn.
- **`rh-replacement-assessment.md`** — an unintended overwrite is a removal nobody assessed.

## Failure modes this rule mitigates

An operator issuing what they believe is a read or a preview, and getting a write to a shared
surface, silently.

## Origin

2026-08-22. A session ran `rh-oversight init --help` to read the flag list; the installer ran
against the live user config directory instead. Both silences were present: the dispatcher
matched `--help` only at `argv[2]`, and `init`'s `parseArgs` ignored unrecognised tokens.

Blast radius was small, and *why* is the instructive part — the hash-based install guard
protected every drifted destination rather than overwriting it, and the one file that did change
changed by quoting only. **The guard held; the command should never have run.**

The sharper case surfaced during the write-up and was never hit: **`init --dryrun`**, one
character from `--dry-run`, performed a full real install while the operator believed they had
asked for a preview. That is the form of this bug that has no benign reading.

Both were fixed at the root in `rh-claude-framework` PR #177 — bin-level `--help` before
dispatch (excluding `settings`, which owns its own help), and unrecognised flags refused before
any filesystem work. Verified against disposable targets: both commands now create **0 files**,
where each previously produced a full install. The rule outlives the fix because the class is
not specific to that CLI.
