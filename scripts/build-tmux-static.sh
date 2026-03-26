#!/bin/bash
# 静态编译 tmux for macOS (x64 + arm64)
# 依赖: libevent, ncurses, tmux 源码
# 产物: server/bin/darwin/tmux-x64, server/bin/darwin/tmux-arm64

set -e

TMUX_VERSION="3.5a"
LIBEVENT_VERSION="2.1.12-stable"
NCURSES_VERSION="6.5"
MIN_MACOS="11.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/.build-tmux"
OUTPUT_DIR="$PROJECT_DIR/server/bin/darwin"

mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

# 下载源码
download_sources() {
  cd "$BUILD_DIR"
  [ -f "libevent-${LIBEVENT_VERSION}.tar.gz" ] || \
    curl -sLO "https://github.com/libevent/libevent/releases/download/release-${LIBEVENT_VERSION}/libevent-${LIBEVENT_VERSION}.tar.gz"
  [ -f "ncurses-${NCURSES_VERSION}.tar.gz" ] || \
    curl -sLO "https://ftp.gnu.org/gnu/ncurses/ncurses-${NCURSES_VERSION}.tar.gz"
  [ -f "tmux-${TMUX_VERSION}.tar.gz" ] || \
    curl -sLO "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz"
}

# 编译指定架构
# $1 = arch (x86_64 | arm64)
build_arch() {
  local ARCH="$1"
  local ARCH_LABEL="$2"  # x64 | arm64
  local PREFIX="$BUILD_DIR/install-${ARCH_LABEL}"
  local SDK=$(xcrun --sdk macosx --show-sdk-path)
  # config.sub 需要 aarch64 而非 arm64
  local HOST_TRIPLE="${ARCH}-apple-darwin"
  [ "$ARCH" = "arm64" ] && HOST_TRIPLE="aarch64-apple-darwin"

  echo "=== 编译 ${ARCH_LABEL} (${ARCH}) ==="
  rm -rf "$PREFIX"
  mkdir -p "$PREFIX"

  local CFLAGS="-arch ${ARCH} -mmacosx-version-min=${MIN_MACOS} -isysroot ${SDK}"
  local LDFLAGS="-arch ${ARCH} -mmacosx-version-min=${MIN_MACOS} -isysroot ${SDK}"
  local CC="clang -arch ${ARCH}"

  # --- libevent ---
  echo "  -> libevent"
  cd "$BUILD_DIR"
  rm -rf "libevent-${LIBEVENT_VERSION}"
  tar xzf "libevent-${LIBEVENT_VERSION}.tar.gz"
  cd "libevent-${LIBEVENT_VERSION}"
  ./configure --host="$HOST_TRIPLE" --prefix="$PREFIX" \
    --disable-shared --enable-static --disable-openssl --disable-samples \
    CC="$CC" CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" > /dev/null 2>&1
  make -j$(sysctl -n hw.ncpu) > /dev/null 2>&1
  make install > /dev/null 2>&1

  # --- ncurses ---
  echo "  -> ncurses"
  cd "$BUILD_DIR"
  rm -rf "ncurses-${NCURSES_VERSION}"
  tar xzf "ncurses-${NCURSES_VERSION}.tar.gz"
  cd "ncurses-${NCURSES_VERSION}"
  ./configure --host="$HOST_TRIPLE" --prefix="$PREFIX" \
    --without-shared --with-normal --without-debug --without-ada \
    --without-cxx --without-cxx-binding --without-tests --without-progs \
    --enable-widec --with-default-terminfo-dir=/usr/share/terminfo \
    --datadir="$PREFIX/share" \
    CC="$CC" CFLAGS="$CFLAGS" LDFLAGS="$LDFLAGS" > /dev/null 2>&1
  make -j$(sysctl -n hw.ncpu) > /dev/null 2>&1
  make install.libs install.includes > /dev/null 2>&1

  # --- tmux ---
  echo "  -> tmux"
  cd "$BUILD_DIR"
  rm -rf "tmux-${TMUX_VERSION}"
  tar xzf "tmux-${TMUX_VERSION}.tar.gz"
  cd "tmux-${TMUX_VERSION}"
  PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" \
  ./configure --host="$HOST_TRIPLE" --prefix="$PREFIX" \
    --disable-utf8proc \
    CC="$CC" \
    CFLAGS="$CFLAGS -I${PREFIX}/include -I${PREFIX}/include/ncursesw" \
    LDFLAGS="$LDFLAGS -L${PREFIX}/lib" \
    LIBEVENT_CFLAGS="-I${PREFIX}/include" \
    LIBEVENT_LIBS="${PREFIX}/lib/libevent.a" \
    LIBNCURSES_CFLAGS="-I${PREFIX}/include/ncursesw" \
    LIBNCURSES_LIBS="${PREFIX}/lib/libncursesw.a" \
    > /dev/null 2>&1
  make -j$(sysctl -n hw.ncpu) > /dev/null 2>&1

  cp tmux "$OUTPUT_DIR/tmux-${ARCH_LABEL}"
  strip "$OUTPUT_DIR/tmux-${ARCH_LABEL}"
  echo "  -> 产物: server/bin/darwin/tmux-${ARCH_LABEL}"
}

echo "下载源码..."
download_sources

build_arch "x86_64" "x64"
build_arch "arm64" "arm64"

echo ""
echo "=== 编译完成 ==="
ls -lh "$OUTPUT_DIR"/tmux-*
file "$OUTPUT_DIR"/tmux-*

echo ""
echo "清理编译目录..."
rm -rf "$BUILD_DIR"
echo "完成！"
