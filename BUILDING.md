# Building and releasing

The app is a WebView around the web UI in `static/`, plus a small Python HTTP
server (`app.py`, standard library only) that runs inside the app on
`127.0.0.1:38095` through [Chaquopy](https://chaquo.com/chaquopy/). The page
talks to it with ordinary `/api` requests, so `app.py` and `static/` are the
same code that can also run as a normal server.

| Path | What it is |
|---|---|
| `app.py` | The server and all the tracker logic; SQLite at `$DATA_DIR/tracker.db` |
| `static/` | The UI: `index.html`, `app.js`, `style.css` |
| `android/app/src/main/python/tracker_host.py` | Starts `app.py` in the app; backup and restore |
| `android/.../TrackerApp.kt` | Starts Python when the app process starts |
| `android/.../Backups.kt` | Backup, restore and the automatic backup folder (Storage Access Framework) |
| `android/.../TrackingService.kt` | Foreground GPS service; `DistanceTracker.kt` filters the fixes |
| `android/build.sh` | Build, sign, commit, push, and publish the GitHub release |
| `android/CHANGELOG.txt` | Release notes; the "Unreleased" section becomes the next version |

## Requirements (Windows, Git Bash)

- Android SDK, JDK 17 and Gradle 8.11.1 under `%LOCALAPPDATA%\Android`
  (override with `ANDROID_TOOLS`), laid out as `Sdk/`, `jdk-17/`,
  `gradle-8.11.1/`.
- Python 3.12 on the PATH (Chaquopy compiles the app's Python with it;
  override with `BUILD_PYTHON`).
- `android/signing/release.jks` and `android/signing/signing.properties`
  (`storePassword`, `keyPassword`, `keyAlias`). These are not in the repo.
  Every update must be signed with the same key, or Android refuses to install
  it over the old app. Keep a copy of both files somewhere safe.
- The GitHub CLI (`gh`), signed in, for the release step.

## Build and release

1. Write the changes under `Unreleased` at the top of `android/CHANGELOG.txt`.
2. Run `bash android/build.sh`.

It bumps `android/version.properties` (versionCode N, versionName 1.N), runs
the unit tests, builds the signed APK, commits and pushes the source, and
creates GitHub release `v1.N` with the changelog entry as notes and
`delivery-tracker-1.N.apk` attached. Installed apps find it through
`https://api.github.com/repos/Hellreaver/delivery-tracker-standalone/releases/latest`.
`NO_GITHUB=1` skips the commit and release.

## Testing the server on a PC

```bash
DATA_DIR=/tmp/tracker HOST=127.0.0.1 PORT=38095 python app.py
```

Then open `http://127.0.0.1:38095`. The Android-only parts (GPS, backup
buttons) are hidden in a browser.
