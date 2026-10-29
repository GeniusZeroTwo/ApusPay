#!/usr/bin/env bash
set -e

echo "=========================================="
echo "          ApusPay 服务端一键平滑更新"
echo "=========================================="

cd "$(dirname "$0")"

echo "--> [1/3] 正在拉取远程 main 分支最新代码..."
git pull origin main

# 判断部署模式并执行更新
if command -v docker >/dev/null 2>&1 && [ -f "docker-compose.yml" ] && docker compose ps >/dev/null 2>&1; then
    echo "--> [2/3] 检测到运行中的 Docker 容器，正在重新构建镜像..."
    docker compose build --pull
    echo "--> [3/3] 重新启动容器服务 (保持持久化数据)..."
    docker compose up -d --remove-orphans
    echo "--> 检查容器运行状态："
    docker compose ps
elif command -v bun >/dev/null 2>&1; then
    echo "--> [2/3] 检测到原生 Bun 环境，安装最新依赖并构建前端..."
    bun install --frozen-lockfile
    bun run build
    echo "--> [3/3] 前端构建完成！"
    if command -v pm2 >/dev/null 2>&1 && (pm2 list | grep -q "apuspay"); then
        echo "--> 正在通过 PM2 重载服务..."
        pm2 reload apuspay
    else
        echo "--> 提示: 若使用 systemctl 或后台进程运行，请执行对应重启命令，例如："
        echo "    systemctl restart apuspay 或 pm2 restart apuspay"
    fi
else
    echo "--> [提示] 代码已拉取完成，请根据您服务器的实际环境执行构建与重启。"
fi

echo "=========================================="
echo "          更新完成！数据安全保留"
echo "=========================================="
