# 发布指南（macOS Developer ID 签名 + 公证）

SiDB 走 **Developer ID 直接分发**：用户从 GitHub Release / 网站下载 `.dmg`，双击直接打开，
不报「已损坏」。无需上架 App Store、无沙盒限制。

构建/签名/公证全部由 GitHub Actions（`.github/workflows/release.yml` + `tauri-action`）自动完成，
只需一次性配好 6 个 GitHub Secret，之后每次打 `v*` tag 自动出已签名+公证的包。

---

## 前提

- **付费的 Apple Developer Program**（$99/年）。免费 Apple ID 无法创建 Developer ID 证书。
- 已安装 Xcode（用于生成证书）与 GitHub CLI（`gh`，已登录目标仓库）。

---

## 一次性配置（在你的 Mac 上）

### 1. 创建 Developer ID Application 证书
Xcode → Settings → Accounts → 选 Apple ID → **Manage Certificates** → 左下 `+` →
**Developer ID Application**。

### 2. 导出为 .p12
「钥匙串访问」→ 左侧「我的证书」→ `Developer ID Application: 你的名字 (TEAMID)` →
右键 **导出** → 存成 `DeveloperID.p12`，设一个密码（记住）。

### 3. 取签名身份串与 Team ID
```bash
security find-identity -v -p codesigning
# 输出里  "Developer ID Application: 名字 (XXXXXXXXXX)"
#   整串 = SIGNING_IDENTITY；括号内 10 位 = TEAM_ID
```

### 4. 生成公证用的 App 专用密码
appleid.apple.com → 登录与安全 → **App 专用密码** → 生成（如命名 `sidb-notary`）。

### 5. 配置 6 个 GitHub Secret
> 私钥/密码等敏感信息只进 GitHub Secret，**绝不入库**。`printf '%s'` 不带换行，避免末尾混入 `\n`。

```bash
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE -R cod3vil/SiDB
printf '%s' '<p12 密码>'                              | gh secret set APPLE_CERTIFICATE_PASSWORD -R cod3vil/SiDB
printf '%s' 'Developer ID Application: 名字 (TEAMID)' | gh secret set APPLE_SIGNING_IDENTITY -R cod3vil/SiDB
printf '%s' '<你的 Apple ID 邮箱>'                    | gh secret set APPLE_ID -R cod3vil/SiDB
printf '%s' '<App 专用密码>'                          | gh secret set APPLE_PASSWORD -R cod3vil/SiDB
printf '%s' '<10 位 TEAM_ID>'                         | gh secret set APPLE_TEAM_ID -R cod3vil/SiDB
```

| Secret | 来源 |
|---|---|
| `APPLE_CERTIFICATE` | `DeveloperID.p12` 的 base64 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 .p12 时设的密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 名字 (TEAM_ID)` |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_PASSWORD` | App 专用密码（**不是** Apple ID 登录密码） |
| `APPLE_TEAM_ID` | 10 位团队 ID |

> 自动更新签名密钥 `TAURI_SIGNING_PRIVATE_KEY` 已单独配置（见下「自动更新」）。

---

## 发布一个版本

### 1. 升版本号
同步改两处的 `version`（保持一致）：
- `package.json`
- `src-tauri/tauri.conf.json`

提交并推送：
```bash
git add package.json src-tauri/tauri.conf.json
git commit -m "chore: bump version 0.1.2"
git push origin main
```

### 2. 打 tag 触发 Release 流水线
```bash
git tag v0.1.2
git push origin v0.1.2
```

流水线（`release.yml`）会在 macOS（arm + intel）、Windows 上：
- 构建安装包；
- macOS：检测到 `APPLE_*` secret → **Developer ID 签名 → 公证（notarize）→ 装订（staple）**；
- 产出已签名的 `.dmg` / `.app.tar.gz`（mac）、`.msi` / `.exe`（win）+ 更新签名 `.sig` + `latest.json`；
- 发布到一个**草稿** GitHub Release。

到 Releases 页面核对产物后，点 **Publish** 即可。

### 3. 验证（macOS）
```bash
# 下载 dmg 安装后
spctl -a -vvv /Applications/SiDB.app    # 期望: accepted, source=Notarized Developer ID
codesign -dvvv /Applications/SiDB.app    # 期望: Authority=Developer ID Application: ...
```
双击应**直接打开**，不再提示「已损坏」。

---

## 自动更新（已接入，可选发布到更新服务）

应用内更新走 `update.cyberran.com`（Tauri v2 updater，公钥已写入 `tauri.conf.json`）。
GitHub Release 本身**不等于**更新服务——发版后需把签名产物推送到更新服务，老版本才能 `check()` 到：

```bash
# 从 Release 下载产物到本地目录后
node scripts/publish.mjs \
  --manager https://update.cyberran.com \
  --app sidb \
  --version 0.1.2 \
  --notes "本次更新内容" \
  --platform darwin-aarch64=path/to/SiDB_aarch64.app.tar.gz \
  --platform darwin-x86_64=path/to/SiDB_x64.app.tar.gz \
  --platform windows-x86_64=path/to/SiDB_x64_en-US.msi \
  --token <PUBLISH_TOKEN>
```
> 注：`publish.mjs` 自动扫描只识别 `*.app.tar.gz` / `*.msi.zip` 等；v2 的 `.msi`/`.exe` 用 `--platform` 显式指定。
> 签名私钥在 `~/.tauri/sidb.key`（不入库）；CI 用 `TAURI_SIGNING_PRIVATE_KEY` secret。

---

## 备注

- 配好 secret 后，**每次打 `v*` tag** 出的包都自动签名+公证，无需再手动操作。
- 本流程仅解决 **macOS**。Windows 的「未知发布者 / SmartScreen」需单独购买 Windows 代码签名证书（OV/EV），是另一套机制。
- 升级私钥（`~/.tauri/sidb.key`）与各类 token **绝不入库、不外泄**；公证私钥一旦发布给用户不可更换。
