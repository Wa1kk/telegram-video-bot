# 🎬 Telegram Video Bot

Telegram-бот, который скачивает видео и изображения из YouTube, Instagram, Pinterest и TikTok и отправляет их прямо в чат.

Развёрнут на **Vercel Serverless Functions** — не требует VPS и работает бесплатно.

## ✨ Возможности

- 🎥 **YouTube** — Shorts и обычные видео
- 📸 **Instagram** — посты, Reels, TV, share-ссылки (включая карусели)
- 📌 **Pinterest** — видео и фото-пины
- 🎵 **TikTok** — видео без водяного знака
- 🔗 Автоматическое определение платформы по URL
- 📝 HTML-подпись с автором и описанием
- ⚡ Статусные сообщения («Скачиваю…» → «Загружаю…»)
- 🔒 Опциональная валидация webhook через секретный токен

## 🚀 Быстрый старт

### 1. Создай бота через [@BotFather](https://t.me/BotFather) и получи токен

### 2. Клонируй репозиторий

```bash
git clone https://github.com/Wa1kk/telegram-video-bot.git
cd telegram-video-bot
npm install
```

### 3. Настрой переменные окружения

Скопируй `.env.example` в `.env` и заполни:

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
WEBHOOK_SECRET=your_random_secret_here  # опционально
```

### 4. Задеплой на Vercel

```bash
vercel --prod
```

### 5. Установи webhook

```bash
BOT_TOKEN=<токен> node scripts/setup-webhook.js https://your-app.vercel.app
```

Готово — отправь боту ссылку на видео, и он скачает и отправит его в чат!

## 🛠 Технологии

- **Node.js** ≥18
- **Vercel Serverless Functions** (хостинг)
- **Cobalt API** — скачивание с YouTube и TikTok
- **Instagram GQL** — скачивание с Instagram
- **Скрейпинг** — скачивание с Pinterest

## 📁 Структура проекта

```
├── api/webhook.js          # Точка входа (Vercel Serverless)
├── lib/
│   ├── handler.js           # Обработчик Telegram-обновлений
│   ├── downloader.js        # Диспетчер платформ
│   ├── telegram.js          # Telegram Bot API
│   └── platforms/
│       ├── youtube.js       # YouTube через Cobalt
│       ├── instagram.js     # Instagram (GQL + Cobalt fallback)
│       ├── pinterest.js     # Pinterest (скрейпинг)
│       └── tiktok.js        # TikTok через Cobalt
├── scripts/setup-webhook.js
├── .env.example
└── vercel.json
```

## 📄 Документация

Полное описание продукта — в [PRD.md](PRD.md)

## 📜 Лицензия

MIT
