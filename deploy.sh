#!/bin/bash
# deploy.sh — Пуш в Git + обновление на VPS одной командой
# Использование: bash deploy.sh "описание изменений"

VPS_HOST="root@5.42.107.133"
APP_DIR="/opt/telegram-broadcast"
PM2_NAME="broadcast"

# Цвета
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

MSG="${1:-Обновление}"

echo -e "${CYAN}=== Deploy ===${NC}"

# 1. Коммит и пуш
echo -e "${CYAN}[1/2] Git push...${NC}"
git add -A
git diff --cached --quiet 2>/dev/null
if [ $? -eq 0 ]; then
  echo "  Нет изменений для коммита, пушим текущее состояние..."
  git push origin main 2>&1 || { echo -e "${RED}Git push failed${NC}"; exit 1; }
else
  git commit -m "$MSG" || { echo -e "${RED}Commit failed${NC}"; exit 1; }
  git push origin main 2>&1 || { echo -e "${RED}Git push failed${NC}"; exit 1; }
fi
echo -e "  ${GREEN}OK${NC}"

# 2. Обновление на VPS
echo -e "${CYAN}[2/2] VPS: git pull + pm2 restart...${NC}"
ssh -o ConnectTimeout=10 "$VPS_HOST" "cd $APP_DIR && git pull origin main && pm2 restart $PM2_NAME" 2>&1
if [ $? -eq 0 ]; then
  echo -e "  ${GREEN}OK${NC}"
else
  echo -e "  ${RED}VPS update failed${NC}"
  exit 1
fi

echo ""
echo -e "${GREEN}Deploy done!${NC}"
