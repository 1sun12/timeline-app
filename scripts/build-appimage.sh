#!/bin/sh
# Builds a self-contained Linux AppImage: glibc, its loader and WebKitGTK ship inside,
# so it runs on any distro regardless of the host's C library.
# quick-sharun (pkgforge-dev/Anylinux-AppImages) deploys the libraries; the official
# appimagetool packs them as SquashFS with the static type2 runtime and update info.
# Run from the repo root inside an archlinux container (see .github/workflows/build.yml).
set -eux

# patchelf, strace and xvfb are quick-sharun's: it runs the app briefly to find dlopened libraries.
pacman -Syu --noconfirm --needed base-devel git wget rust nodejs npm webkit2gtk-4.1 librsvg \
	desktop-file-utils patchelf strace xorg-server-xvfb

npm ci
npx tauri build --no-bundle

TOOLS=$(mktemp -d)
wget -qO "$TOOLS"/quick-sharun https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/main/useful-tools/quick-sharun.sh
wget -qO "$TOOLS"/appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x "$TOOLS"/*

# Desktop file and icon are named after the app identifier in tauri.conf.json.
ID=$(node -p "require('./src-tauri/tauri.conf.json').identifier")
cat > "$TOOLS"/$ID.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Timeline
Comment=Plot what you read on a timeline
Exec=timeline-app
Icon=$ID
Categories=Office;
Terminal=false
StartupWMClass=timeline-app
EOF
desktop-file-validate "$TOOLS"/$ID.desktop
cp src-tauri/icons/128x128@2x.png "$TOOLS"/$ID.png

rm -rf AppDir
DESKTOP="$TOOLS"/$ID.desktop ICON="$TOOLS"/$ID.png \
	"$TOOLS"/quick-sharun src-tauri/target/release/timeline-app

VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
mkdir -p dist
# No FUSE in containers, so run appimagetool extracted.
ARCH=x86_64 VERSION=$VERSION "$TOOLS"/appimagetool --appimage-extract-and-run \
	-u "gh-releases-zsync|1sun12|timeline-app|latest|Timeline_*_amd64.AppImage.zsync" \
	AppDir dist/Timeline_"$VERSION"_amd64.AppImage
