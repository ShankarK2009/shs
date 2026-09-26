# [stevenson.space](https://stevenson.space)
Beautiful and practical agenda management tool for SHS students

![media-preview-image](https://user-images.githubusercontent.com/31457361/190948845-b6870bef-9186-4971-b398-47616f503c6b.png)

## Project setup
```
npm install
```

### Compiles and hot-reloads for development
```
npm run dev
```

### Compiles and minifies for production
```
npm run build
```

### Lints and fixes files
```
npm run lint
```

### Setting up your .env file
Duplicate the `.env-template` and rename the duplicate to `.env`. This will keep the template, and give you a personal development environment that won't get commited to github.

## Static data API

`ingest/api.ts` generates a read-only JSON API at build time into `public/api/v1/`, which
Vite copies into `dist/`. These are plain files on the CDN, not Worker routes, so serving
them costs nothing.

| Endpoint | Contents |
| --- | --- |
| `/api/v1/signature.json` | Just the signature and lunch window — cheap to poll |
| `/api/v1/schedules.json` | Schedules and their period times, with `dates` resolved |
| `/api/v1/schedule-dates.json` | The raw schedule name → dates map |
| `/api/v1/lunch.json` | One menu per school day in a rolling window |

Every response carries `version`, `generatedAt`, and a `signature`:

```json
"signature": {
  "schedules": "52e9262b…",
  "scheduleDates": "8de5ff53…",
  "lunch": "c147cb88…",
  "combined": "34be508e…"
}
```

Each value is a SHA-256 over the **source files**, not over the response body. So
`schedules` is the hash of `src/data/schedules.json`, and `lunch` is a hash over the six
files in `src/data/lunch-rotating/` plus the rotation config in `src/utils/food/rotating-map.ts`
(the valid range, semester switch, week offset, and cycle period all change what the menus
say). A client caches the hashes it last saw and only refetches a section whose hash moved.

### The lunch window

`lunch.json` covers one week behind and three weeks ahead of the build date, skipping
weekends, no-school days, and summer. The site is rebuilt nightly, so the window advances
on its own.

Because the signature hashes files rather than the response, it does *not* change when the
window slides. That is deliberate — it separates "the menu data changed" from "I am running
out of days". For the second, use `window.refreshAfter`: refetch once the current date
reaches it, which is the point where only a week of future menus is left.

```json
"window": {
  "start": "2026-09-13",
  "end": "2026-10-11",
  "refreshAfter": "2026-10-04"
}
```

`end` is clamped to `validRange`, the range the rotating menu data actually covers. Once
`end` reaches `validRange.end`, the source data is exhausted and refetching will not produce
more days until `src/data/lunch-rotating/` is updated. If the window falls outside that range
entirely, `start` and `end` are `null` and `days` is empty.

### Regenerating

```
npm run generate-api
```

This also runs as part of `npm run dev` and `npm run prebuild`. Pass `--today` to anchor the
window somewhere other than the real current date, which is useful for inspecting a past or
future window:

```
npx tsx ingest/api.ts --today 2026-10-15
```

The output is generated, not committed — `public/api/` is gitignored.

## Contributing
Interested in contributing? Check out the [documentation](https://github.com/stevenson-space/shs/wiki) (WIP)
