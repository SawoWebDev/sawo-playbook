'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { KanbanEditor, type Kanban } from '@/components/KanbanForm';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

export default function NewKanbanPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <NewKanban />
    </Suspense>
  );
}

/** Add Kanban; with ?copy=<id> (Duplicate) the form starts pre-filled from that card. */
function NewKanban() {
  const copyId = useSearchParams().get('copy');
  const [source, setSource] = useState<Kanban | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (copyId)
      api<Kanban>(`/kanbans/${copyId}`)
        .then(setSource)
        .catch((e) => setError(errorMessage(e)));
  }, [copyId]);

  if (error) return <div className="error">{error}</div>;
  if (copyId && !source) return <p className="muted">Loading…</p>;
  return <KanbanEditor copyFrom={source ?? undefined} />;
}
