#!/bin/bash
# ============================================================
# migrate-vps.sh — Миграция telegram-broadcast на новый VPS
# Использование: запускать на НОВОМ VPS от root
#   bash migrate-vps.sh
#
# Что делает:
# 1. Устанавливает Node.js 20, PM2, Nginx, Certbot
# 2. Клонирует репозиторий
# 3. Копирует базу данных и файлы с СТАРОГО VPS
# 4. Настраивает .env для мультитенантной версии
# 5. Получает SSL-сертификат
# 6. Запускает приложение
# ============================================================

set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

safe_read() {
  local varname="$1"
  local input
  IFS= read -r input
  input=$(printf '%s' "$input" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  eval "$varname=\"\$input\""
}

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║  Telegram Broadcast — Миграция на новый VPS  ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# Проверка root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Запустите от root: sudo bash migrate-vps.sh${NC}"
  exit 1
fi

# ============================================
# 1. Параметры
# ============================================
echo -e "${YELLOW}=== Параметры миграции ===${NC}"

printf "Домен (broadcast.leadtehsms.ru): "
safe_read DOMAIN
DOMAIN=${DOMAIN:-broadcast.leadtehsms.ru}

printf "PLATFORM_BOT_TOKEN: "
safe_read PLATFORM_BOT_TOKEN
if [ -z "$PLATFORM_BOT_TOKEN" ]; then
  echo -e "${RED}PLATFORM_BOT_TOKEN обязателен${NC}"
  exit 1
fi

printf "SUPER_ADMIN_ID (Telegram ID): "
safe_read SUPER_ADMIN_ID
if [ -z "$SUPER_ADMIN_ID" ]; then
  echo -e "${RED}SUPER_ADMIN_ID обязателен${NC}"
  exit 1
fi

printf "IP старого VPS для копирования данных (пустое = пропустить): "
safe_read OLD_VPS_IP

CRON_SECRET=$(openssl rand -hex 16)
APP_PORT=3000
APP_DIR="/opt/telegram-broadcast"
REPO_URL="https://github.com/Roman72-186/telegram-broadcast.git"

echo ""
echo -e "${CYAN}  Домен:       ${DOMAIN}${NC}"
echo -e "${CYAN}  Порт:        ${APP_PORT}${NC}"
echo -e "${CYAN}  Старый VPS:  ${OLD_VPS_IP:-пропущен}${NC}"
echo ""
printf "Продолжить? (y/n): "
safe_read CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Отменено."
  exit 0
fi

# ============================================
# 2. Обновление системы
# ============================================
echo ""
echo -e "${YELLOW}[1/8] Обновление системы...${NC}"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git ufw nginx certbot python3-certbot-nginx sshpass

# ============================================
# 3. Установка Node.js 20
# ============================================
echo -e "${YELLOW}[2/8] Установка Node.js 20...${NC}"
if ! command -v node &>/dev/null || [ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node.js: $(node -v), npm: $(npm -v)"

# ============================================
# 4. Установка PM2
# ============================================
echo -e "${YELLOW}[3/8] Установка PM2...${NC}"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
fi
echo "  PM2: $(pm2 -v)"

# ============================================
# 5. Клонирование проекта
# ============================================
echo -e "${YELLOW}[4/8] Клонирование проекта...${NC}"
if [ -d "$APP_DIR" ]; then
  echo "  Директория существует, обновляю..."
  cd "$APP_DIR"
  git pull origin main 2>/dev/null || true
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi
npm install --production --silent

# Создание .env (мультитенантная версия)
cat > "$APP_DIR/.env" << ENVEOF
PORT=${APP_PORT}
PLATFORM_BOT_TOKEN=${PLATFORM_BOT_TOKEN}
SUPER_ADMIN_ID=${SUPER_ADMIN_ID}
CRON_SECRET=${CRON_SECRET}
ENVEOF
chmod 600 "$APP_DIR/.env"

mkdir -p "$APP_DIR/data"
echo "  .env создан (мультитенантная версия)"

# ============================================
# 6. Копирование данных со старого VPS
# ============================================
if [ -n "$OLD_VPS_IP" ]; then
  echo -e "${YELLOW}[5/8] Копирование данных со старого VPS (${OLD_VPS_IP})...${NC}"
  printf "Пароль root старого VPS: "
  safe_read OLD_VPS_PASS

  # Копирование базы данных
  echo "  Копирование broadcast.db..."
  sshpass -p "$OLD_VPS_PASS" scp -o StrictHostKeyChecking=no \
    "root@${OLD_VPS_IP}:/opt/telegram-broadcast/data/broadcast.db" \
    "$APP_DIR/data/broadcast.db" 2>/dev/null && echo "  broadcast.db скопирован" || echo -e "  ${RED}Ошибка копирования broadcast.db${NC}"

  # Копирование загрузок
  echo "  Копирование uploads/..."
  sshpass -p "$OLD_VPS_PASS" scp -r -o StrictHostKeyChecking=no \
    "root@${OLD_VPS_IP}:/opt/telegram-broadcast/data/uploads" \
    "$APP_DIR/data/" 2>/dev/null && echo "  uploads/ скопированы" || echo "  uploads/ не найдены (пропущено)"
else
  echo -e "${YELLOW}[5/8] Копирование данных пропущено${NC}"
fi

# ============================================
# 7. Настройка Nginx
# ============================================
echo -e "${YELLOW}[6/8] Настройка Nginx...${NC}"
cat > /etc/nginx/sites-available/telegram-broadcast << NGINXEOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        client_max_body_size 10M;
    }
}
NGINXEOF

