# croncast

Automated browser tab video recording on a cron schedule. croncast captures any browser tab as an MP4 video using screenshots piped through ffmpeg, controlled via a web dashboard and scheduled with cron expressions.

## Prerequisites

- **Node.js 18+**
- **Google Chrome** (or Chromium-based browser)
- **ffmpeg** — must be installed and available on your PATH

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Start — copies config.default.json to config.json on first run
npm start
```

Edit `config.json` to match your setup. This file is gitignored so your local settings stay private.

Open **http://localhost:3000** to access the dashboard. From there you can configure your browser connection, create recording jobs, and test the pipeline.

To use a different config file:

```bash
node dist/index.js path/to/config.json
```

## Configuration

croncast uses a JSON config file (`config.json` by default).

### Minimal config (connect mode)

```json
{
  "browserURL": "http://localhost:9222",
  "outputDir": "./recordings",
  "port": 3000,
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
| `headless` | boolean | `false` | Run launched browser headless |
| `outputDir` | string | `./recordings` | Directory for MP4 output |
| `port` | number | `3000` | Web UI port |
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

- **Connect mode** (default): Connects to an already-running Chrome instance via the DevTools Protocol. Set `browserURL` in config. You can start Chrome yourself with `--remote-debugging-port=9222`, or use the built-in debug launcher from the dashboard Settings tab.

- **Launch mode**: croncast launches and manages its own Chrome instance. Set `executablePath` to your Chrome binary path. Useful for headless or server deployments.

Only one mode can be active — `browserURL` and `executablePath` are mutually exclusive.

## Web Dashboard

The dashboard at `http://localhost:{port}` provides:

- **Jobs** — Create, edit, test, and trigger recording jobs
- **Monitor** — Live view of active and completed recordings
- **Recordings** — Browse, play, and manage saved MP4 files
- **Settings** — Configure browser connection, Chrome launcher, and app settings

## Development

```bash
npm run build       # Build TypeScript + copy static assets
npm test            # Run all tests
npm run lint        # Lint with ESLint
npx tsc --noEmit    # Type check without emitting
```

## License

[MIT + Commons Clause](LICENSE) — Free to use, modify, and distribute. You cannot sell the software or offer it as a paid service.
