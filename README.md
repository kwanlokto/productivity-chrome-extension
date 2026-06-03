# 🌱 Focus Guard — Productivity Chrome Extension

A Manifest V3 Chrome extension that protects your attention by blocking
distracting sites and taming YouTube's doom-scroll machinery.

## Features

- **Site blocking** — Facebook, Instagram, and TikTok are blocked out of the box.
  Blocked visits are redirected to a calm reminder page.
- **Custom block list** — Add or remove any domain from the popup. Your list syncs
  across your Chrome profile via `chrome.storage.sync`.
- **Anti doom-scroll for YouTube** — Toggle off the features designed to keep you
  scrolling:
  - Hide Shorts (shelves, sidebar entry, search results)
  - Hide the home feed (replaced with a gentle nudge to search intentionally)
  - Hide sidebar recommendations, end-screen cards, and disable autoplay-next
  - Hide comments
  - Grayscale mode to make the site less dopamine-inducing

## How it works

| Piece | Role |
|-------|------|
| [background.js](background.js) | Syncs `declarativeNetRequest` dynamic rules from your blocked-domain list and redirects matching `main_frame` loads to the blocked page. |
| [blocked.html](blocked.html) / [blocked.js](blocked.js) | The "stay focused" page shown when a blocked site is opened. |
| [popup/](popup/) | The toolbar UI for managing domains and YouTube settings. |
| [content/youtube.js](content/youtube.js) / [content/youtube.css](content/youtube.css) | Toggle `<html>` classes that hide distracting YouTube elements; re-applies across SPA navigation. |

Settings live in `chrome.storage.sync` under two keys: `blockedDomains` (array of
bare domains) and `youtube` (the feature toggles).

## Install (developer / unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin **Focus Guard** and click the icon to manage your block list and YouTube settings.

## Notes

- YouTube changes its markup often; if an element stops being hidden, the selectors
  in [content/youtube.css](content/youtube.css) may need updating.
- Domain blocking matches the domain and all subdomains (e.g. blocking `facebook.com`
  also blocks `m.facebook.com`).
