ARG DOCKER_CLI_IMAGE=docker:24.0.6-cli@sha256:4865ba3135696b1c0e1b6bf323a5ef9402013244a69280543cf16aebc1da2b49
ARG CONTROL_IMAGE=guardrail-harness-runtime:dev
FROM ${DOCKER_CLI_IMAGE} AS docker_cli

FROM ${CONTROL_IMAGE}

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker_cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

# Die Node-/Python-Laufzeit stammt unverändert aus dem geprüften Control-Image.
# Nur dieser separate Runner erhält Docker CLI/Compose; der Socket wird erst
# durch runtime/live.compose.yaml und ausschließlich für Live-Läufe gemountet.
