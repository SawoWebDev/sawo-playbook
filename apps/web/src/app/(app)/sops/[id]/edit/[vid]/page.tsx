'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { plainTextLength, RichTextEditor } from '@/components/RichTextEditor';
import { api, apiRaw } from '@/lib/api';
import { buildTree, flatten, type FolderRow } from '@/lib/folders';
import { errorMessage, fmtDuration, plural } from '@/lib/format';
import { AdvancedOptions } from '@/components/AdvancedOptions';
import { Lightbox, type LightboxImage } from '@/components/Lightbox';
import type { MediaItem, SopDetail, SopListItem, SopType, VersionConfig, VersionDetail } from '@/lib/types';

const NAME_MAX = 100;
const DESC_MAX = 400;
const DESC_OPTIMAL = 120;

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
  linkEnabled: boolean;
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
    linkEnabled: false,
    media: [],
  };
}

/** Seconds → "HH:MM:SS" (empty for 0 so the placeholder shows). */
function toHms(total: number): string {
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** "HH:MM:SS" / "MM:SS" / "SS" → seconds, or null when invalid. */
function fromHms(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d{1,2}(:\d{1,2}){0,2}$/.test(t)) return null;
  const parts = t.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, s] = parts;
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s;
}

function Info({ tip }: { tip: string }) {
  return (
    <span className="info-dot" title={tip} aria-label={tip}>
      i
    </span>
  );
}

function Switch({ label, checked, onChange, tip }: { label: string; checked: boolean; onChange: (v: boolean) => void; tip?: string }) {
  return (
    <label className="switch-row">
      <input type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span>{label}</span>
      {tip && <Info tip={tip} />}
    </label>
  );
}

function TimeInput({ seconds, onChange, id }: { seconds: number; onChange: (s: number) => void; id: string }) {
  const [text, setText] = useState(toHms(seconds));
  const [bad, setBad] = useState(false);
  useEffect(() => setText(toHms(seconds)), [seconds]);
  return (
    <input
      id={id}
      className={`time-input${bad ? ' invalid' : ''}`}
      placeholder="HH:MM:SS"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        setBad(fromHms(e.target.value) === null);
      }}
      onBlur={() => {
        const v = fromHms(text);
        if (v === null) return;
        onChange(v);
        setText(toHms(v));
      }}
    />
  );
}

