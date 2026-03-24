# Deployment Guide

## 1. PostgreSQL

```bash
sudo -u postgres psql
CREATE DATABASE crypto_dashboard;
CREATE USER crypto_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE crypto_dashboard TO crypto_user;
\q
```

## 2. Build

```bash
# Backend
cd backend && cp .env.example .env
# Edit .env with real values
npm install && npm run build
npx prisma migrate deploy

# Frontend
cd ../frontend && cp .env.example .env
# Edit .env with real values
npm install && npm run build
```

## 3. PM2

```bash
cd backend
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## 4. Nginx

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN_OR_IP;

    root /var/www/crypto-dashboard;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo cp -r frontend/dist/* /var/www/crypto-dashboard/
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Verify

```bash
pm2 logs crypto-backend
curl -X POST http://localhost:3001/api/analyze \
  -H "Content-Type: application/json" \
  -H "X-Api-Secret: YOUR_SECRET" \
  -d '{"coins":["BTC","ETH"]}'
```
