#!/usr/bin/env bash
set -euo pipefail

version="1.32.0"
cache_root="${OASDIFF_CACHE_DIR:-.tools/oasdiff}"
binary_dir="${cache_root}/v${version}"
binary="${binary_dir}/oasdiff"

if [[ ! -x "${binary}" ]]; then
  platform="$(uname -s)"
  machine="$(uname -m)"

  case "${platform}/${machine}" in
    Darwin/*)
      asset="oasdiff_${version}_darwin_all.tar.gz"
      expected_sha256="a014c7984dd80ea91b9ef55fffca64eed122fcbc7d3a9341bbe3769e36942c3a"
      ;;
    Linux/x86_64|Linux/amd64)
      asset="oasdiff_${version}_linux_amd64.tar.gz"
      expected_sha256="5b2050787cfee2a9a3ba7b25cb50fe2c5cc45cdf5b96fbc51a4a60107f8b4aad"
      ;;
    Linux/aarch64|Linux/arm64)
      asset="oasdiff_${version}_linux_arm64.tar.gz"
      expected_sha256="a9f01dda27c1789b012faa3991c44f99d2e7c4cca3329617d9e7fcd8de52d41e"
      ;;
    *)
      echo "Unsupported oasdiff platform: ${platform}/${machine}" >&2
      exit 1
      ;;
  esac

  url="https://github.com/oasdiff/oasdiff/releases/download/v${version}/${asset}"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT
  archive="${tmp_dir}/${asset}"

  curl -fsSL "${url}" -o "${archive}"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "${archive}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_sha256="$(shasum -a 256 "${archive}" | awk '{print $1}')"
  else
    echo "sha256sum or shasum is required to verify oasdiff" >&2
    exit 1
  fi

  if [[ "${actual_sha256}" != "${expected_sha256}" ]]; then
    echo "oasdiff checksum mismatch for ${asset}" >&2
    echo "expected: ${expected_sha256}" >&2
    echo "actual:   ${actual_sha256}" >&2
    exit 1
  fi

  tar -xzf "${archive}" -C "${tmp_dir}"
  candidate="$(find "${tmp_dir}" -type f -name oasdiff -print -quit)"
  if [[ -z "${candidate}" ]]; then
    echo "oasdiff binary was not found in ${asset}" >&2
    exit 1
  fi

  mkdir -p "${binary_dir}"
  install -m 0755 "${candidate}" "${binary}.tmp"
  mv "${binary}.tmp" "${binary}"
fi

exec "${binary}" "$@"
