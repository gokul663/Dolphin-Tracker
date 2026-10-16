import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import type { StopStatus } from "@/lib/api/types";
import { INSTALLER_COLORS, STATUS_META } from "@/lib/status";

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  color: "#0f172a",
  boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
};

function ChartCard({ title, empty, children }: { title: string; empty: string | null; children: React.ReactNode }) {
  return (
    <Card className="gap-3 p-5">
      <h3 className="font-mono text-xs uppercase tracking-[2px] text-slate-500">{title}</h3>
      <div className="h-72">
        {empty ? (
          <div className="flex h-full items-center justify-center font-mono text-sm text-slate-400">{empty}</div>
        ) : (
          <ResponsiveContainer>{children}</ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}

export function InstallerPie({ data }: { data: { name: string; value: number }[] }) {
  return (
    <ChartCard title="Sites by installer" empty={data.length ? null : "No data yet"}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" outerRadius={90} innerRadius={40} paddingAngle={2}>
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={INSTALLER_COLORS[index % INSTALLER_COLORS.length]} stroke="#fff" strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ color: "#475569", fontSize: 12 }} />
      </PieChart>
    </ChartCard>
  );
}

export function StatusPie({ data }: { data: { status: StopStatus; value: number }[] }) {
  const labelled = data.map((entry) => ({ ...entry, name: STATUS_META[entry.status].label }));
  return (
    <ChartCard title="Status breakdown" empty={data.length ? null : "No data yet"}>
      <PieChart>
        <Pie data={labelled} dataKey="value" nameKey="name" outerRadius={90} innerRadius={40} paddingAngle={2}>
          {labelled.map((entry) => (
            <Cell key={entry.status} fill={STATUS_META[entry.status].color} stroke="#fff" strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ color: "#475569", fontSize: 12 }} />
      </PieChart>
    </ChartCard>
  );
}

export function SitesBar({ data }: { data: { name: string; sites: number }[] }) {
  return (
    <ChartCard title="Sites per project" empty={data.length ? null : "No projects yet"}>
      <BarChart data={data}>
        <CartesianGrid stroke="#e2e8f0" />
        <XAxis dataKey="name" tick={{ fill: "#475569", fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
        <YAxis tick={{ fill: "#475569", fontSize: 11 }} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: "rgba(15,91,124,0.08)" }} />
        <Bar dataKey="sites" fill="#0F5B7C" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartCard>
  );
}
