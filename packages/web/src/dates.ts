export interface Dated {
  updatedAt: string;
}

export interface DateGroup<T> {
  label: string;
  items: T[];
}

const DAY = 24 * 60 * 60 * 1000;

/** Sidebar groups, most recent first: Aujourd'hui, Hier, 7 derniers jours, 30 derniers jours, Plus ancien. */
export function groupByDate<T extends Dated>(items: T[], now = new Date()): DateGroup<T>[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: DateGroup<T>[] = [
    { label: "Aujourd'hui", items: [] },
    { label: "Hier", items: [] },
    { label: "7 derniers jours", items: [] },
    { label: "30 derniers jours", items: [] },
    { label: "Plus ancien", items: [] },
  ];
  const sorted = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const item of sorted) {
    const t = Date.parse(item.updatedAt);
    const index =
      t >= startOfToday
        ? 0
        : t >= startOfToday - DAY
          ? 1
          : t >= startOfToday - 6 * DAY
            ? 2
            : t >= startOfToday - 29 * DAY
              ? 3
              : 4;
    buckets[index]!.items.push(item);
  }
  return buckets.filter((b) => b.items.length > 0);
}
