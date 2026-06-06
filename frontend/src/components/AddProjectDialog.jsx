import React, { useState } from "react";
import axios from "axios";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Upload, X, CheckCircle2, AlertTriangle, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

export default function AddProjectDialog({ open, onOpenChange, onCreated }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [pa, setPa] = useState("");
  const [installers, setInstallers] = useState([]);
  const [installerInput, setInstallerInput] = useState("");
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setStep(1); setName(""); setPa(""); setInstallers([]);
    setInstallerInput(""); setFile(null); setRows([]);
  };

  const closeAll = () => { reset(); onOpenChange(false); };

  const addInstaller = () => {
    const v = installerInput.trim();
    if (!v) return;
    if (installers.includes(v)) { toast.error("Already added"); return; }
    setInstallers([...installers, v]);
    setInstallerInput("");
  };

  const removeInstaller = (n) => setInstallers(installers.filter(i => i !== n));

  const nextFromStep1 = () => {
    if (!name.trim()) { toast.error("Project name is required"); return; }
    if (installers.length === 0) { toast.error("Add at least one installer"); return; }
    setStep(2);
  };

  const handleFile = async (f) => {
    if (!f) return;
    setFile(f);
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const { data } = await axios.post(`${API}/projects/parse-file`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setRows(data.rows || []);
      toast.success(`Parsed ${data.total} rows · ${data.valid} valid · ${data.needs_review} need review`);
      setStep(3);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to parse file");
    } finally {
      setParsing(false);
    }
  };

  const updateRow = (idx, patch) => {
    setRows(rs => rs.map(r => r.index === idx ? { ...r, ...patch } : r));
  };

  const applySuggestion = async (idx, suggestion) => {
    updateRow(idx, { address: suggestion, status: "validating" });
    try {
      const { data } = await axios.get(`${API}/places/validate`, { params: { address: suggestion } });
      if (data.ok) {
        updateRow(idx, {
          address: data.formatted || suggestion,
          formatted: data.formatted,
          lat: data.lat, lng: data.lng,
          status: data.partial ? "needs_review" : "valid",
          suggestions: data.suggestions || [],
        });
      } else {
        updateRow(idx, { status: "needs_review" });
      }
    } catch {
      updateRow(idx, { status: "needs_review" });
    }
  };

  const revalidateRow = async (idx) => {
    const row = rows.find(r => r.index === idx);
    if (!row?.address) return;
    updateRow(idx, { status: "validating" });
    try {
      const { data } = await axios.get(`${API}/places/validate`, { params: { address: row.address } });
      if (data.ok) {
        updateRow(idx, {
          formatted: data.formatted,
          lat: data.lat, lng: data.lng,
          status: data.partial ? "needs_review" : "valid",
          suggestions: data.suggestions || [],
        });
      } else {
        updateRow(idx, { status: "needs_review", suggestions: data.suggestions || [] });
      }
    } catch {
      updateRow(idx, { status: "needs_review" });
    }
  };

  const finalizeProject = async () => {
    const validRows = rows.filter(r => r.status === "valid" && r.lat != null);
    if (validRows.length === 0) { toast.error("No valid stops to save"); return; }
    setSaving(true);
    try {
      const stops = validRows.map((r, i) => ({
        id: `S${i + 1}`,
        addr: (r.formatted || r.address || "").split(",")[0],
        city: ((r.formatted || "").split(",")[1] || "").trim(),
        state: ((r.formatted || "").split(",")[2] || "").trim().split(" ")[0] || "",
        zip: ((r.formatted || "").match(/\b\d{5}\b/) || [""])[0],
        store_name: r.store_name || "",
        brand: "",
        lat: r.lat, lng: r.lng,
        geocoded: r.formatted || r.address,
      }));
      const { data } = await axios.post(`${API}/projects`, {
        name: name.trim(), pa: pa.trim(), installers, stops,
      });
      toast.success(`Project created with ${data.stop_count} stops`);
      reset();
      onCreated?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to create project");
    } finally { setSaving(false); }
  };

  const validCount = rows.filter(r => r.status === "valid").length;
  const reviewCount = rows.filter(r => r.status === "needs_review").length;
  const invalidCount = rows.filter(r => r.status === "invalid").length;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-5xl bg-white border-slate-200 text-slate-900 max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-[#0F5B7C]">
            Add New Project · Step {step} of 3
          </DialogTitle>
          <DialogDescription className="text-slate-500">
            {step === 1 && "Project details and installer assignments"}
            {step === 2 && "Upload a CSV or Excel file with address and store name columns"}
            {step === 3 && "Review validated addresses before saving"}
          </DialogDescription>
        </DialogHeader>

        {/* STEP 1: Details */}
        {step === 1 && (
          <div className="space-y-5 py-2">
            <div>
              <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">Project Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Texas Install Q2 2026"
                className="bg-white border-slate-300 text-slate-900 mt-2"
              />
            </div>
            <div>
              <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">Principal Agents (PA)</Label>
              <Input
                value={pa}
                onChange={(e) => setPa(e.target.value)}
                placeholder="e.g. DSB / Acme PA"
                className="bg-white border-slate-300 text-slate-900 mt-2"
              />
            </div>
            <div>
              <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">Installers *</Label>
              <div className="flex gap-2 mt-2">
                <Input
                  value={installerInput}
                  onChange={(e) => setInstallerInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInstaller(); } }}
                  placeholder="Installer name (press Enter or Add)"
                  className="bg-white border-slate-300 text-slate-900"
                />
                <Button onClick={addInstaller} variant="outline" className="border-orange-500/50 text-[#0F5B7C] hover:bg-orange-500/10 hover:text-[#0c4a64]">
                  + Add
                </Button>
              </div>
              {installers.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {installers.map(i => (
                    <Badge key={i} variant="outline" className="border-sky-300 text-sky-700 bg-sky-50 font-mono pl-3 pr-1 py-1">
                      {i}
                      <button onClick={() => removeInstaller(i)} className="ml-2 hover:text-rose-600 p-0.5">
                        <X size={12} />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <Button variant="outline" onClick={closeAll} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
              <Button onClick={nextFromStep1} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white">Continue →</Button>
            </div>
          </div>
        )}

        {/* STEP 2: Upload */}
        {step === 2 && (
          <div className="space-y-5 py-2">
            <div className="border-2 border-dashed border-slate-300 rounded-xl p-10 text-center hover:border-[#0F5B7C]/60 transition-colors">
              <Upload className="mx-auto text-slate-400 mb-3" size={42} />
              <p className="text-slate-700 mb-1 font-medium">Upload CSV or Excel file</p>
              <p className="text-xs text-slate-500 font-mono mb-4">Required columns: <span className="text-[#0F5B7C]">address</span>, <span className="text-[#0F5B7C]">store_name</span></p>
              <input
                id="fileinput" type="file" accept=".csv,.xlsx,.xls"
                onChange={(e) => handleFile(e.target.files?.[0])}
                className="hidden"
              />
              <Button onClick={() => document.getElementById("fileinput").click()} disabled={parsing} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white">
                {parsing ? <><Loader2 className="animate-spin mr-2" size={16} />Validating addresses…</> : "Choose File"}
              </Button>
              {file && !parsing && (
                <p className="text-xs text-emerald-600 mt-3 font-mono">✓ {file.name}</p>
              )}
            </div>
            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={() => setStep(1)} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">← Back</Button>
              <Button variant="outline" onClick={closeAll} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
            </div>
          </div>
        )}

        {/* STEP 3: Review */}
        {step === 3 && (
          <div className="space-y-4 py-2">
            <div className="flex gap-3 flex-wrap">
              <Badge className="bg-emerald-50 border-emerald-300 text-emerald-700 font-mono">
                <CheckCircle2 size={12} className="mr-1" />{validCount} valid
              </Badge>
              <Badge className="bg-amber-50 border-amber-300 text-amber-700 font-mono">
                <AlertTriangle size={12} className="mr-1" />{reviewCount} need review
              </Badge>
              {invalidCount > 0 && (
                <Badge className="bg-rose-50 border-rose-300 text-rose-700 font-mono">
                  <AlertCircle size={12} className="mr-1" />{invalidCount} invalid
                </Badge>
              )}
            </div>

            <div className="border border-slate-200 rounded-lg overflow-hidden max-h-[50vh] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 sticky top-0">
                  <tr>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider text-slate-500 font-mono">#</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider text-slate-500 font-mono">Store</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider text-slate-500 font-mono">Address</th>
                    <th className="text-left p-2 text-[10px] uppercase tracking-wider text-slate-500 font-mono w-32">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.index} className="border-t border-slate-200 hover:bg-slate-50">
                      <td className="p-2 text-xs text-slate-500 font-mono align-top">{r.index + 1}</td>
                      <td className="p-2 align-top">
                        <Input
                          value={r.store_name || ""}
                          onChange={(e) => updateRow(r.index, { store_name: e.target.value })}
                          className="bg-slate-50 border-slate-200 text-slate-900 h-8 text-xs"
                        />
                      </td>
                      <td className="p-2 align-top">
                        <Input
                          value={r.address || ""}
                          onChange={(e) => updateRow(r.index, { address: e.target.value, status: "needs_review" })}
                          onBlur={() => revalidateRow(r.index)}
                          className="bg-slate-50 border-slate-200 text-slate-900 h-8 text-xs"
                        />
                        {r.formatted && r.status === "valid" && (
                          <div className="text-[10px] text-emerald-700 mt-1 font-mono truncate">→ {r.formatted}</div>
                        )}
                        {r.place_name && (
                          <div className="text-[10px] text-sky-700 mt-0.5 font-mono truncate">🏬 {r.place_name}</div>
                        )}
                        {(r.verified_by || []).length > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {r.verified_by.includes("geocoding") && (
                              <span className="text-[9px] font-mono bg-emerald-50 text-emerald-700 border border-emerald-300 rounded px-1.5 py-0.5">GEOCODED</span>
                            )}
                            {r.verified_by.includes("places") && (
                              <span className="text-[9px] font-mono bg-sky-50 text-sky-700 border border-sky-300 rounded px-1.5 py-0.5">PLACES ✓</span>
                            )}
                            {typeof r.confidence === "number" && (
                              <span className={`text-[9px] font-mono rounded px-1.5 py-0.5 border ${
                                r.confidence >= 100 ? "bg-emerald-50 text-emerald-700 border-emerald-300" :
                                r.confidence >= 70 ? "bg-amber-50 text-amber-700 border-amber-300" :
                                "bg-rose-50 text-rose-700 border-rose-300"}`}>
                                {r.confidence}%
                              </span>
                            )}
                          </div>
                        )}
                        {(r.suggestions || []).length > 0 && r.status !== "valid" && (
                          <Select onValueChange={(v) => applySuggestion(r.index, v)}>
                            <SelectTrigger className="h-7 mt-1 bg-amber-50 border-amber-300 text-amber-800 text-[11px]">
                              <SelectValue placeholder="Pick suggestion…" />
                            </SelectTrigger>
                            <SelectContent className="bg-white border-slate-200 text-slate-900">
                              {r.suggestions.map((s, i) => (
                                <SelectItem key={i} value={s} className="text-xs">{s}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                      <td className="p-2 align-top">
                        {r.status === "valid" && (
                          <Badge className="bg-emerald-50 border-emerald-300 text-emerald-700 font-mono text-[10px]">
                            <CheckCircle2 size={10} className="mr-1" />Valid
                          </Badge>
                        )}
                        {r.status === "needs_review" && (
                          <Badge className="bg-amber-50 border-amber-300 text-amber-700 font-mono text-[10px]">
                            <AlertTriangle size={10} className="mr-1" />Review
                          </Badge>
                        )}
                        {r.status === "invalid" && (
                          <Badge className="bg-rose-50 border-rose-300 text-rose-700 font-mono text-[10px]">
                            <AlertCircle size={10} className="mr-1" />Invalid
                          </Badge>
                        )}
                        {r.status === "validating" && (
                          <Badge className="bg-sky-50 border-sky-300 text-sky-700 font-mono text-[10px]">
                            <Loader2 size={10} className="mr-1 animate-spin" />Checking
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep(2)} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">← Back</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeAll} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
                <Button onClick={finalizeProject} disabled={saving || validCount === 0} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white font-semibold">
                  {saving ? <><Loader2 className="animate-spin mr-2" size={16} />Saving…</> : `Done · Save ${validCount} stops`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
