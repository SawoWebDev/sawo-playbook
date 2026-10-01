'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { KanbanEditor, type Kanban } from '@/components/KanbanForm';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

export default function EditKanbanPage() {
  const { id } = useParams<{ id: string }>();
  const [kanban, setKanban] = useState<Kanban | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Kanban>(`/kanbans/${id}`)
      .then(setKanban)
      .catch((e) => setError(errorMessage(e)));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!kanban) return <p className="muted">Loading…</p>;
  return <KanbanEditor kanban={kanban} />;
}
