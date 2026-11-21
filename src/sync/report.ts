/** What one sync did: notes written, timeline events added, inputs skipped, and errors that did not stop it. */
export interface SyncReport {
  name: string;
  notes: number;
  events: number;
  skipped: number;
  errors: string[];
}

export const emptyReport = (name: string): SyncReport => ({ name, notes: 0, events: 0, skipped: 0, errors: [] });

/** One summary line per sync, then its error messages (at most `maxErrors` of them). */
export function formatSyncReport(report: SyncReport, maxErrors = Infinity): string[] {
  const shownErrors = report.errors.slice(0, maxErrors);
  const hiddenCount = report.errors.length - shownErrors.length;
  return [
    `${report.name}: ${report.notes} notes changed, ${report.events} events added, ${report.skipped} skipped${report.errors.length ? `, ${report.errors.length} errors` : ''}`,
    ...shownErrors.map((e) => `  - ${e}`),
    ...(hiddenCount ? [`  - and ${hiddenCount} more`] : []),
  ];
}
