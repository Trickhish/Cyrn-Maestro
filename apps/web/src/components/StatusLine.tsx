/* Never a spinner without a subject: this line always names what is happening
   now, how long it has been happening, what it has cost, and which machine and
   model are doing it. */

interface StatusLineProps {
  action: string;
  elapsed: string;
  cost: string;
  node: string;
  model: string;
  bordered?: boolean;
}

export function StatusLine({
  action,
  elapsed,
  cost,
  node,
  model,
  bordered = true,
}: StatusLineProps) {
  return (
    <div
      className={`flex items-center gap-3.5 px-[18px] py-2 font-mono text-[11px] ${
        bordered ? "border-b rule" : ""
      }`}
    >
      <span className="flex items-center gap-[7px] text-accent-hi">
        <span className="dot dot-running" />
        <span>running</span>
      </span>
      <span className="text-secondary truncate">{action}</span>
      <Sep />
      <span className="text-tertiary tnum">{elapsed}</span>
      <Sep />
      <span className="text-tertiary tnum">{cost}</span>
      <Sep />
      <span className="text-tertiary">{node}</span>
      <Sep />
      <span className="text-tertiary">{model}</span>
      <span className="flex-1" />
      <button type="button" className="btn btn-chip">
        Pause
      </button>
      <button type="button" className="btn btn-chip">
        Stop
      </button>
    </div>
  );
}

function Sep() {
  return <span className="text-fainter">·</span>;
}
