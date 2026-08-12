import { useState, type FormEvent } from "react";

/* The input stays alive while the agent works — that is the whole point, so it
   is never disabled and never swapped for a "stop" button. A message typed
   mid-run is queued and shown back as pending until the next turn boundary. */

interface ComposerProps {
  placeholder: string;
  hints: string[];
  chip?: string;
  live?: boolean;
  onSend?: (value: string) => void;
  /* Reported as it is typed so the routing chips can re-plan against the
     actual prompt rather than an empty one. */
  onChange?: (value: string) => void;
}

export function Composer({ placeholder, hints, chip, live, onSend, onChange }: ComposerProps) {
  const [value, setValue] = useState("");
  const [queued, setQueued] = useState<string[]>([]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = value.trim();
    if (!text) return;
    setQueued((q) => [...q, text]);
    setValue("");
    onSend?.(text);
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

      <form className="composer" data-live={live} onSubmit={submit}>
        {chip ? (
          <span className="font-mono text-[11px] text-accent-hi border border-[var(--border-accent)] rounded-[5px] px-[7px] py-0.5 flex-none">
            {chip}
          </span>
        ) : (
          <span className="caret-bar" />
        )}
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            onChange?.(e.target.value);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <span className="hint flex-none">⏎</span>
      </form>

      <div className="flex gap-4 flex-wrap">
        {hints.map((h) => (
          <span key={h} className="hint">
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}
