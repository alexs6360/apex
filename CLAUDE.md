# Standing rules

## Ship finished work, don't hold it

When work is finished and verified, commit and push to `preview` as part
of finishing — not as a separate step waiting on a prompt. Then report
the commit SHA and the deploy state read from the Netlify API (not
assumed from the push alone). If something should NOT be pushed, say so
explicitly rather than leaving it uncommitted by default.

Why: finished work sitting uncommitted in the working tree means the
next review is against a stale build, not what was actually done. This
happened twice in two days before the rule was written.

## Save screenshots where the user can get to them

Browser-automation screenshots (the `computer`/`zoom` tools' `save_to_disk`
output) land in a Chrome-extension temp directory under `/var/folders/...`
by default — not reliably reachable from outside this session. Instead,
save to `.screenshots/` in the repo root (gitignored — these are review
artifacts, not project files) and always give the full absolute path,
not a bare filename.

Why: a bare filename or a `/var/folders/...` path looks like a normal
result but isn't somewhere the user can actually open it.
