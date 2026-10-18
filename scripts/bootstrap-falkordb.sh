#!/usr/bin/env bash
# bootstrap-falkordb.sh — vendor a portable Redis 8 so the embedded
# FalkorDB engine (FalkorDBLite) can run with NO root and NO docker.
#
# Idempotent. Targets x86_64 glibc systems (Debian/Ubuntu userlands
# and compatible sandboxes). macOS/arm64/docker desktops should simply
# use: docker run -p 6379:6379 falkordb/falkordb:latest
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=.data/bin/r8/usr/bin/redis-server
if [ -x "$BIN" ] && "$BIN" --version | grep -q "v=8"; then
  echo "[ok] portable redis 8 already vendored: $BIN"
  exit 0
fi

if [ "$(uname -m)" != "x86_64" ]; then
  echo "[skip] portable bootstrap is x86_64-only — run the docker server instead:"
  echo "       docker run -p 6379:6379 falkordb/falkordb:latest"
  exit 1
fi

POOL=http://deb.debian.org/debian/pool/main
WORK=.data/bin
mkdir -p "$WORK"
cd "$WORK"

get () { curl -fsSL -O "$1" && echo "  fetched $(basename "$1")"; }

latest () { # latest deb in a pool dir matching a package prefix
  curl -fsSL "$1" | grep -o "$2_[^\"]*_amd64\.deb" | sort -u | tail -1
}

echo "[1/4] redis-tools 8 + patchelf"
TSRV=$POOL/r/redis/redis-tools_8.0.2-3+deb13u3_amd64.deb
get "$TSRV"
get "$POOL/p/patchelf/patchelf_0.14.3-1+b1_amd64.deb" || get "$POOL/p/patchelf/patchelf_0.14.3-1%2Bb1_amd64.deb" || true

echo "[2/4] trixie runtime libs (no root required)"
get "$POOL/g/glibc/libc6_2.41-12+deb13u4_amd64.deb"
get "$POOL/j/jemalloc/libjemalloc2_5.3.0-3_amd64.deb"
get "$POOL/libl/liblzf/liblzf1_3.6-4+b4_amd64.deb"
get "$POOL/o/openssl/libssl3t64_3.5.7-1~deb13u3_amd64.deb"
get "$POOL/s/systemd/libsystemd0_257.13-1~deb13u1_amd64.deb"
get "$POOL/g/gcc-14/libstdc++6_14.2.0-19_amd64.deb"
get "$POOL/g/gcc-14/libatomic1_14.2.0-19_amd64.deb"
get "$POOL/g/gcc-14/libgcc-s1_14.2.0-19_amd64.deb"

echo "[3/4] extract"
mkdir -p r8 pce
for f in *.deb; do
  case "$f" in
    patchelf*) dpkg-deb -x "$f" ./pce ;;
    *)         dpkg-deb -x "$f" ./r8  ;;
  esac
done

echo "[4/4] self-contain: interpreter + rpath"
PATCHELF=$(find pce -name patchelf -type f | head -1)
[ -L r8/usr/bin/redis-server ] || ln -sf redis-check-rdb r8/usr/bin/redis-server
"$PATCHELF" \
  --set-interpreter "$OLDPWD/$WORK/r8/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" \
  --set-rpath '$ORIGIN/../lib/x86_64-linux-gnu' \
  r8/usr/bin/redis-check-rdb

r8/usr/bin/redis-server --version
# slim: packaging artifacts are no longer needed once extracted
rm -f ./*.deb && rm -rf ./pce
echo "[done] portable redis 8 → $WORK/r8/usr/bin/redis-server"
echo "The desk auto-detects it on next probe. Node package 'falkordblite' handles the module itself."
