# The push sender, from the repository root:
#
#   docker build -f crates/kriyon-push/Dockerfile -t kriyon-push .
#   docker run --env-file push.env -v /srv/kriyon-push:/secrets:ro -p 8080:8080 kriyon-push
#
# It speaks plain HTTP; put a TLS proxy in front (Caddy, say), and keep that
# proxy's access log off: the sender itself never sees or logs an address.
# Its secrets come in through mounted files (push.env.example) and are never
# copied into the image.

FROM rust:1.99-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p kriyon-push

FROM debian:bookworm-slim
# The system's root certificates, to reach Apple and Google over TLS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/kriyon-push /usr/local/bin/kriyon-push
USER nobody
# Inside the container, the proxy reaches it only on the container's network.
ENV KRIYON_PUSH_LISTEN=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/kriyon-push"]
