export function ComingSoon({ title, phase, text }: { title: string; phase: string; text: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="card">
        <p style={{ marginTop: 0 }}>{text}</p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Scheduled for {phase} of the build plan.
        </p>
      </div>
    </>
  );
}
