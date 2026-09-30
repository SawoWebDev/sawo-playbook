'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RichTextEditor } from '@/components/RichTextEditor';
import { api, apiRaw } from '@/lib/api';
import { buildTree, flatten, type FolderRow } from '@/lib/folders';
import { errorMessage, fmtDuration, plural } from '@/lib/format';
import type { MediaItem, SopDetail, SopListItem, VersionConfig, VersionDetail } from '@/lib/types';

interface DraftStep {
  key: string;
  id?: string;
  title: string;
  description: string;
  isTextOnly: boolean;
  isCritical: boolean;
  usesOkNotokMedia: boolean;
  plannedTimeSeconds: number;
  linkedSopId: string;
  media: MediaItem[];
}

let keySeq = 0;
const newKey = () => `k${++keySeq}`;

function emptyStep(): DraftStep {
  return {
    key: newKey(),
    title: '',
    description: '',
    isTextOnly: false,
    isCritical: false,
    usesOkNotokMedia: false,
    plannedTimeSeconds: 0,
    linkedSopId: '',
    media: [],
  };
}

const CONFIG_LABELS: [keyof VersionConfig, string][] = [
  ['cover_sheet', 'Cover sheet'],
  ['collaborate', 'Collaborate'],
  ['checklist_sop', 'Checklist SOP'],
  ['key_points_enabled', 'Key points'],
];

