import { useEffect, useMemo, useRef, useState } from "preact/hooks";

export type PaletteCommand = {
  id: string;
  label: string;
  group?: string | undefined;
  keywords?: string[] | undefined;
  shortcut?: string | undefined;
  run: () => void | Promise<void>;
};

type CommandPaletteProps = {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
};

/** A searchable command dialog. The caller owns its open state and the commands' effects. */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const selected = filtered.length === 0 ? -1 : Math.min(active, filtered.length - 1);

  useEffect(() => {
    if (!open) {
      return;
    }
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setActive(0);
    search.current?.focus();
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected) {
        target.focus();
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const run = (command: PaletteCommand) => {
    onClose();
    void command.run();
  };

  const move = (by: number, moveFocus: boolean) => {
    if (filtered.length === 0) {
      return;
    }
    const next = (selected + by + filtered.length) % filtered.length;
    setActive(next);
    if (moveFocus) {
      queueMicrotask(() => options.current[next]?.focus());
    }
  };

  const groups = groupCommands(filtered);
  let optionIndex = 0;
  return (
    <div class="command-palette-backdrop">
      <button
        type="button"
        class="command-palette-dismiss"
        aria-label="Close command palette"
        tabindex={-1}
        onClick={onClose}
      />
      <section
        ref={dialog}
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-palette-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Tab") {
            const focusable = [
              ...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input") ?? []),
            ].filter((element) => element.tabIndex >= 0);
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first && last) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last && first) {
              event.preventDefault();
              first.focus();
            }
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            move(1, event.currentTarget !== search.current && event.target !== search.current);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            move(-1, event.currentTarget !== search.current && event.target !== search.current);
          } else if (event.key === "Enter" && event.target === search.current && selected >= 0) {
            event.preventDefault();
            const command = filtered[selected];
            if (command) {
              run(command);
            }
          }
        }}
      >
        <header class="command-palette-head">
          <h2 id="command-palette-title">Command palette</h2>
          <button type="button" class="secondary command-palette-close" onClick={onClose}>
            Close
          </button>
        </header>
        <label class="command-palette-search">
          <span class="visually-hidden">Search commands</span>
          <input
            ref={search}
            type="search"
            list={undefined}
            aria-autocomplete="list"
            aria-controls="command-palette-results"
            aria-expanded="true"
            aria-activedescendant={selected >= 0 ? `command-palette-option-${selected}` : undefined}
            placeholder="Search repositories, views and actions…"
            value={query}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
          />
        </label>
        <div id="command-palette-results" class="command-palette-results" role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <p class="command-palette-empty" role="status">
              No commands match “{query}”
            </p>
          ) : (
            groups.map(([group, entries], groupIndex) => {
              const groupId = `command-palette-group-${groupIndex}`;
              return (
                <fieldset key={group} class="command-palette-group">
                  <legend id={groupId}>{group}</legend>
                  {entries.map((command) => {
                    const index = optionIndex++;
                    return (
                      <button
                        key={command.id}
                        id={`command-palette-option-${index}`}
                        ref={(element) => {
                          options.current[index] = element;
                        }}
                        type="button"
                        class="command-palette-option"
                        role="option"
                        aria-selected={index === selected}
                        tabindex={index === selected ? 0 : -1}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => run(command)}
                      >
                        <span>{command.label}</span>
                        {command.shortcut && <kbd>{command.shortcut}</kbd>}
                      </button>
                    );
                  })}
                </fieldset>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return commands;
  }
  return commands.filter((command) => {
    const searchable = [command.label, command.group, ...(command.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

function groupCommands(commands: PaletteCommand[]): Array<[string, PaletteCommand[]]> {
  const groups = new Map<string, PaletteCommand[]>();
  for (const command of commands) {
    const group = command.group ?? "Commands";
    const entries = groups.get(group) ?? [];
    entries.push(command);
    groups.set(group, entries);
  }
  return [...groups];
}
