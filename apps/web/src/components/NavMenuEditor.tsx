'use client';

import { useState } from 'react';
import { useToast } from '@/components/feedback/Toast';
import { applyNavConfig, NAV_CONFIG_EVENT, SECTIONS, type NavConfig } from '@/components/nav-model';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/format';

const SECTIONS_EDITABLE = SECTIONS.filter((s) => s.customizable);

/** The saved menu laid out as the sidebar shows it, but with the hidden items kept in place so they can be switched back on. */
function layout(cfg: NavConfig | null) {
  const hidden = new Set(cfg?.hidden ?? []);
  const lists = SECTIONS_EDITABLE.map((s) => {
    const shown = applyNavConfig(s, cfg).map((i) => i.href);
    const rest = s.items.map((i) => i.href).filter((h) => !shown.includes(h));
    return { key: s.key, hrefs: [...shown, ...rest] };
  });
  return { lists, hidden };
}

/** Organization settings > "Sidebar menu": reorder the Work / Review items and choose which ones are shown. */
export function NavMenuEditor({ saved, onSaved }: { saved: NavConfig | null; onSaved: (cfg: NavConfig | null) => void }) {
  const toast = useToast();
  const init = layout(saved);
  const [lists, setLists] = useState(init.lists);
  const [hidden, setHidden] = useState(init.hidden);
  const [busy, setBusy] = useState(false);

  const itemOf = (href: string) => SECTIONS_EDITABLE.flatMap((s) => s.items).find((i) => i.href === href)!;
  const move = (section: string, index: number, by: -1 | 1) =>
    setLists((all) =>
      all.map((l) => {
        if (l.key !== section) return l;
        const next = [...l.hrefs];
        const j = index + by;
        if (j < 0 || j >= next.length) return l;
        [next[index], next[j]] = [next[j], next[index]];
        return { ...l, hrefs: next };
      }),
    );
  const toggle = (href: string, show: boolean) =>
    setHidden((h) => {
      const n = new Set(h);
      if (show) n.delete(href);
      else n.add(href);
      return n;
    });

  async function send(cfg: NavConfig | null, ok: string) {
    setBusy(true);
    try {
      await api('/organization/settings', { method: 'PATCH', body: { navConfig: cfg } });
      onSaved(cfg);
      window.dispatchEvent(new Event(NAV_CONFIG_EVENT));
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const current = (): NavConfig => ({ order: lists.flatMap((l) => l.hrefs), hidden: [...hidden] });

  return (
    <div className="card org-card">
      <div className="pf-card-head">
        <span className="kpi-icon"><i className="fa-solid fa-bars-staggered" aria-hidden /></span>
        <div>
          <h3>Sidebar menu</h3>
          <p className="muted">Choose which items appear in the sidebar and in what order.</p>
        </div>
      </div>
      <p className="muted org-note">
        Switch an item on again at any time. This hides the menu link only: people can still open the page by its address, and their permissions are unchanged.
        The Administration items always stay visible.
      </p>
      {lists.map((l) => (
        <div key={l.key} className="navedit-group">
          <div className="navedit-label">{SECTIONS_EDITABLE.find((s) => s.key === l.key)!.label}</div>
          {l.hrefs.map((href, i) => {
            const item = itemOf(href);
            const shown = !hidden.has(href);
            return (
              <div key={href} className={`navedit-row${shown ? '' : ' is-off'}`}>
                <i className={`fa-solid ${item.icon} navedit-icon`} aria-hidden />
                <span className="navedit-name">{item.label}</span>
                <button type="button" className="navedit-move" aria-label={`Move ${item.label} up`} disabled={i === 0} onClick={() => move(l.key, i, -1)}>
                  <i className="fa-solid fa-chevron-up" aria-hidden />
                </button>
                <button type="button" className="navedit-move" aria-label={`Move ${item.label} down`} disabled={i === l.hrefs.length - 1} onClick={() => move(l.key, i, 1)}>
                  <i className="fa-solid fa-chevron-down" aria-hidden />
                </button>
                <label className="navedit-switch">
                  <input type="checkbox" role="switch" className="switch" checked={shown} onChange={(e) => toggle(href, e.target.checked)} aria-label={`Show ${item.label} in the sidebar`} />
                  <span>{shown ? 'Shown' : 'Hidden'}</span>
                </label>
              </div>
            );
          })}
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void send(current(), 'Sidebar menu saved.')}>
          Save menu
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            const d = layout(null);
            setLists(d.lists);
            setHidden(d.hidden);
            void send(null, 'Sidebar menu reset to the default.');
          }}
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}
