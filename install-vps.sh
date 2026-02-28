#!/bin/bash
# ============================================================
# install-vps.sh — Полная установка telegram-broadcast на VPS
# Использование:
#   wget https://raw.githubusercontent.com/Roman72-186/telegram-broadcast/main/install-vps.sh && bash install-vps.sh
# ============================================================

set -e

# Убираем \r из самого скрипта если запущен с Windows-окончаниями
if grep -q $'\r' "$0" 2>/dev/null; then
  sed -i 's/\r$//' "$0"
  exec bash "$0" "$@"
fi

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Безопасный read — убирает \r\n и пробелы по краям
safe_read() {
  local varname="$1"
  local input
  IFS= read -r input
  input=$(printf '%s' "$input" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  eval "$varname=\"\$input\""
}

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════════╗"
echo "║   Telegram Broadcast — Установка на VPS      ║"
echo "╚══════════════════════════════════════════════╝"
echo -e "${NC}"

# ============================================
# 1. Проверка root
# ============================================
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Запустите от root: sudo bash install-vps.sh${NC}"
  exit 1
fi

# ============================================
# 2. Определение ОС
# ============================================
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="$ID"
  OS_VERSION="$VERSION_ID"
else
  echo -e "${RED}Не удалось определить ОС${NC}"
  exit 1
fi

echo -e "${GREEN}ОС: ${OS_ID} ${OS_VERSION}${NC}"

# ============================================
# 3. Сбор параметров
# ============================================
echo ""
echo -e "${YELLOW}=== Настройка параметров ===${NC}"

printf "Введите домен (например broadcast.example.com): "
safe_read DOMAIN
if [ -z "$DOMAIN" ]; then
  echo -e "${RED}Домен обязателен для SSL${NC}"
  exit 1
fi

printf "Telegram Bot Token: "
safe_read TG_BOT_TOKEN
if [ -z "$TG_BOT_TOKEN" ]; then
  echo -e "${RED}Telegram Bot Token обязателен${NC}"
  exit 1
fi

printf "Leadteh API Token: "
safe_read LEADTEH_TOKEN
if [ -z "$LEADTEH_TOKEN" ]; then
  echo -e "${RED}Leadteh API Token обязателен${NC}"
  exit 1
fi

printf "Leadteh Bot ID [257034]: "
safe_read LEADTEH_BOT_ID
LEADTEH_BOT_ID=${LEADTEH_BOT_ID:-257034}

printf "Telegram ID администраторов (через запятую): "
safe_read ADMIN_IDS
if [ -z "$ADMIN_IDS" ]; then
  echo -e "${RED}Нужен хотя бы один ID администратора${NC}"
  exit 1
fi

# CRON_SECRET — генерируем автоматически
CRON_SECRET=$(openssl rand -hex 16)

# Порт приложения
APP_PORT=3000

# Репозиторий (GitHub)
printf "URL репозитория GitHub [https://github.com/Roman72-186/telegram-broadcast.git]: "
safe_read REPO_URL
REPO_URL=${REPO_URL:-https://github.com/Roman72-186/telegram-broadcast.git}

echo ""
echo -e "${CYAN}=== Параметры ===${NC}"
echo "  Домен:       $DOMAIN"
echo "  Bot Token:   ${TG_BOT_TOKEN:0:10}..."
echo "  Leadteh:     ${LEADTEH_TOKEN:0:10}..."
echo "  Bot ID:      $LEADTEH_BOT_ID"
echo "  Админы:      $ADMIN_IDS"
echo "  Порт:        $APP_PORT"
echo "  Репо:        $REPO_URL"
echo ""

printf "Всё верно? (y/n): "
safe_read CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Отменено."
  exit 0
fi

# ============================================
# 4. Обновление системы
# ============================================
echo ""
echo -e "${YELLOW}[1/7] Обновление системы...${NC}"

if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
  apt-get update -qq
  apt-get upgrade -y -qq
  apt-get install -y -qq curl git ufw software-properties-common
elif [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
  dnf update -y -q
  dnf install -y -q curl git firewalld
fi

# ============================================
# 5. Установка Node.js 20 LTS
# ============================================
echo -e "${YELLOW}[2/7] Установка Node.js 20...${NC}"

if command -v node &>/dev/null; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ]; then
    echo "  Node.js $(node -v) уже установлен"
  else
    echo "  Node.js слишком старый ($NODE_VER), обновляю..."
    INSTALL_NODE=1
  fi
else
  INSTALL_NODE=1
fi

if [ "${INSTALL_NODE:-0}" = "1" ]; then
  if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  elif [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y -q nodejs
  fi
fi

echo "  Node.js: $(node -v), npm: $(npm -v)"

# ============================================
# 6. Установка PM2
# ============================================
echo -e "${YELLOW}[3/7] Установка PM2...${NC}"

if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 --silent
fi

echo "  PM2: $(pm2 -v)"

# ============================================
# 7. Клонирование проекта
# ============================================
echo -e "${YELLOW}[4/7] Клонирование проекта...${NC}"

APP_DIR="/opt/telegram-broadcast"

if [ -d "$APP_DIR" ]; then
  echo "  Директория $APP_DIR уже существует, обновляю..."
  cd "$APP_DIR"
  git pull origin main 2>/dev/null || true
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# Установка зависимостей
npm install --production --silent

# Создание .env
cat > "$APP_DIR/.env" << ENVEOF
PORT=${APP_PORT}
LEADTEH_API_TOKEN=${LEADTEH_TOKEN}
LEADTEH_BOT_ID=${LEADTEH_BOT_ID}
TELEGRAM_BOT_TOKEN=${TG_BOT_TOKEN}
ADMIN_TELEGRAM_IDS=${ADMIN_IDS}
CRON_SECRET=${CRON_SECRET}
ENVEOF

chmod 600 "$APP_DIR/.env"
echo "  .env создан"

# Создание директории для данных
mkdir -p "$APP_DIR/data"

# ============================================
# 8. Настройка Nginx
# ============================================
echo -e "${YELLOW}[5/7] Настройка Nginx...${NC}"

if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
  apt-get install -y -qq nginx
elif [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
  dnf install -y -q nginx
  systemctl enable nginx
fi

# Конфигурация Nginx (сначала HTTP, потом Certbot добавит SSL)
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
    }
}
NGINXEOF

# Для CentOS/AlmaLinux — другой путь конфигов
if [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  if ! grep -q "sites-enabled" /etc/nginx/nginx.conf; then
    sed -i '/http {/a \    include /etc/nginx/sites-enabled/*;' /etc/nginx/nginx.conf
  fi
fi

# Включаем сайт
ln -sf /etc/nginx/sites-available/telegram-broadcast /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t
systemctl restart nginx
echo "  Nginx настроен"

# ============================================
# 9. SSL сертификат (Let's Encrypt)
# ============================================
echo -e "${YELLOW}[6/7] Установка SSL (Let's Encrypt)...${NC}"

if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx
elif [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
  dnf install -y -q certbot python3-certbot-nginx
fi

echo "  Получение SSL-сертификата для ${DOMAIN}..."
echo "  (DNS A-запись ${DOMAIN} должна указывать на $(curl -s ifconfig.me 2>/dev/null || echo 'этот сервер'))"
echo ""

printf "DNS настроен и указывает на этот сервер? (y/n): "
safe_read DNS_READY

if [ "$DNS_READY" = "y" ] || [ "$DNS_READY" = "Y" ]; then
  printf "Email для Let's Encrypt: "
  safe_read LE_EMAIL
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$LE_EMAIL" --redirect
  echo -e "  ${GREEN}SSL установлен!${NC}"
else
  echo -e "  ${YELLOW}SSL пропущен. Запустите позже:${NC}"
  echo "  certbot --nginx -d ${DOMAIN} --redirect"
fi

# ============================================
# 10. Firewall
# ============================================
echo -e "${YELLOW}[7/7] Настройка Firewall...${NC}"

if [[ "$OS_ID" == "ubuntu" || "$OS_ID" == "debian" ]]; then
  ufw allow OpenSSH >/dev/null 2>&1
  ufw allow 'Nginx Full' >/dev/null 2>&1
  echo "y" | ufw enable >/dev/null 2>&1
  echo "  UFW: SSH + Nginx разрешены"
elif [[ "$OS_ID" == "centos" || "$OS_ID" == "almalinux" || "$OS_ID" == "rocky" ]]; then
  systemctl enable firewalld --now >/dev/null 2>&1
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1
  firewall-cmd --permanent --add-service=ssh >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1
  echo "  firewalld: SSH + HTTP/HTTPS разрешены"
fi

# ============================================
# 11. Запуск приложения через PM2
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
echo "║           Установка завершена!                ║"
echo "╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}Приложение:${NC}  https://${DOMAIN}"
echo -e "  ${CYAN}Статус PM2:${NC}  pm2 status"
echo -e "  ${CYAN}Логи:${NC}        pm2 logs broadcast"
echo -e "  ${CYAN}Рестарт:${NC}     pm2 restart broadcast"
echo -e "  ${CYAN}Данные:${NC}      ${APP_DIR}/data/"
echo -e "  ${CYAN}Конфиг:${NC}      ${APP_DIR}/.env"
echo ""
echo -e "  ${YELLOW}Следующие шаги:${NC}"
echo "  1. Проверьте: curl https://${DOMAIN}/api/broadcast/list"
echo "  2. В @BotFather → /newapp → укажите URL: https://${DOMAIN}"
echo "  3. Откройте Mini App через бота и создайте тестовую рассылку"
echo ""
echo -e "  ${YELLOW}Ручной запуск cron (тест):${NC}"
echo "  curl https://${DOMAIN}/api/cron/send?secret=${CRON_SECRET}"
echo ""
