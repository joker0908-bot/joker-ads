#!/usr/bin/env bash
# 用受限密钥调用服务器上的强制命令。失败时只打印分类，不打印密钥、主机或地址。
set -euo pipefail
umask 077
dir="${RUNNER_TEMP:-/tmp}/ad-sync-ssh"
mkdir -p "$dir"
key="$dir/id_ed25519"
known="$dir/known_hosts"
printf '%s\n' "${DEPLOY_KEY:-}" > "$key"
printf '%s\n' "${DEPLOY_KNOWN_HOSTS:-}" > "$known"
chmod 600 "$key" "$known"

say() { printf '%s\n' "$1" >&2; }

[[ -n "${DEPLOY_KEY:-}" ]] || { say "部署 SSH 失败：密钥为空"; exit 1; }
[[ -n "${DEPLOY_KNOWN_HOSTS:-}" ]] || { say "部署 SSH 失败：known_hosts 为空"; exit 1; }
[[ -s "$key" ]] || { say "部署 SSH 失败：密钥文件为空"; exit 1; }
[[ -s "$known" ]] || { say "部署 SSH 失败：known_hosts 文件为空"; exit 1; }
grep -q 'BEGIN .*PRIVATE KEY' "$key" || { say "部署 SSH 失败：密钥内容不是私钥"; exit 1; }
command -v ssh >/dev/null 2>&1 || { say "部署 SSH 失败：运行器没有 ssh 客户端"; exit 1; }
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || { say "部署 SSH 失败：修订号不是 40 位提交 SHA"; exit 1; }

# 地址只留在脚本里，避免工作流步骤回显。
host='107.149.129.35'
port=32356
err="$dir/stderr"
out="$dir/stdout"
set +e
ssh -i "$key" -p "$port" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known" \
  -o GlobalKnownHostsFile=/dev/null \
  -o ConnectTimeout=20 -o ServerAliveInterval=15 \
  -o LogLevel=ERROR \
  "root@${host}" "$GITHUB_SHA" >"$out" 2>"$err"
code=$?
set -e
python3 - "$code" "$err" "$out" << 'PY'
import re, sys
code = int(sys.argv[1])
err = open(sys.argv[2], errors="replace").read()
out = open(sys.argv[3], errors="replace").read()
if code == 0:
    sys.exit(0)
text = err + "\n" + out
def has(pat):
    return re.search(pat, text, re.I) is not None
if has(r"command not found"):
    msg = "运行器没有 ssh 客户端"
elif has(r"invalid format|error in libcrypto|Load key|UNPROTECTED PRIVATE KEY|bad permissions"):
    msg = "私钥无法加载（格式或文件权限）"
elif has(r"Could not resolve|Name or service not known|Temporary failure in name resolution"):
    msg = "主机名无法解析"
elif has(r"timed out|Operation timed out"):
    msg = "连接超时。自建 runner 到部署端口没有连通；2026-10-07 成功的那次走的是 GitHub 托管 runner"
elif has(r"Connection refused|Connection reset"):
    msg = "连接被拒绝或中途重置"
elif has(r"Host key verification failed|REMOTE HOST IDENTIFICATION|No .+ host key is known"):
    msg = "主机密钥与 known_hosts 不一致"
elif has(r"Permission denied|Authentication failed|Too many authentication"):
    msg = "公钥认证被拒绝"
elif not text.strip():
    msg = ("远端强制命令以状态 %d 退出，且没有输出。"
           "服务器上的脚本在 set -e 下用 test 比对 main 的提交号，不一致时原来不打印原因。"
           "大约 4 秒返回多半是这条；大约 40 秒且无输出，则是两次地址族连接超时被客户端吞掉") % code
else:
    msg = "未分类的客户端或远端错误，退出码 %d" % code
print("部署 SSH 失败：" + msg, file=sys.stderr)
sys.exit(code if code else 1)
PY
