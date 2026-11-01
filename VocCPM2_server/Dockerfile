# VoxCPM2 TTS HTTP サーバ(llama.cpp-omni の `llama-tts-server`)。CPU 専用。
# ローカルでビルドするため、GGML_NATIVE によりバイナリはビルドしたマシンの CPU 向けに最適化される
# (古い CPU のマシンへイメージをコピーしないこと)。
FROM ubuntu:24.04 AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src

# server.patch の作成時にソースを読んだリビジョンに固定する。
ARG LLAMA_OMNI_REV=d30f00feadb7ebce95bacd55b0d104e3ef501481
RUN git init -q . && git remote add origin https://github.com/tc-mb/llama.cpp-omni.git \
    && git fetch -q --depth 1 origin "$LLAMA_OMNI_REV" && git checkout -q FETCH_HEAD \
    && echo "$LLAMA_OMNI_REV" > /src/REVISION

# 生成処理を HTTP スレッド間で直列化し、max_steps の既定値を 200 → 4096 に引き上げる(詳細は README)。
COPY server.patch /tmp/server.patch
RUN git apply --whitespace=nowarn /tmp/server.patch

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DGGML_CUDA=OFF -DGGML_METAL=OFF \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF \
    && cmake --build build --target llama-tts-server -j"$(nproc)"

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/ /opt/voxcpm2/bin/
COPY --from=build /src/REVISION /opt/voxcpm2/REVISION
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
# Windows の改行コード(CRLF)でチェックアウト・編集された場合に備えて CR を除去する
RUN sed -i 's/\r$//' /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh
ENV LD_LIBRARY_PATH=/opt/voxcpm2/bin \
    MODELS_DIR=/models \
    BASELM_FILE=VoxCPM2-BaseLM-Q8_0.gguf \
    ACOUSTIC_FILE=VoxCPM2-Acoustic-F16.gguf \
    THREADS=8 \
    HTTP_THREADS=1 \
    PORT=8080
EXPOSE 8080
# HTTP ワーカーは 1 スレッドのため(README 参照)、合成中は /health が待たされる。
# そこで HTTP ではなく、ポートが接続を受け付けるかで判定する(ワーカー処理中もカーネルは接続を受け付ける)。
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD bash -c "exec 3<>/dev/tcp/127.0.0.1/${PORT}" || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
