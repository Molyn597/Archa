import { deadlines, groupDeadlines, type Deadline, type DeadlineGroup } from '../shared/deadlines';
import { t, type MessageKey } from '../shared/i18n';
import { day, isoDay } from '../shared/invoices';
import type { DocumentCard, Job, Project } from '../shared/types';
import { cleanError, h, icon, ICONS, toast } from './dom';

export interface DeadlinesCtx {
  jobs: Job[];
  cards: Record<string, DocumentCard>;
  paid: Record<string, number> | undefined;
  projects: Project[];
  open(jobId: string): void;
  openProject(id: string): void;
}

const GROUPS: DeadlineGroup[] = ['overdue', 'week', 'month', 'later'];

/** Všechny termíny + ty po termínu a do 31 dní (počet ve stromu a karta v Přehledu). */
export function dueSoon(ctx: Pick<DeadlinesCtx, 'jobs' | 'cards' | 'paid' | 'projects'>) {
  const today = isoDay();
  const all = deadlines({ ...ctx, today });
  const groups = groupDeadlines(all, today);
  return { all, soon: [...groups.overdue, ...groups.week, ...groups.month], groups };
}

/**
 * Řádek termínu: název a datum, pod nimi druh a podrobnosti. Po termínu je varovně barevný.
 * Přehled místo data ukáže relativní čas (`dateText`) a blížící se termín zvýrazní (`soon`).
 */
export function deadlineRow(d: Deadline, ctx: Pick<DeadlinesCtx, 'open' | 'openProject'>, look: { dateText?: string; soon?: boolean } = {}) {
  const sub = [t(`dl.kind.${d.kind}` as MessageKey), d.detail].filter(Boolean).join(' · ');
  return h(
    'button',
    {
      class: `dl-row${d.overdue ? ' overdue' : look.soon ? ' soon' : ''}`,
      type: 'button',
      title: sub,
      onclick: () => (d.jobId ? ctx.open(d.jobId) : d.projectId && ctx.openProject(d.projectId)),
    },
    h('span', { class: 'dl-title' }, d.title),
    h('span', { class: 'dl-date' }, look.dateText ?? day(d.date)),
    h('span', { class: 'dl-sub' }, sub),
  );
}

/** Seznam termínů seskupený podle blízkosti; u faktur tlačítko Zaplaceno. */
export function renderDeadlines(root: HTMLElement, ctx: DeadlinesCtx) {
  const { all, groups } = dueSoon(ctx);
  const pay = (jobId: string) => void window.api.setInvoicesPaid([jobId], true).catch((e) => toast(cleanError(e), true));
  const line = (d: Deadline) =>
    h(
      'div',
      { class: 'dl-line' },
      deadlineRow(d, ctx),
      d.kind === 'invoiceDue' && d.jobId ? h('button', { class: 'btn', type: 'button', onclick: () => pay(d.jobId!) }, icon(ICONS.check), t('dl.markPaid')) : null,
    );
  root.replaceChildren(
    h(
      'div',
      { class: 'dl-view' },
      ...(all.length
        ? GROUPS.filter((g) => groups[g].length).map((g) => h('section', { class: `dl-group${g === 'overdue' ? ' overdue' : ''}` }, h('h3', {}, t(`dl.group.${g}` as MessageKey)), ...groups[g].map(line)))
        : [h('div', { class: 'empty' }, h('p', {}, t('dl.viewEmpty')))]),
    ),
  );
}
