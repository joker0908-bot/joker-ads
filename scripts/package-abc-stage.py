"""从已经核实的审计产物生成 ABC 暂存包。"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
ADMIN_ENTRIES = {
    "admin/server.mjs",
    "admin/public/admin.js",
    "admin/public/index.html",
    "admin/public/admin.css",
}
PAYMENT_ENTRY = "deploy/najin-pay-bff.mjs"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    return (json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def git_blob(path):
    # 从已提交对象取字节，排除 checkout 中的本地数据和配置。
    return subprocess.check_output(["git", "show", "HEAD:" + path], cwd=ROOT)


def collect_files(bundle):
    manifest = json.loads((bundle / "manifest.json").read_bytes())
    frontend_name = manifest["frontend"]
    if not re.fullmatch(r"index-audit-\d+-[0-9a-f]{12}\.js", frontend_name):
        raise ValueError("前端产物名不符合审计包格式")
    frontend = (bundle / frontend_name).read_bytes()
    if sha256(frontend) != manifest["frontendSha256"]:
        raise ValueError("前端产物与审计哈希不符")

    files = {f"components/frontend/{frontend_name}": frontend}
    seen = set()
    for entry in manifest["files"]:
        source = entry["source"]
        if source in seen:
            raise ValueError(f"审计清单重复文件 {source}")
        seen.add(source)
        if source == PAYMENT_ENTRY:
            target = "components/payment/najin-pay-bff.mjs"
        elif source in ADMIN_ENTRIES or re.fullmatch(r"admin/lib/[a-zA-Z0-9_-]+\.mjs", source):
            target = "components/" + source
        else:
            raise ValueError(f"审计清单存在未允许的文件 {source}")
        data = git_blob(source).replace(b"\r\n", b"\n")
        if sha256(data) != entry["sha256"]:
            raise ValueError(f"源码与审计哈希不符 {source}")
        files[target] = data
    if not ADMIN_ENTRIES.union({PAYMENT_ENTRY}).issubset(seen):
        raise ValueError("审计清单缺少后台或支付服务代码")

    for path in ("admin/package.json", "admin/package-lock.json"):
        files["components/" + path] = git_blob(path)
    return files


def write_archive(archive_path, files):
    with tarfile.open(archive_path, "x:gz") as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))

    with tarfile.open(archive_path, "r:gz") as archive:
        actual = [member.name for member in archive.getmembers() if member.isfile()]
        if len(archive.getmembers()) != len(files) or sorted(actual) != sorted(files):
            raise ValueError("归档文件清单校验失败")
        for name, data in files.items():
            with archive.extractfile(name) as packed:
                if sha256(packed.read()) != sha256(data):
                    raise ValueError(f"归档内容校验失败 {name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha) or args.sha != head:
        raise ValueError("预期 SHA 与当前检出不一致")
    files = collect_files(args.bundle)
    files["manifest.json"] = json_bytes({
        "schema": 1,
        "repository": "joker0908-bot/joker-ads",
        "repository_id": 1327907600,
        "revision": head,
        "stage_only": True,
        "sha256": {name: sha256(data) for name, data in files.items()},
    })
    args.output.mkdir(parents=True, exist_ok=False)
    archive_path = args.output / f"joker-ads-stage-{head}.tar.gz"
    write_archive(archive_path, files)
    digest = sha256(archive_path.read_bytes())
    archive_path.with_name("SHA256SUMS").write_text(
        f"{digest}  {archive_path.name}\n", encoding="ascii", newline="\n",
    )
    print(f"{head} 暂存包已核对 {len(files) - 1} 个文件，归档 SHA-256 {digest}")


if __name__ == "__main__":
    main()
