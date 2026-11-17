<!-- cr7-lang -->
## 语言规范（CR7 统一要求）

所有 AI Agent 在本仓的产出必须使用简体中文：

- PR/Issue 标题与正文、Review 评论、讨论回复
- Commit message
- 代码内新增注释（既有外文注释不强制改）

技术术语可保留英文原词（CI/CD、idempotent 等），句体必须为中文。

## 审计修复约定

- 禁止在 URL query 传递凭据：身份卡 token 走 `X-Card-Token`/`Authorization` 头或 `dw_card` cookie，API key 走 `x-api-key`/`Authorization` 头；不得新增 `?token=`/`?key=`（`/dewu-api/` 遗留前缀除外）。
- `VIDEO_URL_SECRET` 生产必备：缺失时签名/验签 fail closed，`ALLOW_DEV_UNSIGNED=1` 只准本地与测试使用。
- `/pay-bff/notify` 必须验签后再转发 `/api/internal/pay/credit` 入账；`/data/` 公开白名单不含 `api-session.json`。
