# Security policy

## Reporting a problem

Please don't report security problems in public issues, discussions, or pull requests.

Report them privately through GitHub:
[Report a vulnerability](https://github.com/LeafyCode/kriyon/security/advisories/new).
If you can't use GitHub, email [hello@leafycode.com](mailto:hello@leafycode.com) with
"Kriyon security" in the subject.

Include what you can:

- what the problem is and what an attacker could do with it
- the steps to reproduce it
- the Kriyon version and macOS version
- any proof-of-concept code or logs

## What happens next

- We aim to confirm we've received your report within 3 working days.
- We'll keep you updated while we investigate and fix it.
- Once a fix ships, we publish a GitHub security advisory and credit you, unless you'd rather
  stay anonymous.

Please give us a reasonable chance to ship a fix before you disclose the problem publicly.

## Supported versions

Only the latest stable release gets security fixes. Beta and nightly builds get fixes through
their normal updates.

## Scope

In scope: the Kriyon app, its helper process, its update feed, and the code in this repository.

Out of scope: the `claude` CLI itself and Anthropic's services. Kriyon runs the CLI you
installed and never touches your Claude credentials. Report problems in Claude Code to
Anthropic.
