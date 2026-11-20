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

### Зависимости

- Pi 1.5.2 — версия, с которой сохранён снимок.
- Для клика нужен `terminal-notifier` (`brew install terminal-notifier`). Если уже установлено `~/Applications/Pi Notifier.app`, расширение предпочитает его. Этот отдельный app-бандл в репозиторий не входит. Если `terminal-notifier` не найден, расширение использует AppleScript без клика. Разрешите уведомления соответствующего приложения в настройках macOS.
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
