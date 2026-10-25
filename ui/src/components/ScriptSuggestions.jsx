/**
 * The commands a directory says it starts with, one click each: the scripts its package.json
 * declares, then the usual start commands of whatever stack it is built on. Shared by the process
 * form and the setup wizard's first application, which ask the same question of the same directory.
 */

/**
 * The scripts the chosen directory actually declares, one click each. What gets filled in is the
 * long form — `pnpm run dev`, never `pnpm dev` — because a script named after a built-in subcommand
 * is the one case the shorthand silently runs something else.
 * @param {{loading: boolean, inspection: object|null, onPick: (command: string) => void}} props
 */
export default function ScriptSuggestions({ loading, inspection, onPick }) {
  if (loading) return <p className="hint">Reading the directory…</p>;
  if (!inspection) return null;
  const stacks = inspection.stacks ?? [];
  if (!inspection.scripts.length && !stacks.length) {
    return <p className="hint">Nothing in this directory says how it starts.</p>;
  }

  return (
    <>
      {inspection.scripts.length > 0 && (
        <div className="suggestions">
          <p className="hint">
            {inspection.packageName ?? 'package.json'} — {inspection.packageManager}
          </p>
          <div className="chips">
            {inspection.scripts.map((script) => (
              <button
                key={script.name}
                type="button"
                className="chip mono"
                title={script.script}
                onClick={() => onPick(script.command)}
              >
                {script.command}
              </button>
            ))}
          </div>
        </div>
      )}
      <StackSuggestions stacks={stacks} onPick={onPick} />
    </>
  );
}

const stackName = (stack) => [stack.label, ...stack.details].join(' · ');

/**
 * What the directory is built on, and the commands that usually start it — inferred from its
 * manifests rather than declared by its author, so each one says why it is offered on hover.
 * @param {{stacks: object[], onPick: (command: string) => void}} props
 */
function StackSuggestions({ stacks, onPick }) {
  if (!stacks.length) return null;
  const suggestions = stacks.flatMap((stack) => stack.suggestions);
  const notes = stacks.flatMap((stack) => stack.notes);

  return (
    <div className="suggestions">
      <p className="hint" title={stacks.flatMap((stack) => stack.evidence).join(', ')}>
        Detected: {stacks.map(stackName).join(', ')}
      </p>
      {suggestions.length > 0 && (
        <div className="chips">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.command}
              type="button"
              className="chip mono"
              title={suggestion.reason}
              onClick={() => onPick(suggestion.command)}
            >
              {suggestion.command}
            </button>
          ))}
        </div>
      )}
      {notes.map((note) => (
        <p className="hint" key={note}>
          {note}
        </p>
      ))}
    </div>
  );
}
