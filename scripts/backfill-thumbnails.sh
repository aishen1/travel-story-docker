#!/bin/sh
# ============================================================
# 为存量素材补生成缩略图
#
# v2 之前的版本上传素材时不生成缩略图，规划页会直接拉原图（手机照片
# 动辄 2~5MB、视频上百 MB）。这个脚本按上传时的同一套规则补一遍：
# 长边 1280 的 JPEG，视频取第 1 秒的帧（取不到就退回首帧）。
#
# 用法（在宿主机执行，容器已在跑）：
#   cp scripts/backfill-thumbnails.sh data/
#   docker exec travel-story sh /app/data/backfill-thumbnails.sh
#
# 幂等：已有 <id>-thumb.jpg 的会跳过，可反复跑。
# ============================================================
set -u
MEDIA=${MEDIA:-/app/data/media}
cd "$MEDIA" || { echo "找不到 $MEDIA"; exit 1; }

done_n=0
skip_n=0
total=$(ls -1 | grep -vc -- '-thumb\.jpg$')

for f in *; do
  case "$f" in
    *.json | *.tmp | *-thumb.jpg) continue ;;
  esac
  [ -f "$f-thumb.jpg" ] && continue

  # 视频先试第 1 秒的帧；图片直接取首帧。
  # 注意：单张图片喂 `-ss 1` 时 ffmpeg 会「返回 0 但一帧都没写出」，
  # 所以判断成功必须看输出文件是否有内容，不能只看退出码。
  gen() {
    ffmpeg -y -v error $1 -i "$f" -vf "scale='min(1280,iw)':-2" \
      -frames:v 1 -q:v 5 "$f-thumb.jpg" 2>/dev/null
    [ -s "$f-thumb.jpg" ]
  }
  if gen "-ss 1" || gen ""; then
    done_n=$((done_n + 1))
    printf '  ✓ %s\n' "$f"
  else
    rm -f "$f-thumb.jpg"
    printf '  ✗ 跳过（ffmpeg 解不了）：%s\n' "$f"
    skip_n=$((skip_n + 1))
  fi
done

echo "--------------------------------------------"
echo "补生成 $done_n 个缩略图，跳过 $skip_n 个（素材总数约 $total）"
