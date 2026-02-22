# croncast

Automated browser tab video recording on a cron schedule. croncast captures any browser tab as an MP4 video using screenshots piped through ffmpeg, controlled via a built-in dashboard and scheduled with cron expressions. Runs as a native Windows desktop app via Electron.

## Quick Start

### Running in dev

```bash
npm install
npm run start:electron
```

This builds both the main app and the Electron wrapper, then launches the desktop window.

### Building an installer

```bash
npm run dist
```

Produces an NSIS installer in `release/`. The installer is Windows x64 only.

## Configuration

croncast uses a JSON config file stored in `%APPDATA%/croncast/config.json` (copied from `config.default.json` on first run).

### Minimal config (connect mode)

```json
{
  "browserURL": "http://localhost:9222",
  "outputDir": "./recordings",
  "jobs": [
    {
      "name": "My Recording",
      "urlPattern": "example.com/dashboard",
      "schedule": "0 10 * * *",
      "durationSeconds": 3600,
      "captureFps": 2
    }
  ]
}
```

### App config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `browserURL` | string | `http://localhost:9222` | Chrome DevTools Protocol URL (connect mode) |
| `executablePath` | string | — | Path to Chrome executable (launch mode) |
| `chromePath` | string | — | Chrome path for the built-in debug launcher |
| `autoLaunchChrome` | boolean | `false` | Auto-launch debug Chrome on startup |
| `headless` | boolean | `false` | Run launched browser headless |
| `outputDir` | string | `./recordings` | Directory for MP4 output |
| `minimizeToTray` | boolean | `true` | Minimize to system tray on close instead of quitting |
| `jobs` | array | — | Recording job definitions (see below) |

### Job config

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | string | Yes | Display name for the job |
| `urlPattern` | string | One of url/urlPattern | Substring to match against open tab URLs |
| `url` | string | One of url/urlPattern | URL to navigate to in a new tab |
| `schedule` | string | No | Cron expression (omit for manual-only) |
| `durationSeconds` | number | Yes | Recording length in seconds |
| `captureFps` | number | No | Frames per second, 1-30 (default: 2) |
| `viewportWidth` | number | No | Override viewport width in pixels |
| `viewportHeight` | number | No | Override viewport height in pixels |

## Connect Mode vs Launch Mode

croncast supports two ways to control the browser:

- **Connect mode** (default): Connects to an already-running Chrome instance via the DevTools Protocol. Set `browserURL` in config. You can configure a Chrome path in Settings and enable auto-launch to have croncast start Chrome for you.

- **Launch mode**: croncast launches and manages its own Chrome instance. Set `executablePath` to your Chrome binary path. Useful for headless or automated deployments.

Only one mode can be active — `browserURL` and `executablePath` are mutually exclusive.

## Dashboard

The built-in dashboard provides:

- **Jobs** — Create, edit, test, and trigger recording jobs
- **Monitor** — Live view of active and completed recordings
- **Recordings** — Browse, play, and manage saved MP4 files
- **Settings** — Configure browser connection, output directory, theme, and tray behavior

## How It Works

- Electron's main process runs the Express server in-process (config, preflight, scheduler, server)
- A frameless BrowserWindow loads the dashboard from `http://127.0.0.1:{port}`
- Config is stored in `%APPDATA%/croncast/config.json`
- ffmpeg is bundled via `ffmpeg-static` — no PATH dependency
- Closing the window minimizes to the system tray (configurable in Settings)
- Auto-updates are handled by `electron-updater` from GitHub Releases

## Releasing

Push a version tag to trigger the GitHub Actions release workflow:

```bash
git tag v1.0.0
git push origin v1.0.0
```

This builds the installer on `windows-latest` and publishes it as a GitHub Release.

## Development

```bash
npm run build           # Build TypeScript + copy static assets
npm run build:electron  # Build Electron TypeScript
npm test                # Run all tests
npm run lint            # Lint with ESLint
npx tsc --noEmit        # Type check without emitting
```

## License

[MIT + Commons Clause](LICENSE) — Free to use, modify, and distribute. You cannot sell the software or offer it as a paid service.
