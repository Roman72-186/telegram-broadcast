# telegram-broadcast

## Подключение к общему мозгу workspace

Этот файл подключает существующий проект к общим правилам Codex и Claude Code. Локальная специфика проекта остаётся в этом каталоге, общие правила берутся уровнем выше.

1. Сначала читать [../AGENTS.md](../AGENTS.md) — главный источник правды workspace.
2. Для Claude Code совместимый вход — [CLAUDE.md](CLAUDE.md), но он должен вести к этому AGENTS.md.
3. Для кода читать [../principles/code.md](../principles/code.md).
4. Для продуктовых решений читать [../principles/product.md](../principles/product.md).
5. Для правил работы агентов читать [../principles/working-with-claude.md](../principles/working-with-claude.md).
6. Для уроков и повторяющихся ошибок читать [../feedback/](../feedback/).
7. Для планов использовать [../plans/](../plans/); для handoff между Codex и Claude Code использовать [session-handoffs/current.md](session-handoffs/current.md).

## Паритет Codex и Claude Code

Codex и Claude Code равноправны: любой из них может продолжить работу в этом проекте после другого.

- Проектная специфика живёт здесь, в AGENTS.md, и при необходимости в локальном CLAUDE.md или obsidian-vault/.
- Команда Сохранить сессию использует внешний протокол C:\Users\User\.agents\skills\save-session\SKILL.md и пишет в session-handoffs/current.md.
- Команда Прочитай сохранённую сессию начинает с session-handoffs/current.md, затем читает этот AGENTS.md.
- После значимых изменений в коде, деплоя или разбора бага применять правило workspace-brain-sync: локальное остаётся здесь, повторяющееся уходит в общий слой `ai-clone/` (`../principles/`, `../feedback/` и т.п.), процедуры — в skills.
- Нельзя держать важное правило только в истории чата одного агента.

## Локальная специфика проекта

Если в проекте уже есть подробный CLAUDE.md, считать его историческим локальным контекстом проекта. Новые общие требования не копировать сюда целиком: ссылаться на общий слой выше.

## Связь с другими файлами

- [[AGENTS]]
- [[CLAUDE]]
- [[code]]
- [[product]]
- [[working-with-claude]]