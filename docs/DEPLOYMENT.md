# Railway / sandbox deployment

Deployment не выполнялся. Dockerfile собирает frontend/server, Node 22 запускается non-root. Railway health `/api/ready`. Server applies Studio migrations/bootstrap at startup; этот шаг должен входить в отдельно одобренный deployment plan и обращаться только к новой Studio database.

1. Создайте отдельные PostgreSQL/Studio services после review. Не используйте CRM/PMS DATABASE_URL.
2. Задайте NODE_ENV=production, LOCAL_PREVIEW=false, HOST=0.0.0.0, PORT, DATABASE_URL, HTTPS PUBLIC_URL, случайный MEDIA_SIGNING_SECRET (32+ символа), ADMIN_EMAIL/ADMIN_PASSWORD (12+ символов). После первого входа удалите bootstrap password из env.
3. Для LocalStorage подключите durable volume, writable uid 1000, и MEDIA_DIR. Несколько независимых disks не поддерживают horizontal media scaling; используйте S3/R2 ObjectStorage implementation. Production требует отдельный PostgreSQL, не PGlite.
4. Non-local upload требует malware scanner HTTPS returning `{clean:true}`, bearer token и разрешённый host. Unscanned preview media не покидают preview.
5. В production dev-сессия и guest fixtures не создаются. Войдите bootstrap admin и явно создайте виртуальных клиентов. Начальный mode preview.
6. CRM mode требует sandbox URL/key/property и STUDIO_SANDBOX=true с exact HTTPS host allowlist. Attestation оператора не заменяет проверку среды. Discovery подтверждает contract compatibility.
7. E2E дополнительно требует PMS property UUID/key, n8n webhook/capability URL/token/callback secret и реализованный studio-gateway-v1. Выполните gaps/read-back acceptance перед включением.

Signed links живут 5 минут; смена secret инвалидирует старые. Media denied after 30 days; physical deletion пока через отдельную storage lifecycle policy. Backup DB/media вместе. Cache не является authoritative transcript. Credentials/env не возвращаются frontend; redirects запрещены. Для публичного ingress добавьте request/upload quotas; встроен login rate limit.

Перед deployment выполните npm run check и PostgreSQL/Chromium CI. Для существующей Studio БД заранее изучите migration ledger, снимите backup и подтвердите rollout. В рамках текущей задачи production deployment/migrations/merge запрещены и не выполнялись.
