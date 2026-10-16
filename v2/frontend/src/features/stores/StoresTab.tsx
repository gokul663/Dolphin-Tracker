export function StoresTab() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,40%)]">
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Store table (TanStack Table + Virtual, inline editing, required name and address) — Phase 3.
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Shared MapView (status pins, same-address stacking, clustering, table sync) — Phase 3.
      </div>
    </div>
  );
}
