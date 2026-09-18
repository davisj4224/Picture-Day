# Picture Day

A self-hosted picture day system for one school. Import a roster, print a QR
card for every student, photograph the card then the student, drop the camera
card into the browser, and the photos sort themselves into private galleries
that you review before any family sees them.

Students design how it looks. Staff hold the roster and the photographs. The
two never touch.

---

## What's in the box

| Screen | Who | What it does |
| --- | --- | --- |
| `/` | Anyone | The school-facing page students designed |
| `/admin` | Staff | Floor board, roster, cards, upload, review, galleries, email |
| `/design` | Students | Colours, type, words, logo — draft only, staff publish |
| `/g/<token>` | One family | Their photos, download, expires |

---

## Running it the first time

You need [Node.js](https://nodejs.org) 18.17 or newer. Check with `node -v`.

```bash
cd school-picture-day
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste that random string into `.env` as `SESSION_SECRET`, then:

```bash
npm start
```

Open <http://localhost:3000>. The first visit asks you to create the staff
account and, if you want one, the student `design` password. There is no way
back into this screen afterwards — if you forget the password, run
`npm run reset-password -- yourname anewpassword`.

**Editing the site:** open the whole `school-picture-day` folder in VS Code
(File → Open Folder). The look of the parent-facing pages lives in
`public/brand.css`; the staff screens are `public/app.css`. Most branding
changes should happen in the design studio rather than in code.

---

## The picture day workflow

**A week before**

1. Roster → Import CSV. Headers can be named loosely — `First Name`,
   `Last Name`, `Grade`, `Teacher`, `Parent Email`, `Student ID`. A single
   `Name` column works too. See `sample-roster.csv`.
2. QR cards → pick a grade or take everyone → print the PDF at 100% on card
   stock. Eight per sheet with cut guides.
3. Sort the cut cards by homeroom and hand them to teachers.

**On the day**

```
photograph card  →  photograph student  →  photograph student  →  next card  →  …
```

One frame of the card is enough; fill most of the frame with it. If you miss a
card, keep shooting — those photos land in Review and you assign them by name
in about two seconds each.

**Afterwards**

4. Upload photos → name the batch → drop the whole camera card in. Your browser
   reads each photo, finds the cards, makes a preview, and uploads. Leave the
   tab open; 2,000 photos takes a while.
5. Review → anything that could not be attached to a student.
6. Galleries → look at a student's set, hide the blinks, then publish.
   "Publish everyone who is ready" handles the bulk once you trust the sort.
   **Publishing does not email anyone.**
7. Email → send the links, or export the CSV and send from the school's mail
   system.

The floor board on the first screen is one square per student, so you can see
at a glance who never got photographed while the backdrop is still up.

---

## How the sorting actually works

Each student has a permanent random code like `PD-2026-K4M7Q`. That string is
all the QR code contains — no name, no email, no student ID. The database is
the only thing that knows `PD-2026-K4M7Q` is Jane Smith.

On upload, photos are ordered by the time the camera recorded, and the app
walks the batch in order. A photo containing a known code becomes a marker and
sets the current student; every photo after it belongs to that student until
the next marker. Photos before the first marker are unassigned and go to
Review. A code that isn't on the roster is ignored and reported in the upload
log.

Photos you assign by hand are marked as such and are left alone if you re-sort
the batch.

**QR reading happens in the browser, not on the server.** Chrome and Edge have
a reader built in. Other browsers load `jsQR` — see `public/vendor/README.txt`
to vendor it for fully offline use.

---

## Galleries and links

Publishing a student mints a 32-character random token and a link like
`/g/Qm9vX3JhbmRvbV9zdHJpbmc`. It is not guessable, it is not listed anywhere,
and it stops working on the expiry date (Settings → galleries stay open for N
days). Unpublishing closes it immediately.

Set **Settings → Address families will use** to whatever hostname families will
actually type, or the links in emails will point at `localhost`.

---

## Email

Leave `SMTP_HOST` empty in `.env` and email stays off. That is the sensible
default for most schools: publish the galleries, export
`Email → Export links as CSV`, and mail-merge from the account the district
already approved.

To send from the app, fill in the SMTP block in `.env`, restart, then use
Email → Send test before touching real addresses. The subject and body accept
`{{student}}`, `{{first}}`, `{{school}}`, `{{event}}`, `{{year}}`, `{{link}}`
and `{{expires}}`.

---

## The design studio

Students sign in as `design` and get colour, type, wording, logo, artwork,
corners and background pattern, with a live preview of both the school page and
a sample gallery. The sample gallery uses coloured placeholders — the design
account can never load a real photograph or see a name.

Their work saves as a **draft**. A staff account clicks *Publish this design*
to make it live. That is the entire permission model, and it is worth keeping:
it means you can hand the studio to a class period without thinking about it.

---

## Before this goes on the open internet

This is a solid starter, not a hosted service. Student photographs and parent
email addresses are among the most sensitive things a school holds. Work
through this with whoever runs your network, and get the plan approved, before
the server is reachable from outside the building.

- [ ] **Talk to your district first.** Student photos are education records
      under FERPA. Ask about photo release status, directory-information
      opt-outs, and who is allowed to hold this data. Some districts will
      require it stay on district hardware.
- [ ] **HTTPS, always.** Put nginx, Caddy, or the district's reverse proxy in
      front of it with a real certificate, then set `SECURE_COOKIES=true`.
      Gallery links travel through email; they must not travel over plain HTTP.
- [ ] **Real `SESSION_SECRET`** in `.env`, and `.env` never committed to git.
- [ ] **Backups.** Everything lives in `data/pictureday.db` and `uploads/`.
      Back up both, encrypted, and test restoring once before picture day.
- [ ] **Retention.** Decide now when photos get deleted, write it down, and
      actually do it. Expiry closes links; it does not delete files.
- [ ] **Opt-outs.** Mark those students inactive before you print cards, or do
      not photograph them at all.
- [ ] **Least access.** One staff account per person who genuinely needs it.
      Do not share a login. Do not let the design password near the roster.
- [ ] **Keep it patched.** `npm audit` occasionally, and update Node.
- [ ] **Sessions are in memory.** Restarting the server signs everyone out.
      For a busy multi-user install, move to a session store backed by the
      database.
- [ ] **Uploads are trusted input.** Only signed-in staff can upload, and only
      images are accepted, but the files are served back to browsers — keep the
      server behind your firewall if you can.

A reasonable middle path: run it on a school machine on the internal network
during picture day, publish galleries there, export the links, and send the
emails from the district mail system. Nothing is exposed publicly, and families
still get their photos.

---

## Layout

```
school-picture-day/
├── server.js              API, auth, sorting, galleries
├── lib/
│   ├── db.js              schema, settings, code generation
│   ├── cards.js           the printable QR card PDF
│   └── mail.js            SMTP and the message template
├── views/                 the pages
├── public/                CSS and browser JavaScript
│   ├── app.css            staff screens
│   ├── brand.css          everything students can restyle
│   ├── qr-scan.js         in-browser QR reading + thumbnails
│   ├── admin.js  design.js  common.js
│   └── vendor/            optional offline jsQR
├── data/                  SQLite database (git-ignored)
├── uploads/               photographs and brand images (git-ignored)
└── sample-roster.csv
```

## Troubleshooting

**Nothing is being matched.** Check the upload log for "card found". If no
cards are ever found, the card photos are probably too small in frame or badly
lit. Shoot the card closer.

**"codes not on the roster".** You printed cards, then used *New code* on those
students, or imported a fresh roster that regenerated codes. Reprint.

**Everything went to one student.** The first card was missed and the sequence
never advanced. Re-sort after assigning the first group by hand, or fix the
batch in Review.

**Photos are sideways.** The app reads EXIF orientation when your browser
supports it. If a camera writes no orientation data, rotate before upload.

**The upload tab froze.** It is reading images, which is CPU-heavy. Upload in
batches of a few hundred rather than 3,000 at once.
