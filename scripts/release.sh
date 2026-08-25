#!/usr/bin/env bash
#
# AskTrae 插件发版脚本（方案 A：本地构建 + 手动上传 TOS）
#
# 用法:
#   ./scripts/release.sh <version> [notes]
#
# 示例:
#   ./scripts/release.sh 0.2.2 "修复 Windows 网络连接问题"
#   ./scripts/release.sh 0.3.0
#
# 前置:
#   1. 创建 .tos_base_url 文件，写入 TOS 公网基础地址，例如:
#      https://your-bucket.tos-cn-beijing.volces.com
#   2. 确保 npm、go、vsce 均可用
#
# 脚本流程:
#   1. 校验版本号格式
#   2. 检查工作区干净
#   3. 更新 package.json 的 version
#   4. 构建全平台 Go 二进制 + webview + webpack
#   5. 打包 VSIX
#   6. 生成 latest.json（含 version/url/notes）
#   7. git commit + tag
#   8. 输出手动上传 TOS 的指引
#
set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"

# ---------- 校验 ----------
if [[ -z "$VERSION" ]]; then
  echo "用法: $0 <version> [notes]"
  echo "示例: $0 0.2.2 \"修复 Windows 网络连接问题\""
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ 版本号格式错误: '$VERSION'，应为 x.y.z（如 0.2.2）"
  exit 1
fi

# 读取 TOS 基础 URL（从 .tos_base_url 文件）
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

TOS_BASE_URL="$(cat .tos_base_url 2>/dev/null || echo '')"
if [[ -z "$TOS_BASE_URL" ]]; then
  echo "⚠️  未找到 .tos_base_url 文件，latest.json 中的 URL 将使用占位符。"
  echo "   请创建 .tos_base_url 文件并写入 TOS 公网基础地址，例如:"
  echo "   https://your-bucket.tos-cn-beijing.volces.com"
  TOS_BASE_URL="https://REPLACE_ME.tos-cn-beijing.volces.com"
fi

# 去除末尾斜杠
TOS_BASE_URL="${TOS_BASE_URL%/}"

# 检查工作区干净
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ 工作区不干净，请先提交或 stash 当前改动:"
  git status --short
  exit 1
fi

echo "🚀 开始发版 v$VERSION"

# ---------- 1. 更新版本号 ----------
echo "📦 [1/5] 更新 package.json version → $VERSION ..."
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"

# ---------- 2. 构建 ----------
echo "🔨 [2/5] 构建全平台二进制 + webview + webpack ..."
npm run build-all

# ---------- 3. 打包 VSIX ----------
echo "📦 [3/5] 打包 VSIX ..."
npm run package-vsix

VSIX_FILE="asktrae-$VERSION.vsix"
if [[ ! -f "$VSIX_FILE" ]]; then
  echo "❌ VSIX 文件未生成: $VSIX_FILE"
  echo "   检查 vsce 输出，可能文件名规则有变"
  exit 1
fi

VSIX_SIZE=$(du -h "$VSIX_FILE" | cut -f1)
echo "   ✅ 生成 $VSIX_FILE ($VSIX_SIZE)"

# ---------- 4. 生成 latest.json ----------
echo "📝 [4/5] 生成 latest.json ..."
VSIX_URL="$TOS_BASE_URL/plugin/$VSIX_FILE"

# 用 node 安全地生成 JSON（处理 notes 中的特殊字符）
node -e "
const fs = require('fs');
const manifest = {
  version: process.argv[1],
  url: process.argv[2],
  notes: process.argv[3] || ''
};
fs.writeFileSync('latest.json', JSON.stringify(manifest, null, 2) + '\n');
" "$VERSION" "$VSIX_URL" "$NOTES"

echo "   ✅ latest.json 内容:"
cat latest.json

# ---------- 5. git commit + tag ----------
echo "📌 [5/5] 提交版本变更 + 打 tag ..."
git add package.json
git commit -m "chore: 发布 v$VERSION

$NOTES" >/dev/null
git tag "v$VERSION"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "🎉 发版准备完成！v$VERSION"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "下一步（手动上传 TOS）:"
echo ""
echo "  1. 上传 VSIX 到 TOS:"
echo "     $VSIX_FILE  →  $TOS_BASE_URL/plugin/$VSIX_FILE"
echo ""
echo "  2. 上传 latest.json 到 TOS:"
echo "     latest.json  →  $TOS_BASE_URL/plugin/latest.json"
echo ""
echo "  3. 推送 git 到远程:"
echo "     git push origin dev --tags"
echo ""
echo "  4. 验证 latest.json 可公网访问:"
echo "     curl $TOS_BASE_URL/plugin/latest.json"
echo ""
