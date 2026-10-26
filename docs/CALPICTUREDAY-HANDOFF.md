# CalPictureDay Development Handoff

## Purpose and scope

Picture Day manages school picture-day rosters, photographs, QR-code matching,
student galleries, and staff workflows. The next month's work is to make
careful, isolated upgrades while preserving the live service and existing
student, photo, gallery, publication, and QR-code state.

This handoff is for development only. No production deployment, production
data change, or merge to `main` is authorized.

## Branch and worktree safety

- Production baseline and `main` commit: `4f77079e8411126453c94d7c72230e96b8069fb1`
- Development branch: `feature/cal-picture-day`
- Feature worktree: `/workspaces/Picture-Day-feature-cal-picture-day`
- Separate original worktree: `/workspaces/Picture-Day`
- The original worktree is on `temp/storage-persistence-test` at
  `08493393c9a247825d99c39ec22210c403b0a7c8`; it contains separate user work
  and must remain untouched.

At the start of this preparation, the feature branch was exactly at the
production baseline (`4f77079e8411126453c94d7c72230e96b8069fb1`, zero commits
ahead or behind). Its pre-checkpoint worktree state was:

- Modified: `README.md`, `godaddy-deploy/README.md`,
  `godaddy-deploy/lib/photo-routes.js`, `godaddy-deploy/server.js`,
  `godaddy-deploy/test/photo-storage.test.js`
- Untracked: `godaddy-deploy/lib/upload-security.js`,
  `godaddy-deploy/test/upload-security.test.js`
- No other feature-worktree changes were present in the full status.

The commit and push for the reviewed files and this handoff are being handled
as a feature-branch-only recovery checkpoint. On resume, use `git status` and
`git log` to verify the actual post-checkpoint state rather than assuming the
pre-checkpoint snapshot above is still current.

## Reviewed changes

The reviewed changes concern upload security and its directly related tests and
documentation:

- `godaddy-deploy/lib/upload-security.js` validates uploaded image content
  using Sharp, canonicalizes file extensions, stages files under randomized
  temporary names, limits upload sizes, avoids overwriting existing
  destinations, and removes staged/promoted files after validation or database
  persistence failures.
- Student-photo uploads now reject content Sharp cannot recognize and decode.
  The previous fallback that accepted arbitrary unverified bytes based on
  unfamiliar client filenames or MIME types has been removed. Unsupported
  formats receive an actionable error; additional camera formats must be
  verified before support is added.
- Branding uploads validate content and allow the formats already specified
  for branding. SVG delivery receives a sandbox policy header.
- `godaddy-deploy/server.js` wires the validation into photo and branding
  upload routes, handles upload-size status/messages, and keeps database
  inserts inside the cleanup-protected persistence callbacks.
- `godaddy-deploy/lib/photo-routes.js` applies SVG safety headers while leaving
  staff and token-authorized gallery retrieval, including legacy path fallback,
  in place.
- `godaddy-deploy/test/upload-security.test.js` covers valid recognized
  images, malformed and unrecognized input, MIME/name mismatches, cleanup,
  database failure, destination collisions, branding uploads, SVG policy, and
  oversize request cleanup.
- `godaddy-deploy/test/photo-storage.test.js` checks the upload middleware
  wiring and resolved storage paths.
- `README.md` and `godaddy-deploy/README.md` document validation and the
  camera-format verification requirement.

The upload changes do not rewrite student rows, photo records, gallery
associations, publication state, QR codes, or existing stored filenames.
Storage continues to resolve to `/private/pictureday` in production, and
legacy photo retrieval remains implemented through the existing fallback
locations.

## Verification and limitations

The documented full suite was run under Node `v22.23.4` using an isolated
environment and the package test command:

```sh
env -i PATH="$PATH" HOME="$HOME" npm exec --yes --package=node@22 -- npm test -- --test-reporter=spec
```

Result: 39 tests total, 38 passed, 0 failed, 1 skipped. The skipped test is the
MySQL persistence integration test. It requires an explicitly named dedicated
test database plus database credentials; these were not provided to the test
process. The suite's network tests bind to loopback, and the tests do not send
email or use production storage. `git diff --check` passed.

