#!/bin/sh

set -ex

export DOCKER_BUILDKIT=1

VERSION="$(python -m setuptools_scm)"

for t in client exporter coordinator; do
    docker build --build-arg VERSION="$VERSION" \
        --target labgrid-${t} -t labgrid-${t} -f dockerfiles/Dockerfile .
done
