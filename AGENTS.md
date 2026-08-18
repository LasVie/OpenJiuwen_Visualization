# Visualization Web Agent Instructions

## Repository scope

- This Git repository owns only the standalone visualization web application.
- Treat sibling `agent-core` and `jiuwenswarm` repositories as source references; never vendor, stage, commit, or modify them as part of this repository unless the user explicitly changes that boundary.
- Keep product features modular and expose cross-feature behavior through typed public entry points rather than importing feature internals.

## Verification

- Run `npm run check` before publishing implementation changes.
- If browser-visible behavior changes, also verify the affected interaction in a real browser and report any unverified surface.

## Commit and push policy

- The canonical remote is `https://github.com/LasVie/OpenJiuwen_Visualization`.
- After completing each user-authorized repository change, create a concise, descriptive commit that states the delivered outcome and push the current branch to `origin` without requesting routine confirmation.
- This standing push authorization does not broaden the requested change scope, authorize unrelated files, waive verification, or permit force-pushes, history rewrites, destructive Git operations, releases, or repository-setting changes.
- When branch protection or the requested workflow requires review, push the working branch and use a pull request instead of bypassing protection.
