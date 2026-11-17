# 品牌迁移说明

产品身份已从旧品牌改为 **菠萝视频**（拼音 boluo，Android 包名 `cn.b12sl5x.boluo`，JS 桥 `BoluoBridge` / `BoluoNative`）。旧安装的 Android 应用不再兼容，需要安装新包。下面这些位置仍会出现旧拼写，因为它们要么是归档生产包的字节锚点，要么是明确不改的运行时数据。

## 必须保留的旧字符串

这些字符串一对上归档基线。改成新品牌名后，`python3 deploy/verify-bundled-production.py` 会失败，对应脚本也不能再复现已上线的 JS 哈希。

| 位置 | 原因 |
| --- | --- |
| `deploy/patch-production-nav.py` 里两条 `label:"菠萝视频"` 锚点 | 只匹配 2026-09-29 归档的 `index-BJq_-mQY.js`。新 Vite 构建里没有这段菜单，脚本会对不上并拒绝覆盖。 |
| `deploy/migrate-production-entry.py` 与 `scripts/verify-production-entry.mjs` 中的 `boluo-hero-v11.mp4` | 反向检查归档 JS 里不应再留下旧开屏视频文件名。改掉检查字符串就不再验证这件事。 |
| `deploy/audit-frontend-stage2.mjs` 注入的 `var(--dw-surface)` / `var(--dw-cyan)` | 打进旧生产 CSS，那份样式表仍使用 `--dw-*`。源码主题已改为 `--bl-*`，不要把补丁里的变量名一起改掉。 |

`migrate-production-entry.py` 写出的下载页 `DOWN_HTML` 已经改成菠萝视频。因此再跑这个脚本时，主站 JS 哈希可以保持 `46d1d07f01e5…`，但 `main/h5/down/index.html` 不再等于 2026-09-29 的下载页字节。不要用旧下载页哈希验收这次重跑。

## 签名密钥

2026-09-29 交付包文件名为 `boluo-server-1.0.0.apk`，SHA-256 `164d986ab696f78bde7d9445648ec71469bd4c15bb348ab92c0c136db0bd5a15`。当时仓库外的密钥文件是 `boluo-release.p12`，别名 `boluo-release`，口令环境变量 `BOLUO_APK_PASSWORD`。

`scripts/sign-android.ps1` 现在只认 `boluo-release.p12`、别名 `boluo-release`、环境变量 `BOLUO_APK_PASSWORD`。旧目录不会被自动捡起。新 `applicationId` 本来就是另一份安装，请用 `-CreateKey` 新建密钥，不要把旧密钥文件改名冒充。

## 故意不改的数据

- `admin/data/live/config.json` 与 `admin/data/draft/config.json` 的 `site.name` 仍是旧品牌。这是线上/草稿配置，不随代码覆盖。前台标题现在写死为菠萝视频，不读这个字段。若还有外部读取 `site.name`，请在后台改名并保存，让已发布快照更新。不要用仓库种子覆盖 `/opt/ads-king/site-data`。
- `crawled/` 里有三处 base64 碰巧含有 `boluo` / `Boluo` 子串，不是品牌文案，没有改采集数据。

## 发布时不要误跑的脚本

`patch-production-nav.py`、`migrate-production-entry.py` 的菜单锚点只适用于旧基线。把它们对着新构建跑会在锚点检查处失败。它们也不会带上这次的 Vue 主题。`ads-king-admin.service` 的 Description 已改为菠萝视频广告后台；服务器上已安装的 unit 要另行拷贝并 `daemon-reload`，否则只是系统描述仍显示旧文案，进程本身不受影响。
