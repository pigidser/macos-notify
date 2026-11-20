# macos-notify + Herdr

Pi готовит короткое резюме финального ответа. Расширение `extensions/macos-notify.ts` передаёт его через OSC 7501 как именованную запись `pi-notify-summary`, не меняя штатный статус Pi. Оно не вызывает `terminal-notifier` или AppleScript. В обычном терминале вне Herdr расширение не отправляет уведомлений.

На MacBook мод Herdr `macos-toast` использует штатные события Herdr. Он определяет отправителя по данным терминала, а не по тексту заголовка:

- **Pi** — `Pi Notifier.app` с пиктограммой Pi. В сообщении — резюме, если оно есть; в подзаголовке — штатный контекст Herdr.
- **Codex** — `Codex Notifier.app` с пиктограммой Codex из Herdr. Текст штатный, без суммаризации.
- **Другие агенты и обычные тосты** — нейтральный Homebrew `terminal-notifier`. Служебные тосты с особыми действиями остаются внутри Herdr. При ошибке системной доставки мод оставляет штатный тост.

Клик по уведомлению агента открывает его панель через `herdr-app do agent.focus`. Правила Herdr о том, когда показывать тост, не меняются. Отдельный сетевой сервис не нужен.

## Установка и восстановление

1. На каждой машине, где работает Pi (в том числе на Mac mini), сохраните копию прежнего файла, затем скопируйте `extensions/macos-notify.ts` в `~/.pi/agent/extensions/`. В уже запущенном Pi выполните `/reload`. Эта версия не использует прежний помощник `macos-notify-focus.mjs` и параметры `macosNotify`; менять остальную конфигурацию Pi не требуется. Проверено с Pi 1.5.2.
2. На MacBook сохраните прежнюю папку мода, скопируйте содержимое `herdr/macos-toast/` в `~/.config/herdr-app/mods/macos-toast/`, затем выполните `~/.local/bin/herdr-app check ~/.config/herdr-app/mods/macos-toast`. В корне пользовательского лейаута (`~/.config/herdr-app/layouts/main-macos.json` на этом MacBook) укажите `"toast": "macos-toast"`. Штатный лейаут `main` править не нужно: его можно скопировать командой `~/.local/bin/herdr-app do layout.clone '{"name":"main","as":"main-macos"}'`. Проверено с Herdr App 0.1.16.
3. Установите приложения-отправители **только на MacBook**. `vendor/Pi Notifier.app` содержит исходный подписанный ad-hoc бандл с пиктограммой Pi. Для Codex создаётся отдельный бандл: macOS берёт иконку из приложения-отправителя, а не из параметров уведомления.

   ```sh
   mkdir -p "$HOME/Applications"
   pi_app="$HOME/Applications/Pi Notifier.app"
   if [ ! -e "$pi_app" ] && [ ! -L "$pi_app" ]; then
     ditto "vendor/Pi Notifier.app" "$pi_app"
   fi
   codesign --verify --strict "$pi_app"
   # Требуется rsvg-convert (brew install librsvg), если бандл ещё не создан.
   /bin/sh scripts/build-codex-notifier.sh
   ```

   Эти два бандла `terminal-notifier` 3.1.0 требуют Apple Silicon и macOS 27.0+. Сборки не нотарифицированы. Лицензия `terminal-notifier` лежит в `vendor/LICENSE.terminal-notifier.md`, лицензия пиктограммы Codex — в `vendor/codex/LICENSE-LobeHub.txt`. Для нейтральных уведомлений на этом Mac используется `/opt/homebrew/bin/terminal-notifier`.
4. В **Системные настройки → Уведомления** разрешите баннеры отдельно для **Pi Notifier** и **Codex Notifier**. Для проверки разрешения можно запустить `"$HOME/Applications/Codex Notifier.app/Contents/MacOS/terminal-notifier" -diagnose` (или аналогично для Pi).

Суммаризация использует Fast-модель из `pi-shift-router.json` (пользовательского или в доверенном проекте). Если файлов маршрутизации нет, Pi пробует `openai-codex/gpt-6-luna`. Если модели нет или суммаризация не удалась, Herdr показывает обычное уведомление о завершении.

## Откат

Переключение Herdr на штатный лейаут: `~/.local/bin/herdr-app do layout.switch '{"name":"main"}'`. Снимок расширения до интеграции — тег `baseline`, а снимок с добавленным бандлом Pi — коммит `0d62415`. В их README описано восстановление предыдущей версии. В репозитории нет учётных данных или истории сессий.

## Проверка

Из корня репозитория (Node.js 22+):

```sh
(
  test_home=$(mktemp -d) || exit 1
  trap 'rm -rf "$test_home"' EXIT
  HOME="$test_home" node --experimental-strip-types --test tests/*.test.mjs
)
```
