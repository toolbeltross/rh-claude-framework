# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this project, please report it
privately so it can be addressed before public disclosure.

- **Preferred:** open a [GitHub Security Advisory](https://github.com/toolbeltross/rh-claude-framework/security/advisories/new)
  (Security → Advisories → "Report a vulnerability").
- **Alternatively:** email **ross@toolbelt.work** with the details.

Please include, where possible:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept welcome),
- affected version / commit, and
- any suggested remediation.

Please **do not** open a public issue for security reports.

## What to expect

- Acknowledgement of your report as soon as practical.
- An assessment and, where warranted, a fix and coordinated disclosure.
- Credit for the report if you would like it.

## Scope

This framework runs locally and reads local Claude Code data (e.g.
`~/.claude/` settings and session metadata). Reports of interest include, but
are not limited to: leakage of credentials or personal data into logs, output,
or committed artifacts; path-traversal or injection in the hook/guard scripts;
and unsafe handling of `settings.json` during install.
