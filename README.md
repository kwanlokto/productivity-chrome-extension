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
- **Settings tab** — Change how long "Unlock" lifts a block for, save your settings
  to a JSON file, load them back, or reset everything to defaults.

## How it works

| Piece | Role |
|-------|------|
| [background.js](background.js) | Syncs `declarativeNetRequest` dynamic rules from your blocked-domain list and redirects matching `main_frame` loads to the blocked page; restores blocks when a snooze alarm fires. |
| [blocked.html](blocked.html) / [blocked.js](blocked.js) | The "stay focused" page shown when a blocked site is opened. |
| [popup/](popup/) | The toolbar UI (ES modules — see below). |
| [content/youtube.js](content/youtube.js) / [content/youtube.css](content/youtube.css) | Toggle `<html>` classes that hide distracting YouTube elements; re-applies across SPA navigation. |

### Popup modules

The popup ([popup/popup.html](popup/popup.html)) loads [popup/popup.js](popup/popup.js)
as an ES module, which is split by concern:

| Module | Responsibility |
|--------|----------------|
| [config.js](popup/config.js) | Constants (defaults, snooze length, ring geometry). |
| [util.js](popup/util.js) | Pure helpers: domain/channel normalization, clock formatting. |
| [storage.js](popup/storage.js) | All `chrome.storage` reads/writes (domains, YouTube settings, channels, snooze). |
| [rules.js](popup/rules.js) | Add/remove `declarativeNetRequest` blocking rules directly. |
| [tabs.js](popup/tabs.js) | `chrome.tabs` helpers (active tab, current domain, navigate, reload). |
| [actions.js](popup/actions.js) | High-level actions (add/remove/block/snooze/unsnooze) combining the above. |
| [sites-view.js](popup/sites-view.js) | "Blocked sites" tab: list + the circular status/action control. |
| [youtube-view.js](popup/youtube-view.js) | "YouTube" tab: focus toggles + allowed-channels list. |
| [settings-view.js](popup/settings-view.js) | "Settings" tab: unlock duration, backup/restore to a file, reset to defaults. |
| [popup.js](popup/popup.js) | Entry point: tab navigation + view init. |

Settings live in `chrome.storage.sync` under `blockedDomains` (array of bare
domains), `youtube` (the feature toggles), `allowedChannels` (allow-listed
handles), and `unlockMinutes` (how long "Unlock" lifts a block for). Active
snoozes live in `chrome.storage.local` under `snoozed`
(`{ domain: { start, expiry } }`).

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
