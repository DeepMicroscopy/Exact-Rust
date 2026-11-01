# EXACT-Rust: server, CLI, the Python helpers and EXACT's own Python code (the registration worker and the slideio helper need it).
# Build from the repository root:   docker build -f deploy/Dockerfile -t exact-rust .
# One image, three commands: exact-server (default), `python /app/helpers/queue_worker.py ...` (registration worker), `exact-cli ...`.
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS ui
WORKDIR /src/frontend
RUN corepack enable
COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./
RUN pnpm build

FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends clang libclang-dev pkg-config libssl-dev \
      libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libswresample-dev libavfilter-dev libavdevice-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
RUN cargo build --release -p exact-server -p exact-cli

FROM python:3.11-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      libopenslide0 libavcodec59 libavformat59 libavutil57 libswscale6 libswresample4 libavfilter8 libavdevice59 \
      libgl1 libegl1 libglib2.0-0 ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*
# Python for the slideio helper (CZI, VSI, DICOM) and the registration worker / helper. slideio publishes wheels for Linux x86_64
# (and macOS), none for Linux arm64: there the image builds without it and CZI/VSI/DICOM are unavailable.
ARG QT_WSI_REGISTRATION=git+https://github.com/DeepMicroscopy/WsiRegistration.git
# (tifffile, zarr and xmltodict are pinned like EXACT's requirements.txt: its util.slide_server, which the registration worker reads slides
# through, imports zarr.core / tifffile.tifffile.ZarrTiffStore, which newer releases no longer have)
# (probreg, a dependency of qt-wsi-registration, compiles C++ on install: the compiler is removed again afterwards)
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && pip install --no-cache-dir numpy pillow opencv-python-headless openslide-python ome-types pydicom czifile \
      scikit-image scipy pandas matplotlib scikit-learn \
      tifffile==2023.2.28 zarr==2.18.7 xmltodict==0.13.0 \
    && (pip install --no-cache-dir slideio || echo "WARNING: no slideio wheel for this platform: CZI, VSI and DICOM cannot be read") \
    && pip install --no-cache-dir "${QT_WSI_REGISTRATION}" \
    && apt-get purge -y build-essential && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
# DeeperHistReg (registration plugin; PyTorch makes the image about 1 GB larger): part of the image, `--build-arg WITH_DEEPERHISTREG=0`
# leaves it out. The CPU build of torch is the default; for a GPU worker build with
# `--build-arg TORCH_INDEX=https://download.pytorch.org/whl/cu124` (about 2-3 GB more) and start it with deploy/docker-compose.gpu.yml.
ARG WITH_DEEPERHISTREG=1
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu
RUN if [ "${WITH_DEEPERHISTREG}" = "1" ]; then \
      pip install --no-cache-dir torch torchvision --index-url "${TORCH_INDEX}" \
      && pip install --no-cache-dir deeperhistreg "pyvips[binary]" SimpleITK kornia tqdm; \
    fi
# EXACT's code: the registration worker reads slides through `util.slide_server` and the helper unpickles EXACT's slide objects
ARG EXACT_REPO=https://github.com/DeepMicroscopy/Exact.git
ARG EXACT_REF=master
RUN git clone --depth 1 --branch "${EXACT_REF}" "${EXACT_REPO}" /opt/exact && rm -rf /opt/exact/.git
# the worker's slide reader must import (it did not once: zarr missing): fails the build instead of the first registration job.
# Without slideio (no wheel for arm64) EXACT's reader cannot be imported at all; that case was already announced above.
RUN if python -c "import slideio" 2>/dev/null; then cd /opt/exact/exact && python -c "import util.slide_server"; else echo "WARNING: no slideio: the registration worker cannot read slides here"; fi
COPY --from=build /src/target/release/exact-server /src/target/release/exact-cli /usr/local/bin/
COPY helpers /app/helpers
COPY --chmod=755 deploy/docker-entrypoint.sh /app/docker-entrypoint.sh
COPY baseline /app/baseline
COPY --from=ui /src/frontend/dist /app/frontend/dist
ENV EXACT_LISTEN=0.0.0.0:8002 \
    IMAGE_PATH=/data/images MEDIA_ROOT=/data/media EXACT_CACHE_DIR=/data/cache EXACT_NIFTI_CACHE=/data/cache/nifti \
    EXACT_STATIC_DIR=/app/frontend/dist \
    SLIDEIO_PYTHON=/usr/local/bin/python SLIDEIO_HELPER=/app/helpers/slideio_helper.py \
    REGISTRATION_PYTHON=/usr/local/bin/python REGISTRATION_HELPER=/app/helpers/registration_helper.py REGISTRATION_EXACT_DIR=/opt/exact/exact
RUN useradd --system --create-home --uid 1000 exact && mkdir -p /data/cache && chown -R exact /data
USER exact
WORKDIR /app
EXPOSE 8002
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:8002/timesync/ >/dev/null || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["exact-server"]
