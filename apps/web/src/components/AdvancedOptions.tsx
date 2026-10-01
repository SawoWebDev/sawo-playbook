'use client';

import { useState, type ReactNode } from 'react';
import { fmtDuration } from '@/lib/format';
import type { VersionConfig } from '@/lib/types';

interface Props {
  config: VersionConfig;
  referenceNo: string;
  raisedAt: string;
  revision: string;
  revisionDate: string | null;
  /** When set, fields become inputs and changes are reported here. */
  onChange?: (patch: Partial<VersionConfig>) => void;
  cycleTimeSeconds: number;
}

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/(\w{3}) /, '$1, ') : 'N/A';

function Chevron({ open, right }: { open: boolean; right?: boolean }) {
  // Points down when open, right (sections) or up (toggle) when closed.
  const rot = right ? (open ? 90 : 0) : open ? 0 : -90;
  return (
    <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${rot}deg)` }} aria-hidden>
      <path d={right ? 'm9 6 6 6-6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="adv-section">
      <button type="button" className="adv-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>{title}</span>
        <Chevron open={open} right />
      </button>
      {open && <div className="adv-body">{children}</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="adv-field">
      <div className="adv-label">{label}</div>
      <div className="adv-value">{children}</div>
    </div>
  );
}

function Pill({ on }: { on: boolean }) {
  return <span className={on ? 'pill pill-on' : 'pill'}>● {on ? 'On' : 'Off'}</span>;
}

function Swatch({ color }: { color: string }) {
  return (
    <span className="swatch">
      <span style={{ background: color }} />
    </span>
  );
}

export function AdvancedOptions({ config: c, referenceNo, raisedAt, revision, revisionDate, onChange, cycleTimeSeconds }: Props) {
  const [open, setOpen] = useState(false);
  const edit = !!onChange;
  const set = (patch: Partial<VersionConfig>) => onChange?.(patch);

  const text = (k: 'language' | 'border_width' | 'red_card_text' | 'video_link' | 'total_time_required', placeholder = '') =>
    edit ? <input value={c[k]} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} /> : c[k] || 'N/A';
  const choice = <K extends 'pdf_orientation' | 'header_footer_text_color' | 'red_text' | 'green_text'>(k: K, options: VersionConfig[K][]) =>
    edit ? (
      <select value={c[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<VersionConfig>)}>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    ) : (
      c[k]
    );
  const color = (k: 'header_footer_color' | 'red_bg' | 'green_bg') =>
    edit ? <input type="color" value={c[k]} onChange={(e) => set({ [k]: e.target.value })} style={{ width: 60, padding: 2 }} /> : <Swatch color={c[k]} />;
  const toggle = (k: 'full_image' | 'step_by_step_pdf' | 'is_critical', label: string) =>
    edit ? <input type="checkbox" role="switch" className="switch" aria-label={label} checked={c[k]} onChange={(e) => set({ [k]: e.target.checked })} /> : <Pill on={c[k]} />;

  return (
    <div className="adv">
      <button type="button" className="adv-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Advanced Options <Chevron open={open} right />
      </button>
      {open && (
        <>
          <Section title="Language Options">
            <Field label="Language">{text('language')}</Field>
          </Section>

          <Section title="Document Control Details">
            <div className="adv-cols4">
              <Field label="Reference Number">{referenceNo}</Field>
              <Field label="Date Raised">{fmt(raisedAt)}</Field>
              <Field label="Revision Number">{revision}</Field>
              <Field label="Revision date">{fmt(revisionDate)}</Field>
            </div>
          </Section>

          <Section title="Presentation & Formatting">
            <div className="adv-cols3">
              <div className="adv-col">
                <h4>Format</h4>
                <Field label="PDF Orientation">{choice('pdf_orientation', ['Landscape', 'Portrait'])}</Field>
                <Field label="Steps per PDF page">
                  {edit ? (
                    <input type="number" min={1} max={12} value={c.steps_per_page} onChange={(e) => set({ steps_per_page: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })} />
                  ) : (
                    c.steps_per_page
                  )}
                </Field>
                <div className="row" style={{ gap: 32, alignItems: 'flex-start' }}>
                  <Field label="Display full image on all formats">{toggle('full_image', 'Display full image on all formats')}</Field>
                  <Field label="Enable Step-by-Step View in PDF">{toggle('step_by_step_pdf', 'Enable Step-by-Step View in PDF')}</Field>
                </div>
              </div>
              <div className="adv-col">
                <h4>PDF Borders / Headers</h4>
                <div className="row" style={{ gap: 32, alignItems: 'flex-start' }}>
                  <Field label="Border width">{text('border_width')}</Field>
                  <Field label="Header Footer Color">{color('header_footer_color')}</Field>
                </div>
                <Field label="Header Footer Text Color">{choice('header_footer_text_color', ['Black', 'White'])}</Field>
                <Field label="Custom text For Red Card">{text('red_card_text')}</Field>
              </div>
              <div className="adv-col">
                <h4>Green/Red QR PDF Colors</h4>
                <div className="adv-cols2">
                  <Field label="Red PDF Background Color">{color('red_bg')}</Field>
                  <Field label="Green PDF Background Color">{color('green_bg')}</Field>
                  <Field label="Red PDF Text Color">{choice('red_text', ['White', 'Black'])}</Field>
                  <Field label="Green PDF Text Color">{choice('green_text', ['White', 'Black'])}</Field>
                </div>
              </div>
            </div>
          </Section>

          <Section title="Functional Options">
            <Field label="Is this SOP critical?">
              {edit ? toggle('is_critical', 'Is this SOP critical?') : <strong>{c.is_critical ? 'Yes' : 'No'}</strong>}
            </Field>
          </Section>

          <Section title="Additional Display Items">
            <div className="row" style={{ gap: 64, alignItems: 'flex-start' }}>
              <Field label="Video Link">{text('video_link', 'https://…')}</Field>
              <Field label="Total Time Required">
                {edit ? text('total_time_required', fmtDuration(cycleTimeSeconds)) : c.total_time_required || 'N/A'}
              </Field>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
