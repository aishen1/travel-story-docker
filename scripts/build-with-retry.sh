#!/bin/sh
# 构建 travel-story 镜像；BuildKit 前端 grpc 崩溃是间歇性的，自动重试。
cd /vol2/@apphome/hermes-studio/docker/travel-story || exit 1
LOG=logs/build-v14.log
: > "$LOG"
for i in 1 2 3 4 5; do
  echo "=== attempt $i  $(date +%H:%M:%S) ===" >> "$LOG"
  docker compose build >> "$LOG" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "EXIT=0 (attempt $i) $(date +%H:%M:%S)" >> "$LOG"
    exit 0
  fi
  if grep -q "frontend grpc server closed unexpectedly\|failed to run Build function" "$LOG"; then
    echo "RETRY after buildkit frontend crash (attempt $i)" >> "$LOG"
    sleep 15
    continue
  fi
  echo "EXIT=$rc 非 buildkit 崩溃，停止重试 $(date +%H:%M:%S)" >> "$LOG"
  exit "$rc"
done
echo "EXIT=1 重试 5 次仍失败" >> "$LOG"
exit 1
