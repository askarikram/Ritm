# Ритм

Личный финансовый план с аккаунтами. server.js взят из документа проекта без изменений:
https://docs.google.com/document/d/1INeIP3YUElh3jfcVTkHIW5XqXuc7k4Eczm3BgOFrTAI/edit

Размещение: Render Free, Node.js 24, Frankfurt. PostgreSQL 17 в Neon Free, Frankfurt.
Установка: npm install. Запуск: npm start. Проверка синтаксиса: npm run check.

DATABASE_URL хранится только в секретной переменной окружения Render. NODE_ENV=production.
Render автоматически задаёт PORT и RENDER_EXTERNAL_URL. APP_ORIGIN нужен только для своего HTTPS-домена.
Постоянный диск не используется. Таблицы создаются при первом запуске.

Первую публикацию проверяют с RITM_VERIFY_DEPLOY=1. Стартовый скрипт ждёт доступности публичного HTTPS-адреса,
создаёт два случайных тестовых аккаунта и через HTTP проверяет сохранение разных планов, запрет чужого
чтения и записи, защиту от старой вкладки после смены аккаунта, Origin, конфликт версии, выход и повторный вход.
Тест удаляет только созданные им аккаунты. Пароли и cookie не выводятся. Успех: RITM_ISOLATION_PASS в логах.
После подтверждённой проверки RITM_VERIFY_DEPLOY возвращают в 0. Дальше npm start запускает только сервер.

Render Free засыпает после простоя, первый запрос может занять около минуты:
https://render.com/docs/free
