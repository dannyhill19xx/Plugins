# Last comment field (Jira Cloud, Forge)

Read-only поле с текстом последнего публичного комментария.

## Запуск
```bash
npm i -g @forge/cli
forge login            # email + API token: https://id.atlassian.com/manage-profile/security/api-tokens
npm install
forge register         # подставит app.id в manifest.yml
forge lint
forge deploy
forge install          # выбрать свой dev-сайт и Jira
```
Добавь поле «Last comment» на экран задачи, оставь комментарий, смотри `forge logs`.

## Проверено в песочнице
- `tsc --noEmit` — ок
- manifest.yml против официальной JSON-схемы @forge/manifest — ок
- `forge lint` не запускался: требует авторизации

## Известные ограничения v0.1
- Правка комментария не обновляет поле: в Forge нет события на редактирование комментария.
- Старые задачи не заполняются после установки (следующий шаг: backfill через очередь).