Earlier focused checks in the preceding review also passed: 24 upload-security
and photo-storage tests, plus the isolated legacy full-size/thumbnail
retrieval test.

No representative, non-sensitive school camera samples have been verified.
The actual camera formats and browser export behavior are still unknown. Do
not claim real camera compatibility and do not add format support based only on
an extension or declared MIME type. Verify each additional format using a
non-sensitive representative sample in an isolated test fixture.

## Future upgrade tasks

Proceed one explicitly approved task at a time:

1. Review and approve a minimal, isolated compatibility-test plan for the
   actual camera/browser image formats before creating fixtures or adding
   support. BMP support is not listed by the installed Sharp build; HEIC
   support is unconfirmed. Actual camera/browser compatibility remains
   unverified.
2. Review and improve parsing/validation of multiple parent email recipients.
3. Design and test separate picture-day sessions without invalidating existing
   QR codes or gallery access.
4. Design and test a safe annual roster-update workflow.
5. Improve deployment, backup, recovery, and handoff documentation.
6. Consider legacy-file removal only after its recovery value is established.

These are candidate tasks, not blanket authorization to implement them.

## Production and recovery precautions

- Live website: <https://calcharterpicts.org/>
- Production branch: `main`
- Production storage is `/private/pictureday`; do not inspect or change it.
- Never merge, push to `main`, deploy, publish, or change live data without
  separate explicit approval.
- Do not use production credentials or secrets in tests.
- Do not access production photos, rosters, database contents, publication
  state, or QR codes.
- Do not run imports, restore scripts, migrations, email sends, or deployment
  commands as part of development review.
- Treat all existing worktree modifications as valuable user work. Never
  reset, clean, stash, discard, or overwrite them.
- Keep backups and recovery tests isolated from production. Before any future
  recovery operation, verify its manifest, source, destination, and dry-run
  results in a disposable fixture; do not run a production restore without
  separate approval.
- Push only the verified feature branch as a recovery checkpoint. Never
  force-push. If the remote feature branch has unexpected commits, stop and
  ask before pushing.

## Resume after a Codespaces restart

1. Read this handoff before acting.
2. Verify the feature worktree and branch:

   ```sh
   git -C /workspaces/Picture-Day-feature-cal-picture-day rev-parse --show-toplevel
   git -C /workspaces/Picture-Day-feature-cal-picture-day branch --show-current
   git -C /workspaces/Picture-Day-feature-cal-picture-day rev-parse HEAD
   git -C /workspaces/Picture-Day-feature-cal-picture-day status --short --untracked-files=all
   ```

3. Verify the branch is `feature/cal-picture-day`; compare its history with
   baseline `4f77079e8411126453c94d7c72230e96b8069fb1`. If state differs
   unexpectedly, stop and report rather than repairing it.
4. Read the original worktree's branch, HEAD, and status only. Do not switch
   branches or modify anything under `/workspaces/Picture-Day`.
5. Review the current handoff, feature status, and latest commit before
   selecting one next task. Do not begin another feature until it is explicitly
   authorized.

## Handoff checkpoint

- October 26, 2026: reviewed upload-format compatibility. No tests were run
  and no fixtures were created in this review. Actual camera/browser
  compatibility remains unverified; BMP support is not listed by the installed
  Sharp build, and HEIC support is unconfirmed.
- Next task: review and approve a minimal, isolated compatibility-test plan.
  Do not begin implementation or create fixtures until approved.
- Separate unresolved issue — Gmail email deliverability: some Gmail
  recipients report missing Picture Day emails even though GoDaddy shows them
  as sent. Test messages reached the owner's two Gmail accounts, but this does
  not establish reliable delivery for all recipients. The cause is unknown;
  “sent” does not prove inbox delivery. A separately approved future
  investigation may check recipients' Spam and All Mail folders, SPF/DKIM/DMARC,
  actual SMTP responses, and bounce/deferred/rejection information. Email
  troubleshooting is a separate future task. Do not change email code, SMTP
  settings, DNS, or production configuration during this work.
- This handoff records the pre-checkpoint status for traceability. Verify the
  actual branch HEAD and clean/dirty status with the commands above after
  resuming.
