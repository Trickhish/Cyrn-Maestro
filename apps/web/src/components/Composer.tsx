import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

/* The input stays alive while the agent works — that is the whole point, so it
   is never disabled and never swapped for a "stop" button. A message typed
   mid-run is queued and shown back as pending until the next turn boundary. */

export interface SlashCommand {
  /* Without the leading slash — "clear", not "/clear". */
  name: string;
  description: string;
  run: (args: string) => void;
}

interface ComposerProps {
  placeholder: string;
  hints: string[];
  chip?: string;
  live?: boolean;
  onSend?: (value: string) => void;
  /* Reported as it is typed so the routing chips can re-plan against the
     actual prompt rather than an empty one. */
  onChange?: (value: string) => void;
  /* Slash commands. Typing "/" opens an autocomplete of these; running one
     calls its `run` instead of sending the text as a message. */
  commands?: SlashCommand[];
}

export function Composer({ placeholder, hints, chip, live, onSend, onChange, commands }: ComposerProps) {
  const [value, setValue] = useState("");
  const [queued, setQueued] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /* The menu is a thing only while a command name is being typed: value starts
     with "/" and no space has been reached yet. Once there is a space the user
     is on to arguments, so the menu gets out of the way. */
  const typingCommand = value.startsWith("/") && !value.includes(" ");
  const query = typingCommand ? value.slice(1).toLowerCase() : "";
  const matches = useMemo(
    () => (commands ?? []).filter((c) => c.name.toLowerCase().startsWith(query)),
    [commands, query],
  );
  const menuOpen = typingCommand && matches.length > 0;

  function reset() {
    setValue("");
    setActive(0);
    onChange?.("");
  }

  /* Splits "/name rest of the args" into the command and everything after it. */
  function runCommand(command: SlashCommand, raw: string) {
    const args = raw.startsWith(`/${command.name}`)
      ? raw.slice(command.name.length + 1).trim()
      : "";
    command.run(args);
    reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;

    if (text.startsWith("/") && commands?.length) {
      const name = text.slice(1).split(" ")[0].toLowerCase();
      const command = commands.find((c) => c.name.toLowerCase() === name);
      if (command) {
        runCommand(command, text);
        return;
      }
      /* An unknown slash command is not a message to the model — swallow it
         rather than dispatching "/notacommand" as a prompt. */
      if (menuOpen && matches[active]) {
        runCommand(matches[active], text);
        return;
      }
      return;
    }

    setQueued((q) => [...q, text]);
    reset();
    onSend?.(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!menuOpen) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (event.key === "Tab") {
      /* Complete the highlighted command into the input without running it,
         so arguments can be typed after it. */
      event.preventDefault();
      setValue(`/${matches[active].name} `);
      onChange?.(`/${matches[active].name} `);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setValue("");
      onChange?.("");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {queued.length > 0 && (
        <div className="flex flex-col gap-1">
          {queued.map((q, i) => (
            <div
              key={i}
              className="flex items-center gap-2 text-[12px] text-tertiary px-1"
            >
              <span className="font-mono text-[10px] text-accent-hi">queued</span>
              <span className="truncate">{q}</span>
              <span className="font-mono text-[10px] text-faint flex-none">
                delivered at the next step
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        {menuOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-1.5 border rule rounded-lg bg-raised shadow-lg overflow-hidden z-10">
            {matches.map((command, i) => (
              <button
                key={command.name}
                type="button"
                className={`w-full flex items-baseline gap-2.5 px-3 py-1.5 text-left ${
                  i === active ? "bg-inset" : ""
                }`}
                onMouseEnter={() => setActive(i)}
                /* Mouse-down, not click: click fires after the input's blur,
                   which would already have collapsed the menu. */
                onMouseDown={(e) => {
                  e.preventDefault();
                  runCommand(command, `/${command.name}`);
                  inputRef.current?.focus();
                }}
              >
                <span className="font-mono text-[12px] text-accent-hi flex-none">/{command.name}</span>
                <span className="text-[12px] text-tertiary truncate">{command.description}</span>
              </button>
            ))}
          </div>
        )}

        <form className="composer" data-live={live} onSubmit={submit}>
          {chip ? (
            <span className="font-mono text-[11px] text-accent-hi border border-[var(--border-accent)] rounded-[5px] px-[7px] py-0.5 flex-none">
              {chip}
            </span>
          ) : (
            <span className="caret-bar" />
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setActive(0);
              onChange?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
          />
          <span className="hint flex-none">⏎</span>
        </form>
      </div>

      {hints.length > 0 && (
        <div className="hidden md:flex gap-4 flex-wrap">
          {hints.map((h) => (
            <span key={h} className="hint">
              {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
