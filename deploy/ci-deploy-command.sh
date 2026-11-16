#!/usr/bin/env bash
# Installed once as a root-owned forced SSH command. This key has no shell,
# PTY, port/agent forwarding or arbitrary deployment destination.
# 推送仓库不会替换服务器上已安装的副本，需要单独安装后这些错误文本才会出现在远端。
set -euo pipefail
revision=${SSH_ORIGINAL_COMMAND:-}
if ! [[ "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo "拒绝部署：修订号不是 40 位提交 SHA" >&2
  exit 64
fi
exec 9>/run/lock/joker-ads-ci-deploy.lock
if ! flock -n 9; then
  echo "拒绝部署：已有一次部署正在进行" >&2
  exit 75
fi
if ! head_sha=$(git ls-remote https://github.com/0908Joker/joker-ads.git refs/heads/main | cut -f1); then
  echo "拒绝部署：读取 main 提交号失败" >&2
  exit 1
fi
if [[ -z "$head_sha" || "$revision" != "$head_sha" ]]; then
  echo "拒绝部署：传入修订与 main 不一致，或没有读到 main 提交号" >&2
  exit 1
fi
release="/opt/ads-king/releases/ci-$revision"
mkdir -p "$release"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://api.github.com/repos/0908Joker/joker-ads/tarball/$revision" -o "$release/source.tar.gz"
prefix=$(tar -tzf "$release/source.tar.gz" | head -1 | cut -d/ -f1) || true
if ! [[ "$prefix" =~ ^0908Joker-joker-ads-[a-f0-9]+$ ]]; then
  echo "拒绝部署：源码包顶层目录名不符合预期" >&2
  exit 1
fi
tar -xzf "$release/source.tar.gz" --strip-components=1 -C "$release" \
  "$prefix/deploy" "$prefix/src" "$prefix/package.json" "$prefix/package-lock.json" \
  "$prefix/admin/lib" "$prefix/admin/public" "$prefix/admin/server.mjs" "$prefix/admin/package.json" "$prefix/admin/package-lock.json" \
  "$prefix/scripts/test-ad-sync.mjs" "$prefix/scripts/test-audit-security.mjs" "$prefix/scripts/test-audit-config.mjs" "$prefix/scripts/test-audit-runtime.mjs" "$prefix/scripts/verify-production-entry.mjs"
# Isolated compiler dependencies only; no operator configuration/database is extracted.
npm ci --prefix "$release" --ignore-scripts --no-audit --no-fund
AUDIT_BUNDLE_OUT="$release/artifact" python3 "$release/deploy/verify-bundled-production.py"
node "$release/deploy/deploy-audit-release.mjs" --deploy "$revision" "$release/artifact"
