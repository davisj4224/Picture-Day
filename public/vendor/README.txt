Optional: to run picture day with no internet connection at all, download
jsQR and save it here as jsQR.js:

  https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js

The upload screen loads /assets/vendor/jsQR.js first and only falls back to
the CDN if that file is missing. Chrome and Edge do not need it at all --
they have a QR reader built in.

Fonts are also loaded from Google Fonts. Offline, the pages fall back to
Helvetica/Georgia, which is fine.
