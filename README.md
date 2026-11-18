# OpenClaw 2026.10.5 — community patch collection

這是 OpenClaw `2026.10.5` 的完整社群修補合集，涵蓋 `a02d409` 既有修補，以及後續的 Codex 啟動、啟動期間停止、唯讀狀態修補。**這不是官方發行版，也不是新的完整核心安裝包。**

A source-first collection of four patch families, their regression-test sources, and the exact deployed Codex plugin package. No operational configuration, credentials, conversation data, or production logs are included.

## 收錄範圍

1. **Subagent lifecycle / delivery — 23 個檔案**
   - 從官方基底到 `a02d409` 的既有修補，包含子代理收尾身分、通知與喚醒、peer follow-up 收尾、read-only worker 準備及相關執行／測試修補。
   - 既有公開來源：[openclaw-subagent-fixes](https://github.com/ladylikegroup-oss/openclaw-subagent-fixes)。本合集保留其程式碼內容，不攜帶本機 Git 歷史或私人作者資料。
2. **Codex startup containment — 3 個檔案**
   - 將特定 app-server 啟動逾時分類為 harness 層級 preflight failure，避免再選擇同一個故障 harness 的備援候選。
   - 保留原始 cause、caller cancellation 的優先權，加入啟動階段與 acquire 邊界診斷。
   - **這是失敗處理與診斷修補，不是首次啟動卡住的已證實根治。**
3. **Stop during startup — 3 個檔案**
   - 核心在工作啟動期間的取消／停止處理及回歸測試。
   - **僅發佈原始碼；尚未部署到保留的 `a02d409` 核心。**
4. **Read-only status — 3 個檔案**
   - 補回唯讀狀態查詢不應寫入狀態的保護及回歸測試。
   - 是現場保留的唯讀防護之來源版本；不表示已建出並安裝整合後的核心套件。

共 **32 個變更檔案**。四類的檔案聯集已與完整 Git 差異比對，沒有省略測試路由檔案。

## 檔案配置

- `patches/series`：四個依序套用的補丁名稱。
- `patches/0001-*.patch` 至 `0004-*.patch`：各修補類別的完整 Git diff。
- `patches/all-from-official.patch`：從官方基底一次套用全部修補的合併 diff；**不要再與四段補丁重複套用**。
- `source/`：上述 32 個檔案在最終來源版本的完整快照；不是獨立可建置的完整 OpenClaw 原始碼樹。
- `manifest.json`：基底、來源版本、每個補丁與來源檔案的 SHA-256，以及套件資訊。
- `verification/patch-application.json`：本次實際執行的離線套用與 Git tree 驗證結果。
- `VALIDATION.md`：驗證範圍、部署狀態及未完成事項。
- GitHub Release：完整來源修補包、精確 Codex `.tgz`、授權檔與 `SHA256SUMS`。

## 精確基底

- 官方 OpenClaw `v2026.10.5` 基底：`1b58cb9a1b4f4353e1add63c8506db4d890962e8`
- 既有核心修補版本：`a02d409a4c751ecd83239ed71aae948d1c868bcd`
- Codex / Stop 來源版本：`1e8c96e4053e4673fecf1af5468e7dd12361aea5`
- 合集最終來源版本：`964c4c5d993f4cecc6114c2bf8f6ead5d38ba763`
- 最終來源 Git tree：`6dbd86ebfb30a8f064c35b850a2e6a0d4f66d11a`

以上來源 commit 用於內容追溯；不宣稱它們全部可直接從官方遠端取得。以補丁內容、固定官方基底和驗證過的 tree 為重建依據。

## Apply to a clean source checkout

Obtain the complete upstream source from [openclaw/openclaw](https://github.com/openclaw/openclaw), check out the exact official base above, and confirm the working tree is clean. Set `PATCH_ROOT` to this collection's directory.

```sh
git rev-parse HEAD
git status --short
git apply --check "$PATCH_ROOT/patches/all-from-official.patch"
git apply "$PATCH_ROOT/patches/all-from-official.patch"
```

For a clean source checkout that is already exactly at `a02d409a4c751ecd83239ed71aae948d1c868bcd`, skip patch 0001 and apply 0002, 0003, then 0004, checking each patch immediately before applying it. Do not use a wildcard that also includes the combined patch.

These are **source patches**, not instructions to overwrite a running `dist/` or `node_modules/` directory. Run the upstream project's required tests and canonical build/package process before installing a new core. This publication does not include an automatic core installer.

## Codex plugin download

Release asset: `openclaw-codex-2026.10.5.tgz`

```text
8266ac10565572cf0f438b1a0f126dd451b4b4f8455b489e3374eca5749cd583
```

This is the byte-for-byte package that was hot-applied and followed by two successful operator-origin reply/continuation checks on 2026-11-17. Its version string remains `2026.10.5`; identify this repair by the digest, not by the version alone. Runtime dependencies are not bundled into this tarball.

Use the installed host's supported managed-plugin lifecycle, verify host/SDK compatibility, and retain an appropriate rollback point. Review the source and capabilities before installing. A hot replacement avoids a required whole-Gateway restart, but can wait for admitted work and is **not a zero-interruption guarantee**. Do not use an older combined-core installer for this plugin-only package.

## 限制與授權

- 沒有發佈先前失敗或缺少整合修補的核心二進位包；其產品修補已完整以原始碼收錄。
- 本次已重新驗證補丁套用與內容一致性，**沒有重新跑完整產品測試或完整核心建置**。
- 沒有為驗證而在正式環境故意製造啟動逾時，也不宣稱首次卡住原因已根治。
- 未包含本機 installer、維運控制框架、私有操作收據、設定、對話、日誌、資料庫、憑證或任何公司業務資料。
- MIT。保留原版 `LICENSE` 的 OpenClaw Foundation 著作權與授權通知；詳見 `NOTICE.md`。
