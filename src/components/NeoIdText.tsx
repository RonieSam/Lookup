/**
 * Renders a Neo ID with its digits in the accent colour, so the
 * letter-digit-letter-digit rhythm is visible at a glance.
 */
export function NeoIdText({ id }: { id: string }) {
  return (
    <span className="neo" translate="no">
      {[...id].map((ch, i) => (
        <span key={i} className={/[0-9]/.test(ch) ? "neo-d" : undefined}>
          {ch}
        </span>
      ))}
    </span>
  );
}
