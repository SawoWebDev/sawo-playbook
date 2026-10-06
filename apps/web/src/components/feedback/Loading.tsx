/** Inline loading line for a section that is fetching. Keeps the page's layout while data arrives. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted loading-line" role="status">
      <span className="spinner" aria-hidden />
      {label}
    </p>
  );
}
