#!/usr/bin/env bash
# Builds the standalone Android app, from Git Bash on Windows:
#   bash android/build.sh
#
# Copies the project to a local folder first (Gradle dislikes '#' in paths,
# and building over SMB is slow), bundles ../static as the app's UI and
# ../app.py as the server it runs inside itself, runs the unit tests, builds
# a signed release APK, and publishes it as a GitHub release, which is where
# the installed app looks for updates. See BUILDING.md.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${ANDROID_TOOLS:-$(cygpath -m "$LOCALAPPDATA" 2>/dev/null || echo "$HOME/AppData/Local")/Android}"
BUILD="$TOOLS/build/delivery-tracker-standalone"
PUBLISH="${APK_PUBLISH_DIR:-}"   # optional folder that keeps a copy of every APK
export JAVA_HOME="$TOOLS/jdk-17"
export ANDROID_HOME="$TOOLS/Sdk"
export PATH="$JAVA_HOME/bin:$PATH"
# Chaquopy compiles the Python with a desktop Python of the same version (3.12).
BUILD_PYTHON="${BUILD_PYTHON:-$(command -v python)}"
command -v cygpath >/dev/null && BUILD_PYTHON="$(cygpath -w "$BUILD_PYTHON")"
export BUILD_PYTHON

[ -f "$SRC/signing/release.jks" ] || { echo "missing $SRC/signing/release.jks"; exit 1; }

# Each build gets a higher versionCode so it installs over the previous one,
# and the version name 1.N to match. The changelog's "Unreleased" heading
# becomes that version.
python - "$SRC/version.properties" "$SRC/CHANGELOG.txt" <<'PY'
import re, sys
props, changelog = sys.argv[1:3]
out, code = [], None
for line in open(props).read().splitlines():
    if line.startswith("versionCode="):
        code = int(line.split("=", 1)[1]) + 1
        line = "versionCode=%d" % code
    if not line.startswith("versionName="):
        out.append(line)
name = "1.%d" % code
out.append("versionName=" + name)
open(props, "w", newline="\n").write("\n".join(out) + "\n")
text = open(changelog, encoding="utf-8").read()
if re.search(r"^Unreleased[ \t]*$", text, re.M):
    text = re.sub(r"^Unreleased[ \t]*$", name, text, count=1, flags=re.M)
    open(changelog, "w", encoding="utf-8", newline="\n").write(text)
else:
    print("note: no 'Unreleased' section in CHANGELOG.txt, so %s has no notes" % name)
print("versionCode=%d versionName=%s" % (code, name))
PY

rm -rf "$BUILD"
mkdir -p "$BUILD"
cp -r "$SRC/." "$BUILD/"
rm -f "$BUILD/delivery-tracker.apk"
mkdir -p "$BUILD/app/src/main/assets/web"
cp "$SRC/../static/"* "$BUILD/app/src/main/assets/web/"
mkdir -p "$BUILD/app/src/main/python"
cp "$SRC/../app.py" "$BUILD/app/src/main/python/app.py"
printf 'sdk.dir=%s\n' "$(printf '%s' "$ANDROID_HOME" | sed 's#:#\\:#')" > "$BUILD/local.properties"

cd "$BUILD"
"$TOOLS/gradle-8.11.1/bin/gradle" --no-daemon --console=plain testReleaseUnitTest assembleRelease

APK="$BUILD/app/build/outputs/apk/release/app-release.apk"
cp "$APK" "$SRC/delivery-tracker.apk"
# The server reads this to tell the installed app an update is waiting and
# what changed.
python - "$SRC/version.properties" "$SRC/CHANGELOG.txt" "$SRC/delivery-tracker.apk.json" <<'PY'
import json, re, sys
props, changelog, dest = sys.argv[1:4]
p = dict(l.split("=", 1) for l in open(props).read().splitlines() if "=" in l)
changes, cur = [], None
for line in open(changelog, encoding="utf-8").read().splitlines():
    head = re.fullmatch(r"(\d+)\.(\d+)\s*", line)
    if head:
        cur = {"version": line.strip(), "code": int(head.group(2)), "items": []}
        changes.append(cur)
    elif cur and line.startswith("- "):
        cur["items"].append(line[2:].strip())
    elif cur and cur["items"] and line.startswith("  ") and line.strip():
        cur["items"][-1] += " " + line.strip()
json.dump({"version_code": int(p["versionCode"]), "version_name": p["versionName"],
           "changes": changes[:20]}, open(dest, "w", encoding="utf-8"), indent=1)
PY
VC="$(sed -n 's/^versionCode=//p' "$SRC/version.properties")"
VN="$(sed -n 's/^versionName=//p' "$SRC/version.properties")"
if [ -n "$PUBLISH" ] && [ -d "$PUBLISH" ]; then
    mkdir -p "$PUBLISH/versions"
    cp "$APK" "$PUBLISH/versions/delivery-tracker-$VN.apk"
    echo "saved $PUBLISH/versions/delivery-tracker-$VN.apk"
fi
ls -la "$SRC/delivery-tracker.apk"

# Commit the source, push, and put the APK on GitHub's Releases tab as v1.N
# with its changelog entry as the notes. The APK itself is never committed.
# A failure here only warns: the build itself is already done.
# Skip with NO_GITHUB=1.
GH="${GH:-C:/Program Files/GitHub CLI/gh.exe}"
github_release() {
    local repo notes asset
    repo="$(cd "$SRC/.." && pwd)"
    notes="$(mktemp)"
    asset="$(mktemp -d)/delivery-tracker-$VN.apk"
    cp "$APK" "$asset"
    python - "$SRC/CHANGELOG.txt" "$VN" > "$notes" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"^%s\n(.*?)(?=^\d+\.\d+\n|\Z)" % re.escape(sys.argv[2]), text, re.S | re.M)
print(m.group(1).strip() if m else "(no changelog entry)")
PY
    git -C "$repo" add -A || return 1
    git -C "$repo" diff --cached --quiet || git -C "$repo" commit -q -m "$VN" \
        -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" || return 1
    git -C "$repo" push -q origin HEAD || return 1
    (cd "$repo" && "$GH" release create "v$VN" "$asset" \
        --title "$VN" --notes-file "$notes" --target "$(git rev-parse HEAD)" --latest) || return 1
    rm -f "$notes" "$asset"
}
if [ "${NO_GITHUB:-0}" = 1 ]; then
    echo "NO_GITHUB=1: skipped GitHub"
elif [ -x "$GH" ]; then
    github_release && echo "GitHub: pushed and released v$VN" \
        || echo "WARNING: GitHub push or release failed; the build itself is fine"
else
    echo "WARNING: gh not found at $GH; skipped GitHub release"
fi
