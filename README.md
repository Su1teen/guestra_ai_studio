# Guestra AI Studio

Платформа симуляции гостевого общения и тестирования AI-агентов гостиниц. Studio владеет тестовыми личностями, заметками, сценариями, попытками доставки и версиями промптов. CRM владеет подключёнными переписками; PMS — гостиничными операциями.

**Текущая поставка:** работающая локальная платформа, CRM HTTP adapter и подготовленные sandbox-контракты. Реальные CRM/PMS/n8n не подключены. Local Preview явно показывает ответы-шаблоны и учебные данные.

## Быстрый старт

Нужен Node.js 20.19+ (рекомендуется 22).

```sh
npm ci
npm run dev
```

Откройте **http://127.0.0.1:5173**, нажмите «Открыть локальную студию». API: http://127.0.0.1:4310. Данные сохраняются в `.local/dev-db` через embedded PostgreSQL **PGlite**, файлы — `.local/media`. Это PostgreSQL SQL engine внутри процесса; для Railway применяется отдельный PostgreSQL server через `pg`. Не запускайте два PGlite процесса с одной папкой.

Dev-сессия разрешена только при `LOCAL_PREVIEW=true`, вне production и при loopback binding. Тестовые гости LES Боровое вымышлены. История сохраняется при повторном использовании папки данных.

## PostgreSQL / server authentication

Создайте отдельную БД Studio, **не БД CRM/PMS**. Скопируйте `.env.example` в `.env`; задайте `DATABASE_URL`, `MEDIA_SIGNING_SECRET` (32+ случайных символа), `PUBLIC_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ символов). Сервер читает `.env`. `npm run dev` явно включает локальную среду. Для обычной авторизации: `npm run build`, затем `npm start` с `LOCAL_PREVIEW=false`.

Railway использует `PORT=8080`. Production startup проверяет принадлежность Studio DB, установленные миграции и deployment attestation; автоматические миграции по умолчанию выключены. Перед rollout выполните отдельно одобренные `npm run db:migrate` и `npm run bootstrap` по [RAILWAY_ACTIVATION](docs/RAILWAY_ACTIVATION.md). Автоматические миграции сохраняются только для embedded Local Preview. Любой `DATABASE_URL`, включая local mode, требует подтверждения принадлежности Studio. Для PostgreSQL в Docker есть `compose.yaml`: задайте собственный `POSTGRES_PASSWORD`, порт 5433 открыт только на loopback.

RBAC: admin/tester/reviewer/viewer. Пароли scrypt, session tokens хранятся только как SHA-256; cookie HttpOnly/SameSite Strict/secure в production. Membership/workspace проверяются на каждом запросе. Нет self-registration. Первый администратор создаётся через env bootstrap.

## Проверка

```sh
npm run check
npm run test:browser
```

Для браузерных тестов: `npx playwright install chromium`; на Windows можно задать `PLAYWRIGHT_CHANNEL=msedge` для установленного Edge. Desktop/mobile сценарии проверяют восстановление входа после недоступности API, создание клиента/чата, черновик после reload, отправку, заметки, версии/diff промптов, виртуальный звонок, image lightbox, PDF download и WAV playback. Запуск тестов ожидает готовности API, включая миграции и bootstrap.

`TEST_DATABASE_URL` переключает API-тесты на отдельную **одноразовую БД**. Не используйте БД с пользовательскими данными: тесты сбрасывают свою очередь. CI использует PostgreSQL 16 и Chromium. Отдельный persistence-test закрывает и повторно открывает PGlite.

## Архитектура

React/Vite → Express Studio API → durable queue. Preview сохраняет собственный учебный transcript. CRM mode: Gateway — единственный inbound owner. E2E sandbox: n8n — единственный inbound owner. Connected messages отображаются только из CRM; Studio сохраняет bounded read-only cache (200 сообщений). Операции гостиницы выполняет PMS через n8n.

`server/gateway.ts` — очередь/leases/replay/reconciliation; `server/integrations.ts` — CRM HTTP, discovery и future interfaces; `server/media.ts` — ObjectStorage, validation/scanner/signed URLs; `server/repository.ts` — workspace-scoped persistence; `shared/domain.ts` — типы/Zod; `migrations/` — PostgreSQL schema.

Advanced connected scenarios возвращают `SETUP_UNAVAILABLE` до внедрения fixture API. Начальная стадия — тестовый параметр, не факт оплаты/проживания. Режим существующего чата сохраняется; переключатель влияет на новые разговоры. Prompt publish/rollback активирует Studio registry; n8n sync явно не подключён. Звонки виртуальные, без SIP/realtime audio.

## Интеграция / Railway

Все URLs/credentials server-side. Подключения требуют явного `STUDIO_SANDBOX=true`, HTTPS и `SANDBOX_ALLOWED_HOSTS`. Discovery не является сквозным тестом. Dockerfile/Railway config готовы; deployment не выполнялся.

Для media LocalStorage нужен persistent volume (`MEDIA_DIR`), иначе redeploy потеряет файлы. S3/R2 можно реализовать через ObjectStorage interface. Scanner обязателен для non-local upload; unscanned preview media не передаются workflow. URLs действуют 5 минут, retention — 30 дней; физическая очистка expired объектов требует storage lifecycle policy.

- [DELIVERY_REPORT](docs/DELIVERY_REPORT.md)
- [INTEGRATION_CONTRACTS](docs/INTEGRATION_CONTRACTS.md)
- [CRM_PMS_INTEGRATION_GAPS](docs/CRM_PMS_INTEGRATION_GAPS.md)
- [CRM_AUDIT](docs/CRM_AUDIT.md), [PMS_AUDIT](docs/PMS_AUDIT.md)
- [API_REFERENCE](docs/API_REFERENCE.md), [DEPLOYMENT](docs/DEPLOYMENT.md)

Ветка разработки `feat/studio-foundation`; main содержит bootstrap. CRM/PMS не изменялись. Production deploy, production migrations и merge не выполнялись.