ln -sf /etc/nginx/sites-available/telegram-broadcast /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl restart nginx
echo "  Nginx настроен"

# ============================================
# 8. SSL
# ============================================
echo -e "${YELLOW}[7/8] SSL-сертификат...${NC}"
echo -e "  ${CYAN}Убедитесь что DNS A-запись ${DOMAIN} → $(curl -s ifconfig.me 2>/dev/null)${NC}"
printf "DNS уже обновлён? (y/n): "
safe_read DNS_READY
if [ "$DNS_READY" = "y" ] || [ "$DNS_READY" = "Y" ]; then
  printf "Email для Let's Encrypt: "
  safe_read LE_EMAIL
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "${LE_EMAIL:-admin@${DOMAIN}}" --redirect
  echo -e "  ${GREEN}SSL установлен!${NC}"
else
  echo -e "  ${YELLOW}SSL пропущен. Запустите позже: certbot --nginx -d ${DOMAIN} --redirect${NC}"
fi

# ============================================
# 9. Firewall
# ============================================
echo -e "${YELLOW}[8/8] Firewall...${NC}"
ufw allow OpenSSH >/dev/null 2>&1
ufw allow 'Nginx Full' >/dev/null 2>&1
echo "y" | ufw enable >/dev/null 2>&1
echo "  UFW: SSH + Nginx разрешены"

# ============================================
# 10. Запуск
# ============================================
echo ""
echo -e "${YELLOW}Запуск приложения...${NC}"
cd "$APP_DIR"
pm2 delete broadcast 2>/dev/null || true
pm2 start server.js --name broadcast --cwd "$APP_DIR"
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || pm2 startup

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗"
echo "║           Миграция завершена!                 ║"
echo "╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Приложение:${NC}  https://${DOMAIN}"
echo -e "  ${CYAN}Статус:${NC}      pm2 status"
echo -e "  ${CYAN}Логи:${NC}        pm2 logs broadcast"
echo -e "  ${CYAN}Health:${NC}      curl http://localhost:${APP_PORT}/health"
echo ""
echo -e "  ${YELLOW}Осталось:${NC}"
echo "  1. Обновить DNS A-запись ${DOMAIN} → $(curl -s ifconfig.me 2>/dev/null) (если ещё не сделано)"
echo "  2. Получить SSL (если пропущен): certbot --nginx -d ${DOMAIN} --redirect"
echo "  3. Проверить Mini App в Telegram"
echo ""
echo -e "  ${YELLOW}Cron (тест):${NC}  curl https://${DOMAIN}/api/cron/send?secret=${CRON_SECRET}"
echo ""
