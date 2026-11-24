#!/bin/sh
# Builds a self-contained Linux AppImage: glibc, its loader and WebKitGTK ship inside,
# so it runs on any distro regardless of the host's C library.
# quick-sharun (pkgforge-dev/Anylinux-AppImages) deploys the libraries; the official
# appimagetool packs them as SquashFS with the static type2 runtime and update info.
#
# Two phases, each run from the repo root in its own fresh archlinux container
# (see .github/workflows/build.yml), so release keys never share a job with npm
# or third-party build scripts:
#   sh scripts/build-appimage.sh appdir   build the app and its AppDir -> AppDir.tar
#   sh scripts/build-appimage.sh pack     AppDir.tar -> dist/*.AppImage + .AppImage.zsync
#     signs when APPIMAGE_GPG_KEY and APPIMAGE_GPG_PASSPHRASE are set; REQUIRE_SIGNATURE=true
#     (tag builds) makes a missing key an error instead of an unsigned build.
set -eu

# Pinned third-party tools. Bump a pin and its sha256 together.
ANYLINUX=https://raw.githubusercontent.com/pkgforge-dev/Anylinux-AppImages/63759aceda3a0cb9446a4e3c2aebe3af5e5c697d/useful-tools
APPIMAGETOOL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
RUNTIME=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
VALIDATE=https://github.com/AppImageCommunity/AppImageUpdate/releases/download/2.0.0-alpha-1-20251018/validate-x86_64.AppImage
# Release signing key; its public half is docs/appimage-signing-key.asc. AppImageUpdate
# refuses an update signed with a different key, so this must never change.
SIGN_KEY=BE3C957EFD361B62483372C8BFBC8DFD37E33103

# The AppImage's desktop entry and AppStream id. Not the Tauri identifier
# (com.timeline-app-dev, which also names the data folder): AppStream needs three
# reverse-DNS parts and appimagetool fails the build on any validation warning.
ID=io.github._1sun12.timeline_app
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' src-tauri/tauri.conf.json)
TOOLS=$(mktemp -d)

# Download to a file and refuse to continue unless it matches the pinned hash.
fetch() {
	wget -qO "$TOOLS/$1" "$2"
	echo "$3  $TOOLS/$1" | sha256sum -c -
	chmod +x "$TOOLS/$1"
}

case "${1:-}" in
appdir)
	# patchelf, strace and xvfb are quick-sharun's: it runs the app briefly to find dlopened libraries.
	pacman -Syu --noconfirm --needed base-devel git wget rust nodejs npm webkit2gtk-4.1 librsvg \
		desktop-file-utils patchelf strace xorg-server-xvfb
	# Slimmed-down mesa and friends: stock mesa drags in libLLVM (+100 MiB) and quick-sharun refuses it.
	fetch get-debloated-pkgs.sh "$ANYLINUX/get-debloated-pkgs.sh" d215f7676785f1a1bb8784e69085d66c1df81488ef31f1ba7198325a5be05130
	# shortcut: the packages it installs come from that project's latest release, unpinned; pin SOURCE if they publish checksums.
	# The token only lifts the GitHub API rate limit; it reaches this one command, never npm.
	GITHUB_TOKEN="${DEBLOAT_TOKEN:-}" sh "$TOOLS/get-debloated-pkgs.sh" --add-common --prefer-nano
	unset DEBLOAT_TOKEN

	npm ci
	npx tauri build --no-bundle

	fetch quick-sharun "$ANYLINUX/quick-sharun.sh" 77392d48d845708c7787006b7d86ab73b4d022a2d4d5a4cd6887705a3c4dbbe1
	# shortcut: quick-sharun downloads sharun and its helpers itself, pinned to release tags but not hashed.

		cat > "$TOOLS/$ID.desktop" <<EOF
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
	desktop-file-validate "$TOOLS/$ID.desktop"
	cp src-tauri/icons/128x128@2x.png "$TOOLS/$ID.png"

	rm -rf AppDir
	DESKTOP="$TOOLS/$ID.desktop" ICON="$TOOLS/$ID.png" "$TOOLS/quick-sharun" src-tauri/target/release/timeline-app
	install -Dm644 "packaging/$ID.appdata.xml" "AppDir/usr/share/metainfo/$ID.appdata.xml"
	# tar keeps the symlinks and exec bits that an Actions artifact would drop.
	tar -cf AppDir.tar AppDir
	;;
pack)
	# appstream lets appimagetool validate the metainfo; a bad file fails the build.
	pacman -Syu --noconfirm --needed wget appstream desktop-file-utils gnupg
	grep -q "<release version=\"$VERSION\"" "packaging/$ID.appdata.xml" ||
		{ echo "packaging/$ID.appdata.xml has no <release> for $VERSION"; exit 1; }

	fetch appimagetool "$APPIMAGETOOL" ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
	fetch runtime "$RUNTIME" 2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d

	SIGN=""
	if [ -n "${APPIMAGE_GPG_KEY:-}" ]; then
		printf '%s\n' "$APPIMAGE_GPG_KEY" | gpg --batch --import
		SIGN="--sign --sign-key $SIGN_KEY"
	elif [ "${REQUIRE_SIGNATURE:-}" = true ]; then
		echo "APPIMAGE_GPG_KEY is not set; a release AppImage must be signed" >&2
		exit 1
	fi
	unset APPIMAGE_GPG_KEY

	rm -rf AppDir dist
	tar -xf AppDir.tar
	mkdir -p dist
	# No FUSE in containers, so run appimagetool extracted. appimagetool reads the
	# passphrase from APPIMAGETOOL_SIGN_PASSPHRASE and uses gpg's loopback pinentry.
	export ARCH=x86_64 VERSION
	# shellcheck disable=SC2086 # $SIGN is deliberately split into flags
	APPIMAGETOOL_SIGN_PASSPHRASE="${APPIMAGE_GPG_PASSPHRASE:-}" \
		"$TOOLS/appimagetool" --appimage-extract-and-run $SIGN \
		--runtime-file "$TOOLS/runtime" \
		-u "gh-releases-zsync|1sun12|timeline-app|latest|Timeline_*_amd64.AppImage.zsync" \
		AppDir "dist/Timeline_${VERSION}_amd64.AppImage"
	# appimagetool writes the .zsync where it runs, not next to the AppImage; without it
	# in the release, the update information embedded above points at nothing.
	for f in ./*.AppImage.zsync; do [ -e "$f" ] && mv "$f" dist/; done
	ls -l dist/*.AppImage dist/*.AppImage.zsync

	# Prove the signature is valid and made with the release key, not just any key.
	if [ -n "$SIGN" ]; then
		fetch validate "$VALIDATE" b10c8d39a0a917432af185afc92f1cd54b7f68aa70deda927acacf38ded84990
		"$TOOLS/validate" --appimage-extract-and-run dist/*.AppImage 2>&1 | tee "$TOOLS/validate.log"
		grep -q "validation successful" "$TOOLS/validate.log"
		grep -qi "$SIGN_KEY" "$TOOLS/validate.log"
	fi
	;;
*)
	echo "usage: $0 appdir|pack" >&2
	exit 2
	;;
esac
