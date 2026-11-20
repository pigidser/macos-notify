# macos-notify для Pi

Снимок установленного расширения до интеграции с удалённым Herdr. Исходники расширения, обработчика клика и тестов скопированы без изменений. Расширение уведомляет после завершения основной интерактивной сессии Pi на macOS. Если доступна модель для суммаризации, в баннер попадает короткое резюме финального ответа. Эта версия не пересылает уведомления между машинами.

## Восстановление

Исходный снимок отмечен тегом `baseline`. Из корня репозитория (на нужной ревизии):

```sh
agent="$HOME/.pi/agent"
backup=$(mktemp -d "$HOME/.pi/macos-notify-restore.XXXXXX") && (
  set -e
  mkdir -p "$agent/extensions" "$agent/helpers" "$backup/extensions" "$backup/helpers"
  for file in extensions/macos-notify.ts helpers/macos-notify-focus.mjs settings.json; do
    if [ -f "$agent/$file" ]; then cp -p "$agent/$file" "$backup/$file"; fi
  done
  cp extensions/macos-notify.ts "$agent/extensions/"
  cp helpers/macos-notify-focus.mjs "$agent/helpers/"
  printf 'Резервная копия прежних файлов: %s\n' "$backup"
)
```

Перенесите только секцию `macosNotify` из [`config/settings.fragment.json`](config/settings.fragment.json) в `~/.pi/agent/settings.json`. Не заменяйте весь `settings.json`: это фрагмент, а не полный конфиг Pi. В снимке используется `navigationTarget: "app"` для Herdr App; `"tui"` выбирает Herdr TUI. В запущенной сессии Pi выполните `/reload`.

### Pi Notifier с пиктограммой Pi

В [`vendor/Pi Notifier.app`](vendor/Pi%20Notifier.app) сохранён полный бандл `terminal-notifier` 3.1.0 с пиктограммой Pi и той же ad-hoc подписью, что у установленного экземпляра. Сборка требует Apple Silicon и macOS 27.0 или новее. [Лицензия terminal-notifier](vendor/LICENSE.terminal-notifier.md) лежит рядом.

Если приложения ещё нет в `~/Applications`, его можно восстановить из корня репозитория:

```sh
app="$HOME/Applications/Pi Notifier.app"
if [ ! -e "$app" ] && [ ! -L "$app" ]; then
  mkdir -p "$HOME/Applications" && ditto "vendor/Pi Notifier.app" "$app"
fi
codesign --verify --strict "$app"
```

Проверка подписи не заменяет проверку Gatekeeper: бандл не нотарифицирован. Для баннеров разрешите уведомления **Pi Notifier** в настройках macOS.

### Зависимости

- Pi 1.5.2 — версия, с которой сохранён снимок.
- Расширение предпочитает `~/Applications/Pi Notifier.app`. Если сборка не подходит, можно использовать обычный `terminal-notifier` из Homebrew. Если notifier не найден, расширение использует AppleScript без клика.
- Для резюме нужна доступная Fast-модель из `pi-shift-router.json` (пользовательского или в доверенном проекте). Если файлов маршрутизации нет, расширение пробует `openai-codex/gpt-6-luna`. Без резюме остаётся обычное `Ready.`.

В репозитории нет учётных данных, истории сессий и остальной конфигурации Pi.

## Тесты

На macOS с Node.js 22 или новее. Изолированный `HOME` не даёт установленному `Pi Notifier.app` влиять на тесты; системные уведомления не отправляются.

```sh
(
  test_home=$(mktemp -d) || exit 1
  trap 'rm -rf "$test_home"' EXIT
  HOME="$test_home" node --experimental-strip-types --test tests/macos-notify.test.mjs
)
```
