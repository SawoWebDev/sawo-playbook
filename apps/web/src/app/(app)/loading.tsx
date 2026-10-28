export default function Loading() {
  // Shown the moment a sidebar item is clicked, until that page's own content is ready.
  return (
    <div className="page-loading muted" role="status">
      <i className="fa-solid fa-circle-notch fa-spin" aria-hidden /> Loading…
    </div>
  );
}
