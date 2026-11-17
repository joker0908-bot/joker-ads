# ============================================================================
# 仓库副本：服务器强制命令 /usr/local/sbin/joker-ads-ci-deploy
#
# 本文件镜像 CI 部署链在服务器上实际执行的 SSH 强制命令脚本（部署私钥
# 只被允许执行这一条命令，无交互 shell/PTY/转发）。该脚本此前只存在于
# 服务器，2026-11-17 起按原样镜像进仓库——本注释块之后为逐字节原文，
# 未经任何修改。
#
# 同步要求：任何改动必须先更新服务器 /usr/local/sbin/joker-ads-ci-deploy
# 并验证可用，再将同一版本回写本文件；仅改仓库或仅改服务器都会造成两侧
# 分叉。推送仓库本身不会替换服务器上已安装的副本。
#
# 一致性核对（tail 起始行 = 注释块行数 + 1，可用 awk '/^#!/{print NR; exit}' 自查）：
#   sed -n "$(awk '/^#!\/usr\/bin\/env/{print NR; exit}' deploy/joker-ads-ci-deploy.sh),\$p" \
#     deploy/joker-ads-ci-deploy.sh > /tmp/repo-copy
#   ssh -o BatchMode=yes allenwebads 'cat /usr/local/sbin/joker-ads-ci-deploy' > /tmp/live-copy
#   diff -u /tmp/repo-copy /tmp/live-copy   # 无输出即一致
#
# 历史蓝本见 deploy/ci-deploy-command.sh（更早入库的版本，已与线上分叉；
# 线上现行版本增加了 tarball/node_modules 复用与 codeload 下载源）。
# ============================================================================
#!/usr/bin/env bash
# Installed once as a root-owned forced SSH command. This key has no shell,
# PTY, port/agent forwarding or arbitrary deployment destination.
set -euo pipefail
revision=${SSH_ORIGINAL_COMMAND:-}
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 64
exec 9>/run/lock/joker-ads-ci-deploy.lock
flock -n 9 || exit 75
head_sha=$(git ls-remote https://github.com/0908Joker/joker-ads.git refs/heads/main | cut -f1)
test "$revision" = "$head_sha"
release="/opt/ads-king/releases/ci-$revision"
mkdir -p "$release"
if [ ! -s "$release/source.tar.gz" ]; then
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://codeload.github.com/0908Joker/joker-ads/tar.gz/$revision" --connect-timeout 20 --max-time 180 --retry 2 --retry-all-errors -o "$release/source.tar.gz"
fi
prefix=$(tar -tzf "$release/source.tar.gz" | head -1 | cut -d/ -f1) || true
[[ "$prefix" =~ ^(0908Joker-)?joker-ads-[a-f0-9]+$ ]]
tar -xzf "$release/source.tar.gz" --strip-components=1 -C "$release" \
  "$prefix/deploy" "$prefix/src" "$prefix/package.json" "$prefix/package-lock.json" \
  "$prefix/admin/lib" "$prefix/admin/public" "$prefix/admin/server.mjs" "$prefix/admin/package.json" "$prefix/admin/package-lock.json" \
  "$prefix/scripts/test-ad-sync.mjs" "$prefix/scripts/test-audit-security.mjs" "$prefix/scripts/test-audit-config.mjs" "$prefix/scripts/test-audit-runtime.mjs" "$prefix/scripts/verify-production-entry.mjs"
# Isolated compiler dependencies only; no operator configuration/database is extracted.
if [ ! -d "$release/node_modules" ]; then
npm ci --prefix "$release" --ignore-scripts --no-audit --no-fund
fi
AUDIT_BUNDLE_OUT="$release/artifact" python3 "$release/deploy/verify-bundled-production.py"
node "$release/deploy/deploy-audit-release.mjs" --deploy "$revision" "$release/artifact"