export default function SopEditorPage() {
  const { id, vid } = useParams<{ id: string; vid: string }>();
  const router = useRouter();
  const [sop, setSop] = useState<SopDetail | null>(null);
  const [version, setVersion] = useState<VersionDetail | null>(null);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<SopType>('standard');
  const [referenceNo, setReferenceNo] = useState('');
  const [folderId, setFolderId] = useState('');
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [config, setConfig] = useState<VersionConfig | null>(null);
  const [changeSummary, setChangeSummary] = useState('');
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [linkable, setLinkable] = useState<SopListItem[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [popup, setPopup] = useState<{ images: LightboxImage[]; start: number } | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const load = useCallback(async () => {
    try {
      const [s, v, pub, fl, org] = await Promise.all([
        api<SopDetail>(`/sops/${id}`),
        api<VersionDetail>(`/sops/${id}/versions/${vid}`),
        api<{ items: SopListItem[] }>('/sops?status=published&limit=200'),
        api<FolderRow[]>('/folders'),
        api<{ settings: { approvalRequired: boolean } }>('/organization'),
      ]);
      setApprovalRequired(org.settings.approvalRequired);
      setFolders(fl);
      setFolderId(s.folder?.id ?? '');
      setSop(s);
      setType(s.type);
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
          linkEnabled: !!st.linkedSop,
          media: st.media,
        })),
      );
      setLinkable(pub.items.filter((x) => x.id !== id));
      setSelected(new Set());
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

  const touch = () => {
    setDirty(true);
    setNotice(null);
  };

  const update = (key: string, patch: Partial<DraftStep>) => {
    setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...patch } : s)));
    touch();
  };

  const move = (idx: number, delta: number) => {
    setSteps((all) => {
      const next = [...all];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return all;
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
    touch();
  };

  const insertAfter = (idx: number) => {
    setSteps((all) => [...all.slice(0, idx + 1), emptyStep(), ...all.slice(idx + 1)]);
    touch();
  };

  const removeSteps = (keys: Set<string>) => {
    setSteps((all) => all.filter((s) => !keys.has(s.key)));
    setSelected(new Set());
    touch();
  };

  async function uploadTo(key: string, files: FileList | File[] | null, replaceId?: string) {
    if (!files || !files.length) return;
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
      setSteps((all) =>
        all.map((s) =>
          s.key !== key
            ? s
            : { ...s, media: replaceId ? s.media.map((m) => (m.id === replaceId ? (body as MediaItem) : m)) : [...s.media, body as MediaItem] },
        ),
      );
      touch();
    }
  }

  function validate(): string | null {
    if (!name.trim()) return 'Procedure name is required';
    for (const [i, s] of steps.entries()) {
      if (plainTextLength(s.description) > DESC_MAX) return `Step ${i + 1}: description is longer than ${DESC_MAX} characters`;
      if (s.linkEnabled && !s.linkedSopId) return `Step ${i + 1}: choose the SOP to link, or switch the link off`;
    }
    return null;
  }

  async function save(): Promise<boolean> {
    if (!sop || !config) return false;
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return false;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      if (name !== sop.name || referenceNo !== sop.referenceNo || folderId !== (sop.folder?.id ?? '') || type !== sop.type) {
        await api(`/sops/${id}`, { method: 'PATCH', body: { name, referenceNo, folderId: folderId || null, type } });
      }
      await api(`/sops/${id}/versions/${vid}`, { method: 'PATCH', body: { config, changeSummary } });
      await api(`/sops/${id}/versions/${vid}/steps`, {
        method: 'PUT',
        body: {
          steps: steps.map((s) => ({
            id: s.id,
            title: type === 'advanced' ? s.title || null : null,
            description: s.description,
            isTextOnly: s.isTextOnly,
            isCritical: s.isCritical,
            usesOkNotokMedia: s.usesOkNotokMedia,
            plannedTimeSeconds: s.plannedTimeSeconds,
            linkedSopId: s.linkEnabled ? s.linkedSopId || null : null,
            media: s.isTextOnly ? [] : s.media.map((m) => ({ mediaAssetId: m.id })),
          })),
        },
      });
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveDraft() {
    if (await save()) setNotice('Draft saved.');
  }

  async function finishAndSave() {
    if (!(await save())) return;
    if (steps.length === 0) {
      setError('Add at least one step before finishing');
      return;
    }
    setSaving(true);
    try {
      if (approvalRequired) {
        await api(`/sops/${id}/versions/${vid}/submit`, { method: 'POST', body: { changeSummary: changeSummary || undefined } });
      } else {
        await api(`/sops/${id}/versions/${vid}/finish`, { method: 'POST', body: { changeSummary: changeSummary || undefined } });
      }
      router.push(`/sops/${id}`);
    } catch (e) {
      setError(errorMessage(e));
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

  const isAdvanced = type === 'advanced';
  const cycle = steps.reduce((sum, s) => sum + (s.plannedTimeSeconds || 0), 0);
  const setCfg = (k: keyof VersionConfig) => (v: boolean) => {
    setConfig({ ...config, [k]: v });
    touch();
  };

  return (
    <div className="sop-editor">
      <div className="editor-head">
        <Link
          href="/sops"
          className="back-btn"
          onClick={(e) => {
            if (dirty && !confirm('Discard unsaved changes?')) e.preventDefault();
          }}
        >
          <span className="back-chev">‹</span> Back
        </Link>
        <strong>Edit {isAdvanced ? 'Advanced' : 'Standard'} Operation</strong>
        <Info tip="Changes are saved as a draft version. The published version stays unchanged until you Finish & Save." />
        <span className="muted editor-status">
          v{version.label} draft{dirty ? ' · unsaved changes' : ''}
        </span>
        <div className="spacer" />
        <button
          type="button"
          className="btn-link"
          disabled={saving}
          onClick={() => {
            if (!dirty || confirm('Discard unsaved changes?')) router.push(`/sops/${id}`);
          }}
        >
          Cancel
        </button>
        <button type="button" className="btn btn-warning" disabled={saving} onClick={saveDraft}>
          {saving ? 'Saving…' : 'Save As Draft'}
        </button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={finishAndSave}>
          {approvalRequired ? 'Finish & Submit' : 'Finish & Save'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {popup && <Lightbox images={popup.images} start={popup.start} onClose={() => setPopup(null)} />}
      {notice && <div className="success">{notice}</div>}

      <div className="editor-section">
        <div className="name-label">
          <label htmlFor="name">Procedure Name</label>
          <span className="muted">
            {name.length}/{NAME_MAX}
          </span>
        </div>
        <div className="name-field">
          <input
            id="name"
            maxLength={NAME_MAX}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              touch();
            }}
          />
          {name.trim() && !dirty && <span className="name-ok" aria-label="Saved">✓</span>}
        </div>
      </div>

      <div className="editor-section">
        <div className="section-title">SOP Configuration</div>
        <div className="muted section-sub">Choose the SOP type and publishing options before adding steps.</div>
        <div className="config-grid">
          <div className="config-cell">
            <div className="config-title">Cover Sheet</div>
            <div className="muted config-desc">Include a cover sheet as the first page of the SOP.</div>
            <input type="checkbox" role="switch" className="switch" aria-label="Cover Sheet" checked={config.cover_sheet} onChange={(e) => setCfg('cover_sheet')(e.target.checked)} />
          </div>
          <div className="config-cell">
            <div className="config-title">Checklist SOP</div>
            <div className="muted config-desc">Capture data while operators complete the SOP.</div>
            <input type="checkbox" role="switch" className="switch" aria-label="Checklist SOP" checked={config.checklist_sop} onChange={(e) => setCfg('checklist_sop')(e.target.checked)} />
          </div>
          <div className="config-cell">
            <div className="config-title">
              Advanced SOP <Info tip="Adds a title to every step." />
            </div>
            <div className="muted config-desc">For complex procedures with additional controls and logic.</div>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              aria-label="Advanced SOP"
              checked={isAdvanced}
              onChange={(e) => {
                setType(e.target.checked ? 'advanced' : 'standard');
                touch();
              }}
            />
          </div>
        </div>

        <button type="button" className="btn-link advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
          Advanced Options <Info tip="Reference number, folder, key points and change summary." /> {showAdvanced ? '⌄' : '›'}
        </button>
        {showAdvanced && (
          <div className="advanced-grid">
            <div className="field">
              <label htmlFor="ref">Reference No.</label>
              <input
                id="ref"
                value={referenceNo}
                onChange={(e) => {
                  setReferenceNo(e.target.value);
                  touch();
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="folder">Folder</label>
              <select
                id="folder"
                value={folderId}
                onChange={(e) => {
                  setFolderId(e.target.value);
                  touch();
                }}
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
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="cs">Change summary</label>
              <input
                id="cs"
                placeholder="What changed in this version?"
                value={changeSummary}
                onChange={(e) => {
                  setChangeSummary(e.target.value);
                  touch();
                }}
              />
            </div>
            <div className="row" style={{ gridColumn: '1 / -1', gap: 24 }}>
              <Switch label="Key points" checked={config.key_points_enabled} onChange={setCfg('key_points_enabled')} />
              <Switch label="Collaborate" checked={config.collaborate} onChange={setCfg('collaborate')} />
            </div>
          </div>
        )}
      </div>

      <AdvancedOptions
        config={config}
        referenceNo={referenceNo}
        raisedAt={sop.createdAt}
        revision={version.label}
        revisionDate={version.createdAt}
        cycleTimeSeconds={cycle}
        onChange={(patch) => {
          setConfig({ ...config, ...patch });
          touch();
        }}
      />

      <div className="steps-head">
        <strong>Add Steps in to the procedure</strong>
        <span className="menu">
          <button type="button" className="btn-link" onClick={() => setMoreOpen((o) => !o)}>
            More Options ›
          </button>
          {moreOpen && (
            <div className="menu-list" style={{ left: 0, right: 'auto' }} onMouseLeave={() => setMoreOpen(false)}>
              <button type="button" onClick={() => (setSelected(new Set(steps.map((s) => s.key))), setMoreOpen(false))}>
                Select all steps
              </button>
              <button type="button" onClick={() => (setSelected(new Set()), setMoreOpen(false))}>
                Clear selection
              </button>
              <button
                type="button"
                disabled={!selected.size}
                onClick={() => {
                  setSteps((all) => all.map((s) => (selected.has(s.key) ? { ...s, isCritical: true } : s)));
                  touch();
                  setMoreOpen(false);
                }}
              >
                Mark selected as critical
              </button>
              <button
                type="button"
                disabled={!selected.size}
                onClick={() => {
                  if (confirm(`Delete ${plural(selected.size, 'selected step')}?`)) removeSteps(selected);
                  setMoreOpen(false);
                }}
              >
                Delete selected steps
              </button>
            </div>
          )}
        </span>
        <div className="spacer" />
        <span className="badge">{plural(steps.length, 'step')}</span>
        <span className="badge">Cycle time {fmtDuration(cycle)}</span>
      </div>

      {steps.map((s, idx) => {
        const count = plainTextLength(s.description);
        const primary = s.media[0];
        const showImage = (m: MediaItem) => {
          const imgs = s.media.filter((x) => x.type === 'image');
          setPopup({ images: imgs.map((x) => ({ url: x.url, alt: x.originalFilename })), start: Math.max(0, imgs.indexOf(m)) });
        };
        return (
          <div key={s.key}>
            <div className={`editor-step${s.isCritical ? ' critical' : ''}`}>
              <div className="step-top">
                <label className="step-label">
                  <input
                    type="checkbox"
                    checked={selected.has(s.key)}
                    onChange={(e) =>
                      setSelected((cur) => {
                        const n = new Set(cur);
                        if (e.target.checked) n.add(s.key);
                        else n.delete(s.key);
                        return n;
                      })
                    }
                    aria-label={`Select step ${idx + 1}`}
                  />
                  STEP {idx + 1}
                </label>
                <Info tip="Each step is shown to operators in order. Critical steps are highlighted in red." />
                <div className="spacer" />
                <label className="time-label" htmlFor={`time-${s.key}`}>
                  Planned Time <Info tip="Hours:minutes:seconds. The SOP cycle time is the sum of all steps." />
                </label>
                <TimeInput id={`time-${s.key}`} seconds={s.plannedTimeSeconds} onChange={(v) => update(s.key, { plannedTimeSeconds: v })} />
                <button type="button" className="icon-btn danger" title="Delete step" aria-label={`Delete step ${idx + 1}`} onClick={() => removeSteps(new Set([s.key]))}>
                  🗑
                </button>
              </div>

              <div className="step-grid">
                <div className="step-media">
                  <div className="col-label">Photo / Video</div>
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
                  {s.isTextOnly ? (
                    <div className="media-empty muted">Text only step — no photo</div>
                  ) : primary ? (
                    <>
                      <div className="media-main thumb">
                        {s.usesOkNotokMedia && <span className="badge badge-green ok-tag">OK</span>}
                        {primary.type === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={primary.url} alt={primary.originalFilename} className="zoomable" title="Click to enlarge" onClick={() => showImage(primary)} />
                        ) : (
                          <a href={primary.url} target="_blank" rel="noreferrer" className="media-file">
                            📄 {primary.originalFilename}
                          </a>
                        )}
                        <div className="media-tools">
                          {primary.type === 'image' ? (
                            <button type="button" className="icon-btn" title="View" aria-label="View" onClick={() => showImage(primary)}>
                              ⤢
                            </button>
                          ) : (
                            <a className="icon-btn" href={primary.url} target="_blank" rel="noreferrer" title="Open" aria-label="Open">
                              ✎
                            </a>
                          )}
                          <label className="icon-btn" title="Replace" aria-label="Replace">
                            ⟳
                            <input
                              type="file"
                              hidden
                              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                              onChange={(e) => {
                                void uploadTo(s.key, e.target.files, primary.id);
                                e.target.value = '';
                              }}
                            />
                          </label>
                          <button type="button" className="icon-btn danger" title="Remove" aria-label="Remove" onClick={() => update(s.key, { media: s.media.slice(1) })}>
                            🗑
                          </button>
                        </div>
                      </div>
                      <div className="media-strip">
                        {s.media.slice(1).map((m, mi) => (
                          <div key={m.id} className="thumb small">
                            {s.usesOkNotokMedia && mi === 0 && <span className="badge badge-red ok-tag">NOT OK</span>}
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {m.type === 'image' ? <img src={m.url} alt={m.originalFilename} className="zoomable" title="Click to enlarge" onClick={() => showImage(m)} /> : <span className="badge">{m.originalFilename}</span>}
                            <button type="button" aria-label="Remove image" onClick={() => update(s.key, { media: s.media.filter((x) => x.id !== m.id) })}>
                              ✕
                            </button>
                          </div>
                        ))}
                        <button type="button" className="btn btn-sm" onClick={() => fileInputs.current[s.key]?.click()}>
                          + Add image
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="media-drop"
                      onClick={() => fileInputs.current[s.key]?.click()}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void uploadTo(s.key, Array.from(e.dataTransfer.files));
                      }}
                    >
                      <span className="media-drop-icon">＋</span>
                      <span>Add photo</span>
                      <span className="muted">or drop an image here</span>
                    </button>
                  )}
                </div>

                <div className="step-desc">
                  <div className="col-label">Description</div>
                  {isAdvanced && (
                    <input
                      className="step-title"
                      placeholder="Step title"
                      value={s.title}
                      onChange={(e) => update(s.key, { title: e.target.value })}
                    />
                  )}
                  <div className="desc-box">
                    <RichTextEditor
                      value={s.description}
                      onChange={(html) => update(s.key, { description: html })}
                      placeholder="Describe this step…"
                      ariaLabel={`Step ${idx + 1} description`}
                    />
                    <div className="desc-foot">
                      <span className={`desc-count${count > DESC_MAX ? ' over' : ''}`}>{count}</span>
                      {count > DESC_OPTIMAL && count <= DESC_MAX && (
                        <div className="desc-warn">more characters may make the text appear less than optimal in some PDF formats</div>
                      )}
                      {count > DESC_MAX && <div className="desc-error">Descriptions can be at most {DESC_MAX} characters.</div>}
                      <div className="desc-help">
                        This field allows you to enter up to {DESC_MAX} characters for a process description.
                        <br />
                        However, for optimal display, we recommend &lt;120 characters for 6 step PDFs, &lt;200 for 4 steps, &lt;400 for 1 and 2 steps.
                      </div>
                    </div>
                  </div>
                </div>

                <div className="step-options">
                  <Switch label="Text Only Step" tip="The step has no photo or video." checked={s.isTextOnly} onChange={(v) => update(s.key, { isTextOnly: v })} />
                  <Switch
                    label="Use OK/Not OK Images/Videos in this step?"
                    tip="First image is shown as OK, the second as NOT OK."
                    checked={s.usesOkNotokMedia}
                    onChange={(v) => update(s.key, { usesOkNotokMedia: v })}
                  />
                  <Switch label="Is this step critical?" tip="Critical steps are highlighted for operators." checked={s.isCritical} onChange={(v) => update(s.key, { isCritical: v })} />
                  <Switch
                    label="Is this step linked to another SOP?"
                    tip="Operators get a link to the related SOP."
                    checked={s.linkEnabled}
                    onChange={(v) => update(s.key, { linkEnabled: v, linkedSopId: v ? s.linkedSopId : '' })}
                  />
                  {s.linkEnabled && (
                    <select aria-label={`Step ${idx + 1} linked SOP`} value={s.linkedSopId} onChange={(e) => update(s.key, { linkedSopId: e.target.value })}>
                      <option value="">Choose SOP…</option>
                      {linkable.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.referenceNo} — {l.name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </div>

            <div className="step-actions">
              <button type="button" className="btn-link" disabled={idx === steps.length - 1} onClick={() => move(idx, 1)}>
                ↓ Move Down
              </button>
              <button type="button" className="btn-link" onClick={() => insertAfter(idx)}>
                + Insert Step
              </button>
              <button type="button" className="btn-link" disabled={idx === 0} onClick={() => move(idx, -1)}>
                ↑ Move Up
              </button>
            </div>
          </div>
        );
      })}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 8 }}
        onClick={() => {
          setSteps((all) => [...all, emptyStep()]);
          touch();
        }}
      >
        + Add New Step
      </button>
    </div>
  );
}