export default function SopEditorPage() {
  const { id, vid } = useParams<{ id: string; vid: string }>();
  const router = useRouter();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [name, setName] = useState('');
  const [referenceNo, setReferenceNo] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [config, setConfig] = useState<VersionConfig | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [linkable, setLinkable] = useState<SopListItem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const [s, v, pub, fl] = await Promise.all([
        api<SopDetail>(`/sops/${id}`),
        api<VersionDetail>(`/sops/${id}/versions/${vid}`),
        api<{ items: SopListItem[] }>('/sops?status=published&limit=200'),
        api<FolderRow[]>('/folders'),
      ]);
      setFolders(fl);
      setFolderId(s.folder?.id ?? '');
      setSop(s);
      setVersion(v);
      setName(s.name);
      setReferenceNo(s.referenceNo);
      setConfig(v.config);
      setChangeSummary(v.changeSummary ?? '');
      setSteps(
        v.steps.map((st) => ({
          key: newKey(),
          id: st.id,
          title: st.title ?? '',
          description: st.description,
          isTextOnly: st.isTextOnly,
          isCritical: st.isCritical,
          usesOkNotokMedia: st.usesOkNotokMedia,
          plannedTimeSeconds: st.plannedTimeSeconds,
          linkedSopId: st.linkedSop?.id ?? '',
          media: st.media,
        })),
      );
      setLinkable(pub.items.filter((x) => x.id !== id));
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, vid]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (key: string, patch: Partial<DraftStep>) => {
    setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    setDirty(true);
  };

  const move = (idx: number, delta: number) => {
    setSteps((all) => {
      const next = [...all];
      const [item] = next.splice(idx, 1);
      next.splice(Math.max(0, Math.min(next.length, idx + delta)), 0, item);
      return next;
    });
    setDirty(true);
  };

  async function uploadTo(key: string, files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    for (const f of Array.from(files)) {
      const form = new FormData();
      form.append('file', f);
      const res = await apiRaw('/media', { method: 'POST', rawBody: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`${f.name}: ${body.message ?? 'upload failed'}`);
        continue;
      }
      setSteps((all) => all.map((s) => (s.key === key ? { ...s, media: [...s.media, body as MediaItem] } : s)));
      setDirty(true);
    }
  }

  async function save(): Promise<boolean> {
    if (!sop || !config) return false;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (name !== sop.name || referenceNo !== sop.referenceNo || folderId !== (sop.folder?.id ?? '')) {
        await api(`/sops/${id}`, { method: 'PATCH', body: { name, referenceNo, folderId: folderId || null } });
      }
      await api(`/sops/${id}/versions/${vid}`, { method: 'PATCH', body: { config, changeSummary } });
      await api(`/sops/${id}/versions/${vid}/steps`, {
        method: 'PUT',
        body: {
          steps: steps.map((s) => ({
            id: s.id,
            title: s.title || null,
            description: s.description,
            isTextOnly: s.isTextOnly,
            isCritical: s.isCritical,
            usesOkNotokMedia: s.usesOkNotokMedia,
            plannedTimeSeconds: s.plannedTimeSeconds,
            linkedSopId: s.linkedSopId || null,
            media: s.media.map((m) => ({ mediaAssetId: m.id })),
          })),
        },
      });
      await load();
      setNotice('Saved.');
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  if (error && !version) return <div className="error">{error}</div>;
  if (!sop || !version || !config) return <p className="muted">Loading…</p>;
  if (version.lifecycleState !== 'DRAFT') {
    return (
      <div className="card">
        <p>
          Version {version.label} is {version.lifecycleState.toLowerCase().replace('_', ' ')} and can no longer be edited.
        </p>
        <Link href={`/sops/${id}?v=${vid}`}>Back to SOP</Link>
      </div>
    );
  }

  const isAdvanced = sop.type === 'advanced';
  const cycle = steps.reduce((sum, s) => sum + (s.plannedTimeSeconds || 0), 0);

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link href={`/sops/${id}?v=${vid}`} className="muted">
          ← Back to SOP
        </Link>
        <div className="spacer" />
        <span className="muted">
          Editing v{version.label} (draft){dirty ? ' · unsaved changes' : ''}
        </span>
        <button className="btn" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={async () => {
            if (await save()) router.push(`/sops/${id}?v=${vid}`);
          }}
        >
          Save & close
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="success">{notice}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="grid" style={{ gridTemplateColumns: '2fr 1fr' }}>
          <div className="field">
            <label htmlFor="name">Procedure name</label>
            <input
              id="name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="ref">Reference No.</label>
            <input
              id="ref"
              value={referenceNo}
              onChange={(e) => {
                setReferenceNo(e.target.value);
                setDirty(true);
              }}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="folder">Folder</label>
          <select
            id="folder"
            value={folderId}
            onChange={(e) => {
              setFolderId(e.target.value);
              setDirty(true);
            }}
            style={{ maxWidth: 320 }}
          >
            <option value="">(none)</option>
            {flatten(buildTree(folders)).map((f) => (
              <option key={f.id} value={f.id}>
                {'  '.repeat(f.depth)}
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="toggle-row" style={{ marginBottom: 12 }}>
          {CONFIG_LABELS.map(([k, label]) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={config[k]}
                onChange={(e) => {
                  setConfig({ ...config, [k]: e.target.checked });
                  setDirty(true);
                }}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="cs">Change summary</label>
          <input
            id="cs"
            placeholder="What changed in this version?"
            value={changeSummary}
            onChange={(e) => {
              setChangeSummary(e.target.value);
              setDirty(true);
            }}
          />
        </div>
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Steps</h2>
        <span className="badge">{plural(steps.length, 'step')}</span>
        <span className="badge">Cycle time {fmtDuration(cycle)}</span>
      </div>

      <div className="panel">
        {steps.map((s, idx) => (
          <div key={s.key} className={`editor-step${s.isCritical ? ' critical' : ''}`}>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="step-num">{idx + 1}</span>
              {isAdvanced && (
                <input placeholder="Step title" value={s.title} onChange={(e) => update(s.key, { title: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
              )}
              <div className="spacer" />
              <label className="row" style={{ fontWeight: 400, margin: 0, gap: 4 }}>
                Planned time (s)
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={s.plannedTimeSeconds}
                  onChange={(e) => update(s.key, { plannedTimeSeconds: Math.max(0, Number(e.target.value) || 0) })}
                  style={{ width: 90 }}
                />
              </label>
              <button className="btn btn-sm" disabled={idx === 0} onClick={() => move(idx, -1)} title="Move up">
                ↑
              </button>
              <button className="btn btn-sm" disabled={idx === steps.length - 1} onClick={() => move(idx, 1)} title="Move down">
                ↓
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  setSteps((all) => all.filter((x) => x.key !== s.key));
                  setDirty(true);
                }}
              >
                Delete
              </button>
            </div>

            <RichTextEditor value={s.description} onChange={(html) => update(s.key, { description: html })} placeholder="Describe this step…" />

            <div className="toggle-row" style={{ margin: '8px 0' }}>
              <label>
                <input type="checkbox" checked={s.isCritical} onChange={(e) => update(s.key, { isCritical: e.target.checked })} /> Critical step
              </label>
              <label>
                <input type="checkbox" checked={s.isTextOnly} onChange={(e) => update(s.key, { isTextOnly: e.target.checked })} /> Text only
              </label>
              <label>
                <input type="checkbox" checked={s.usesOkNotokMedia} onChange={(e) => update(s.key, { usesOkNotokMedia: e.target.checked })} /> OK / NOT OK media
              </label>
              <label>
                Link SOP
                <select value={s.linkedSopId} onChange={(e) => update(s.key, { linkedSopId: e.target.value })} style={{ width: 220 }}>
                  <option value="">— none —</option>
                  {linkable.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.referenceNo} — {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {!s.isTextOnly && (
              <div className="row" style={{ alignItems: 'flex-start' }}>
                {s.media.map((m, mi) => (
                  <div key={m.id} className="thumb">
                    {s.usesOkNotokMedia && (
                      <span className={`badge ${mi === 0 ? 'badge-green' : 'badge-red'}`} style={{ position: 'absolute', left: 4, top: 4 }}>
                        {mi === 0 ? 'OK' : 'NOT OK'}
                      </span>
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.type === 'image' ? <img src={m.url} alt={m.originalFilename} /> : <span className="badge">{m.originalFilename}</span>}
                    <button type="button" onClick={() => update(s.key, { media: s.media.filter((x) => x.id !== m.id) })}>
                      ✕
                    </button>
                  </div>
                ))}
                <input
                  ref={(el) => {
                    fileInputs.current[s.key] = el;
                  }}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                  multiple
                  hidden
                  onChange={(e) => {
                    void uploadTo(s.key, e.target.files);
                    e.target.value = '';
                  }}
                />
                <button type="button" className="btn btn-sm" onClick={() => fileInputs.current[s.key]?.click()}>
                  + Add image
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <button
        className="btn"
        style={{ marginTop: 12 }}
        onClick={() => {
          setSteps((all) => [...all, emptyStep()]);
          setDirty(true);
        }}
      >
        + Add step
      </button>
    </>
  );
}
