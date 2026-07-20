import React, { useEffect, useState, useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import {
  PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid
} from "recharts";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Input } from "../components/ui/input";
import { Plus, Briefcase, Users, MapPin, CheckCircle2, Clock, AlertTriangle, ArrowRight, Trash2, Pencil, Database, SlidersHorizontal, Search, Check, Upload } from "lucide-react";
import AddProjectDialog from "../components/AddProjectDialog";
import { RenameProjectDialog, DeleteProjectDialog, AppendProjectDataDialog } from "../components/ProjectActions";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

const ACCENT = "#0F5B7C"; // dark navy-teal accent
const COLORS_INSTALLER = ["#0F5B7C", "#0891b2", "#7c3aed", "#dc2626", "#16a34a", "#ea580c", "#ca8a04"];
const COLORS_STATUS = {
  Complete: "#16a34a",
  Upcoming: "#ca8a04",
  "Technical Issue": "#dc2626",
  Other: "#7c3aed",
};

function KpiCard({ icon: Icon, label, value, color }) {
  return (
    <Card className="bg-white border-slate-200 p-5 flex items-center gap-4 hover:border-[#0F5B7C]/60 hover:shadow-md transition-all shadow-sm">
      <div className="rounded-xl p-3" style={{ background: `${color}1A`, color }}>
        <Icon size={22} />
      </div>
      <div>
        <div className="text-2xl font-bold text-slate-900 font-mono leading-none">{value}</div>
        <div className="text-[11px] uppercase tracking-wider text-slate-500 mt-1.5">{label}</div>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDialog, setOpenDialog] = useState(false);
  const [tab, setTab] = useState("all");
  const [renameTarget, setRenameTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [appendTarget, setAppendTarget] = useState(null);
  const [health, setHealth] = useState({ db: null, google: null });
  const [selectedProjectIds, setSelectedProjectIds] = useState(null);
  const [projectFilterOpen, setProjectFilterOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const navigate = useNavigate();
  const location = useLocation();

  const fetchHealth = async () => {
    try {
      const { data } = await axios.get(`${API}/health`);
      setHealth({ db: !!data.db, google: !!data.google });
    } catch {
      setHealth({ db: false, google: false });
    }
  };

  useEffect(() => {
    fetchHealth();
    const t = setInterval(fetchHealth, 15000);
    return () => clearInterval(t);
  }, []);

  const fetchProjects = async () => {
    try {
      const { data } = await axios.get(`${API}/projects`);
      setProjects(data.projects || []);
    } catch (e) {
      console.error(e);
      toast.error("Failed to load projects");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchProjects();
  }, [location.key]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") fetchProjects();
    };
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const filteredProjects = useMemo(() => {
    if (selectedProjectIds === null) return projects;
    return projects.filter(project => selectedProjectIds.includes(project.id));
  }, [projects, selectedProjectIds]);

  const filteredKpi = useMemo(() => {
    const installers = new Set();
    const totals = {total_projects: filteredProjects.length, total_sites: 0, total_installers: 0, complete: 0, pending: 0, technical: 0, other: 0};
    filteredProjects.forEach(project => {
      (project.installers || []).forEach(installer => installers.add(installer));
      totals.total_sites += project.kpi?.total || 0;
      totals.complete += project.kpi?.complete || 0;
      totals.pending += project.kpi?.pending || 0;
      totals.technical += project.kpi?.technical || 0;
      totals.other += project.kpi?.other || 0;
    });
    totals.total_installers = installers.size;
    return totals;
  }, [filteredProjects]);

  const toggleProjectFilter = (projectId) => {
    setSelectedProjectIds(current => {
      const selected = current === null ? projects.map(project => project.id) : current;
      return selected.includes(projectId)
        ? selected.filter(id => id !== projectId)
        : [...selected, projectId];
    });
  };

  const searchableProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(project =>
      [project.name, project.pa, project.project_type]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [projects, projectSearch]);

  const selectVisibleProjects = () => {
    setSelectedProjectIds(searchableProjects.map(project => project.id));
  };

  const installerData = useMemo(() => {
    const agg = {};
    filteredProjects.forEach(p => {
      Object.entries(p.kpi?.by_installer || {}).forEach(([k, v]) => {
        agg[k] = (agg[k] || 0) + v;
      });
    });
    return Object.entries(agg).map(([name, value]) => ({ name, value }));
  }, [filteredProjects]);

  const statusData = useMemo(() => {
    return [
      { name: "Complete", value: filteredKpi.complete || 0 },
      { name: "Upcoming", value: filteredKpi.pending || 0 },
      { name: "Technical Issue", value: filteredKpi.technical || 0 },
      { name: "Other", value: filteredKpi.other || 0 },
    ].filter(s => s.value > 0);
  }, [filteredKpi]);

  const sitesPerProject = useMemo(() => {
    return filteredProjects.map(p => ({ name: p.name.length > 18 ? p.name.slice(0, 16) + "…" : p.name, sites: p.kpi?.total || 0 }));
  }, [filteredProjects]);

  const isCompleted = (p) => {
    const t = p.kpi?.total || 0;
    if (!t) return false;
    return (p.kpi?.pending || 0) === 0 && (p.kpi?.technical || 0) === 0;
  };
  const ongoing = useMemo(() => projects.filter(p => !isCompleted(p)), [projects]);
  const completed = useMemo(() => projects.filter(p => isCompleted(p)), [projects]);
  const visibleProjects = tab === "ongoing" ? ongoing : tab === "completed" ? completed : projects;

  return (
    <div className="min-h-screen text-slate-900 bg-slate-50">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200 shadow-sm px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 34, letterSpacing: 4, lineHeight: 1 }}>
            <span style={{ color: ACCENT }}>ROUTE</span>{" "}
            <span style={{ color: "#0f172a" }}>PLANNER</span>
          </div>
          <Badge variant="outline" className="border-[#0F5B7C]/40 text-[#0F5B7C] font-mono text-[10px] tracking-wider bg-[#0F5B7C]/5">
            DASHBOARD
          </Badge>
          <Badge
            variant="outline"
            className={`font-mono text-[10px] tracking-wider flex items-center gap-1.5 ${
              health.db === true ? "border-emerald-500/50 text-emerald-700 bg-emerald-50" :
              health.db === false ? "border-rose-500/50 text-rose-700 bg-rose-50" :
              "border-slate-300 text-slate-500 bg-slate-50"
            }`}
            title="MongoDB connection status (polls every 15s)"
          >
            <Database size={11} />
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${
              health.db === true ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.6)] animate-pulse" :
              health.db === false ? "bg-rose-500" : "bg-slate-400"
            }`} />
            MONGODB {health.db === true ? "CONNECTED" : health.db === false ? "OFFLINE" : "CHECKING…"}
          </Badge>
          {health.google === false && (
            <Badge variant="outline" className="border-amber-500/50 text-amber-700 bg-amber-50 font-mono text-[10px] tracking-wider">
              GOOGLE API: OFF
            </Badge>
          )}
        </div>
        <Button onClick={() => setOpenDialog(true)} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white font-semibold font-mono tracking-wider uppercase shadow-sm">
          <Plus size={16} className="mr-1" /> Add New Project
        </Button>
      </header>

      <div className="max-w-[1900px] mx-auto px-6 py-8 space-y-8">
        {/* KPI Row */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <h2 className="text-xs uppercase tracking-[2px] font-mono text-slate-500">Key Performance Indicators</h2>
            <Popover open={projectFilterOpen} onOpenChange={setProjectFilterOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="border-slate-300 text-slate-700 bg-white font-mono text-xs">
                  <SlidersHorizontal size={14} className="mr-2" />
                  {selectedProjectIds === null ? "All projects" : `${selectedProjectIds.length} project${selectedProjectIds.length === 1 ? "" : "s"}`}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-96 bg-white border-slate-200 p-0">
                <div className="p-3 border-b border-slate-200">
                  <div className="text-xs font-mono uppercase tracking-wider text-slate-500 mb-2">KPI project filter</div>
                  <div className="relative">
                    <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={projectSearch}
                      onChange={event => setProjectSearch(event.target.value)}
                      placeholder="Search name, PA, or project type..."
                      className="pl-9 bg-white border-slate-300"
                      autoFocus
                    />
                  </div>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" onClick={selectVisibleProjects} disabled={!searchableProjects.length} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white text-xs">
                      Select visible ({searchableProjects.length})
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setSelectedProjectIds(null)} className="border-slate-300 text-xs">All projects</Button>
                    <Button size="sm" variant="outline" onClick={() => setSelectedProjectIds([])} className="border-slate-300 text-xs">Clear</Button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {searchableProjects.length === 0 ? (
                    <div className="p-6 text-center text-sm text-slate-500">No matching projects</div>
                  ) : searchableProjects.map(project => {
                    const checked = selectedProjectIds === null || selectedProjectIds.includes(project.id);
                    return (
                      <button
                        type="button"
                        key={project.id}
                        onClick={() => toggleProjectFilter(project.id)}
                        className="w-full flex items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-100"
                      >
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${checked ? "bg-[#0F5B7C] border-[#0F5B7C] text-white" : "border-slate-300 bg-white"}`}>
                          {checked && <Check size={12} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-800">{project.name}</span>
                          <span className="block truncate text-[10px] font-mono text-slate-500">{project.pa ? `PA · ${project.pa}` : "No PA"}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KpiCard icon={Briefcase} label="Total Projects" value={filteredKpi.total_projects || 0} color="#0F5B7C" />
            <KpiCard icon={MapPin} label="Total Sites" value={filteredKpi.total_sites || 0} color="#0891b2" />
            <KpiCard icon={Users} label="Total Installers" value={filteredKpi.total_installers || 0} color="#7c3aed" />
            <KpiCard icon={CheckCircle2} label="Completed" value={filteredKpi.complete || 0} color="#16a34a" />
            <KpiCard icon={Clock} label="Upcoming" value={filteredKpi.pending || 0} color="#ca8a04" />
            <KpiCard icon={AlertTriangle} label="Tech Issues" value={filteredKpi.technical || 0} color="#dc2626" />
          </div>
        </section>

        {/* Charts */}
        <section className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <Card className="bg-white border-slate-200 p-5 shadow-sm">
            <h3 className="text-xs uppercase tracking-[2px] font-mono text-slate-500 mb-3">Sites by Installer</h3>
            <div className="h-72">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={installerData} dataKey="value" nameKey="name" outerRadius={90} innerRadius={40} paddingAngle={2}>
                    {installerData.map((_, i) => (
                      <Cell key={i} fill={COLORS_INSTALLER[i % COLORS_INSTALLER.length]} stroke="#fff" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, color: "#0f172a", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} />
                  <Legend wrapperStyle={{ color: "#475569", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </Card>

          <Card className="bg-white border-slate-200 p-5 shadow-sm">
            <h3 className="text-xs uppercase tracking-[2px] font-mono text-slate-500 mb-3">Status Breakdown</h3>
            <div className="h-72">
              {statusData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-slate-400 text-sm font-mono">No data yet</div>
              ) : (
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" outerRadius={90} innerRadius={40} paddingAngle={2}>
                      {statusData.map((s, i) => (
                        <Cell key={i} fill={COLORS_STATUS[s.name] || "#94a3b8"} stroke="#fff" strokeWidth={2} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, color: "#0f172a", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} />
                    <Legend wrapperStyle={{ color: "#475569", fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>

          <Card className="bg-white border-slate-200 p-5 shadow-sm">
            <h3 className="text-xs uppercase tracking-[2px] font-mono text-slate-500 mb-3">Sites per Project</h3>
            <div className="h-72">
              {sitesPerProject.length === 0 ? (
                <div className="flex items-center justify-center h-full text-slate-400 text-sm font-mono">No projects yet</div>
              ) : (
                <ResponsiveContainer>
                  <BarChart data={sitesPerProject}>
                    <CartesianGrid stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fill: "#475569", fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50} />
                    <YAxis tick={{ fill: "#475569", fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8, color: "#0f172a", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }} cursor={{ fill: "rgba(15,91,124,0.08)" }} />
                    <Bar dataKey="sites" fill={ACCENT} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
        </section>

        {/* Projects */}
        <section>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
            <h2 className="text-xs uppercase tracking-[2px] font-mono text-slate-500">Projects</h2>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="bg-white border border-slate-200 shadow-sm">
                <TabsTrigger value="all" className="font-mono text-[11px] tracking-wider uppercase data-[state=active]:bg-[#0F5B7C] data-[state=active]:text-white text-slate-600">
                  All ({projects.length})
                </TabsTrigger>
                <TabsTrigger value="ongoing" className="font-mono text-[11px] tracking-wider uppercase data-[state=active]:bg-sky-600 data-[state=active]:text-white text-slate-600">
                  Ongoing ({ongoing.length})
                </TabsTrigger>
                <TabsTrigger value="completed" className="font-mono text-[11px] tracking-wider uppercase data-[state=active]:bg-emerald-600 data-[state=active]:text-white text-slate-600">
                  Completed ({completed.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          {loading ? (
            <Card className="bg-white border-slate-200 p-8 text-center text-slate-500 font-mono shadow-sm">Loading projects…</Card>
          ) : visibleProjects.length === 0 ? (
            <Card className="bg-white border-slate-200 p-10 text-center text-slate-500 font-mono shadow-sm">
              {tab === "completed" ? "No completed projects yet." : tab === "ongoing" ? "No ongoing projects." : <>No projects yet. Click <span className="text-[#0F5B7C] font-semibold">Add New Project</span> to begin.</>}
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {visibleProjects.map((p) => {
                const total = p.kpi?.total || 0;
                const done = p.kpi?.complete || 0;
                const pct = total ? Math.round((done / total) * 100) : 0;
                const completedFlag = isCompleted(p);
                return (
                  <Card key={p.id} className={`bg-white p-5 hover:border-[#0F5B7C]/60 hover:shadow-md transition-all cursor-pointer group shadow-sm ${completedFlag ? "border-emerald-500/40" : "border-slate-200"}`} onClick={() => navigate(`/project/${p.id}`)}>
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="text-lg font-semibold text-slate-900 group-hover:text-[#0F5B7C] transition-colors">{p.name}</div>
                          {completedFlag && (
                            <Badge className="bg-emerald-50 border-emerald-500/40 text-emerald-700 font-mono text-[10px]">
                              <CheckCircle2 size={10} className="mr-1" />Completed
                            </Badge>
                          )}
                        </div>
                        {p.pa && (
                          <div className="text-xs font-mono text-slate-500 mt-1">
                            <span className="text-slate-400">PA:</span> {p.pa}
                          </div>
                        )}
                        {p.project_type && (
                          <div className="text-xs font-mono text-slate-500 mt-1">
                            <span className="text-slate-400">Type:</span>{" "}
                            {p.project_type === "new_installation" ? "New Installation" : p.project_type === "offline" ? "Offline" : "New Installation + Offline"}
                          </div>
                        )}
                      </div>
                      {!p.read_only && <div className="flex gap-1 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); setAppendTarget(p); }}
                          className="inline-flex items-center gap-1.5 text-[#0F5B7C] hover:text-[#0c4a64] px-2.5 py-1.5 rounded border border-[#0F5B7C]/25 bg-[#0F5B7C]/5 hover:bg-[#0F5B7C]/10 text-[11px] font-mono font-semibold uppercase tracking-wider"
                          title="Append more CSV/XLSX data to this existing project"
                          aria-label={`Append more CSV/XLSX data to ${p.name}`}
                        >
                          <Upload size={14} />
                          <span>Append More</span>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setRenameTarget(p); }}
                          className="text-slate-400 hover:text-[#0F5B7C] p-1.5 rounded hover:bg-slate-100"
                          title="Rename project"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(p); }}
                          className="text-slate-400 hover:text-rose-600 p-1.5 rounded hover:bg-rose-50"
                          title="Delete project"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>}
                    </div>

                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {(p.installers || []).map(i => (
                        <Badge key={i} variant="outline" className="text-[10px] font-mono border-slate-300 text-slate-600 bg-slate-50">
                          {i}
                        </Badge>
                      ))}
                    </div>

                    <div className="grid grid-cols-4 gap-2 mb-3 text-center">
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-2">
                        <div className="text-base font-bold font-mono text-[#0F5B7C]">{total}</div>
                        <div className="text-[9px] uppercase tracking-wider text-slate-500">Sites</div>
                      </div>
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2">
                        <div className="text-base font-bold font-mono text-emerald-700">{done}</div>
                        <div className="text-[9px] uppercase tracking-wider text-slate-500">Done</div>
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-2">
                        <div className="text-base font-bold font-mono text-amber-700">{p.kpi?.pending || 0}</div>
                        <div className="text-[9px] uppercase tracking-wider text-slate-500">Upcoming</div>
                      </div>
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-2">
                        <div className="text-base font-bold font-mono text-rose-700">{p.kpi?.technical || 0}</div>
                        <div className="text-[9px] uppercase tracking-wider text-slate-500">Tech</div>
                      </div>
                    </div>

                    <div className="mb-2">
                      <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
                        <span>Progress</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-[#0F5B7C] to-[#0891b2] transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>

                    <div className="flex items-center justify-end text-xs font-mono text-[#0F5B7C] group-hover:text-[#0c4a64] pt-2">
                      Open Planner <ArrowRight size={14} className="ml-1" />
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <AddProjectDialog
        open={openDialog}
        onOpenChange={setOpenDialog}
        onCreated={() => { setOpenDialog(false); fetchProjects(); }}
      />
      <RenameProjectDialog
        open={!!renameTarget}
        onOpenChange={(o) => { if (!o) setRenameTarget(null); }}
        project={renameTarget}
        onUpdated={fetchProjects}
      />
      <DeleteProjectDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        project={deleteTarget}
        onDeleted={fetchProjects}
      />
      <AppendProjectDataDialog
        open={!!appendTarget}
        onOpenChange={(o) => { if (!o) setAppendTarget(null); }}
        project={appendTarget}
        onUpdated={fetchProjects}
      />
    </div>
  );
}
