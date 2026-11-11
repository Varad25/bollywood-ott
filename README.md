# Access Bollywood (Stremio addon)

One Stremio catalog of new Indian movies & series added to Netflix, Amazon
Prime, Hulu and Zee5. Catalog only — no streams; each entry names the
platform so you can open it in that platform's own app.

## Install in Stremio

Visit [the addon page](https://varad25.github.io/bollywood-ott/) and choose
**Install in Stremio** to open the desktop/mobile app, or **Open in Stremio Web**
to install using the web app. Confirm installation in Stremio.

For manual installation:

1. Copy this URL:

   `https://varad25.github.io/bollywood-ott/manifest.json`

2. In Stremio, open **Add-ons**, paste the URL into the addon URL/search
   box, and press **Install**.

The catalog updates automatically as new titles are added.

## Landing page

Edit `landing-page.html` to update the website. `npm run export` copies it to
`docs/index.html` alongside the generated addon files, so catalog refreshes
preserve the page. The install links and copy button use the manifest URL
relative to the deployed page.
