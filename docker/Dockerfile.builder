# PINNED BY DIGEST, NOT BY TAG. `emscripten/emsdk:3.1.51` is MUTABLE -- the
# publisher can move it, and then "the same image" is not the same image. The tag
# is kept alongside the digest purely so a human can read which version this is;
# docker resolves the digest and ignores the tag.
#
# This is what lets the built image be RE-DERIVED. The ECR digest pins the
# RESULT; this pins the INPUT. Without both, a rebuild that produces a different
# artifact cannot be distinguished from a compromised one.
FROM emscripten/emsdk:3.1.51@sha256:fde95518821ccc1b629ee674a7a068a809fda47ea16814b0ed53bd646555147b

# Install build dependencies
# ninja-build: Faster build system than make
# ccache: Compiler cache to speed up rebuilds
# brotli: For compressing the final Wasm binary
# libfontconfig1-dev, pkg-config, libgraphite2-dev: LibreOffice dependencies
RUN apt-get update && apt-get install -y \
    ninja-build \
    ccache \
    brotli \
    git \
    python3 \
    libfontconfig1-dev \
    pkg-config \
    libgraphite2-dev \
    autoconf \
    gcc-12 \
    g++-12 \
    gperf \
    bison \
    flex \
    sqlite3 \
    && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-12 100 \
    && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-12 100 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure ccache environment
ENV CCACHE_DIR=/cache/ccache
ENV CCACHE_MAXSIZE=5G

# Set working directory
WORKDIR /build

