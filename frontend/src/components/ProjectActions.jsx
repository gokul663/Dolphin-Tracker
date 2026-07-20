import React, { useState, useEffect } from "react";
import axios from "axios";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Progress } from "./ui/progress";
import { Loader2, AlertTriangle, Pencil, Trash2, Upload, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

export function RenameProjectDialog({ open, onOpenChange, project, onUpdated }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) setName(project.name || "");
  }, [project]);

  const submit = async () => {
    if (!name.trim()) { toast.error("Project name cannot be empty"); return; }
    setSaving(true);
    try {
      await axios.patch(`${API}/projects/${project.id}`, { name: name.trim() });
      toast.success("Project updated");
      onUpdated?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    } finally { setSaving(false); }
  };

  if (!project) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white border-slate-200 text-slate-900 max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-[#0F5B7C] flex items-center gap-2">
            <Pencil size={16} /> Rename Project
          </DialogTitle>
          <DialogDescription className="text-slate-500">Update the project name. PA names come from the uploaded sheet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">Project Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-white border-slate-300 text-slate-900 mt-2" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white font-semibold">
            {saving ? <><Loader2 className="animate-spin mr-2" size={14} />Saving…</> : "Save Changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteProjectDialog({ open, onOpenChange, project, onDeleted }) {
  const [step, setStep] = useState(1);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { if (open) { setStep(1); setConfirmText(""); } }, [open]);

  if (!project) return null;
  const matches = confirmText.trim() === (project.name || "").trim();

  const performDelete = async () => {
    setDeleting(true);
    try {
      await axios.delete(`${API}/projects/${project.id}`, { params: { confirm: confirmText.trim() } });
      toast.success(`"${project.name}" deleted`);
      onDeleted?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Delete failed");
    } finally { setDeleting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white border-rose-300 text-slate-900 max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-rose-700 flex items-center gap-2">
            <AlertTriangle size={16} /> Delete Project · Step {step} of 2
          </DialogTitle>
          <DialogDescription className="text-slate-500">
            {step === 1 ? "This action cannot be undone." : "Type the project name to confirm permanent deletion."}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <>
            <div className="space-y-3 py-2 text-sm">
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 space-y-2">
                <div className="font-semibold text-rose-700 flex items-center gap-2">
                  <Trash2 size={14} /> You are about to delete:
                </div>
                <div className="text-slate-700 font-mono"><span className="text-slate-400">Name:</span> {project.name}</div>
                {project.pa && <div className="text-slate-700 font-mono"><span className="text-slate-400">PA:</span> {project.pa}</div>}
                <div className="text-slate-700 font-mono"><span className="text-slate-400">Sites:</span> {project.kpi?.total || 0} · <span className="text-slate-400">Installers:</span> {(project.installers || []).length}</div>
              </div>
              <p className="text-slate-400 text-xs leading-relaxed">
                Deleting this project will permanently remove all stops, day routes and stop-status records associated with it from MongoDB. This action is irreversible.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
              <Button onClick={() => setStep(2)} className="bg-rose-600 hover:bg-rose-700 text-white font-semibold">
                I Understand, Continue →
              </Button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="space-y-3 py-2">
              <div className="text-sm text-slate-300">
                To confirm deletion, type{" "}
                <span className="font-mono text-rose-700 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-300">
                  {project.name}
                </span>{" "}
                below:
              </div>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="Type project name to confirm…"
                className="bg-white border-rose-300 text-slate-900 font-mono"
                autoFocus
              />
              {confirmText && !matches && (
                <p className="text-xs text-rose-700 font-mono">Name does not match — deletion blocked.</p>
              )}
            </div>
            <div className="flex justify-between gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep(1)} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">← Back</Button>
              <Button onClick={performDelete} disabled={!matches || deleting} className="bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-40">
                {deleting ? <><Loader2 className="animate-spin mr-2" size={14} />Deleting…</> : "Permanently Delete"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function AppendProjectDataDialog({ open, onOpenChange, project, onUpdated }) {
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [paNames, setPaNames] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setRows([]);
      setPaNames([]);
      setParsing(false);
      setSaving(false);
      setProgress(0);
    }
  }, [open]);

  if (!project) return null;

  const handleFile = async (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    setParsing(true);
    setProgress(5);
    const timer = window.setInterval(() => setProgress(current => Math.min(current + 2, 92)), 250);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      const { data } = await axios.post(`${API}/projects/parse-file`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setRows(data.rows || []);
      setPaNames(data.pa_names || []);
      setProgress(100);
      toast.success(`Parsed ${data.total} rows · ${data.valid} valid`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to parse file");
    } finally {
      window.clearInterval(timer);
      setParsing(false);
    }
  };

  const validRows = rows.filter(row => row.status === "valid" && row.lat != null);
  const reviewRows = rows.filter(row => row.status === "needs_review");
  const invalidRows = rows.filter(row => row.status === "invalid");

  const appendRows = async () => {
    if (!validRows.length) {
      toast.error("No valid rows to append");
      return;
    }
    setSaving(true);
    try {
      const stops = validRows.map(row => ({
        addr: (row.formatted || row.address || "").split(",")[0],
        city: ((row.formatted || "").split(",")[1] || "").trim(),
        state: ((row.formatted || "").split(",")[2] || "").trim().split(" ")[0] || "",
        zip: ((row.formatted || "").match(/\b\d{5}\b/) || [""])[0],
        store_name: row.store_name || "",
        brand: "",
        lat: row.lat,
        lng: row.lng,
        geocoded: row.formatted || row.address,
        pa: row.pa || "",
        venue_type: row.venue_type || "",
        dma: row.dma || "",
        venue_code: row.venue_code || "",
        initial_status: row.venue_status || "Incomplete",
      }));
      const { data } = await axios.post(`${API}/projects/${project.id}/append-stops`, {
        pa: paNames.join(", "),
        stops,
      });
      toast.success(`Appended ${data.appended} stops${data.skipped?.length ? ` · skipped ${data.skipped.length} duplicates` : ""}`);
      onUpdated?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Append failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-white border-slate-200 text-slate-900 max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono uppercase tracking-wider text-[#0F5B7C] flex items-center gap-2">
            <Upload size={16} /> Append Data
          </DialogTitle>
          <DialogDescription className="text-slate-500">
            Upload more CSV/XLSX rows into “{project.name}”. Existing routes and saved statuses are preserved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="font-mono text-slate-700"><span className="text-slate-400">Current sites:</span> {project.kpi?.total || 0}</div>
            {project.pa && <div className="font-mono text-slate-700 mt-1"><span className="text-slate-400">Project PA:</span> {project.pa}</div>}
            <div className="font-mono text-slate-700 mt-1"><span className="text-slate-400">Installers:</span> {(project.installers || []).join(", ") || "None"}</div>
          </div>

          <div className="border-2 border-dashed border-slate-300 rounded-xl p-8 text-center hover:border-[#0F5B7C]/60 transition-colors">
            <Upload className="mx-auto text-slate-400 mb-3" size={38} />
            <p className="text-slate-700 mb-1 font-medium">Upload CSV or Excel file</p>
            <p className="text-xs text-slate-500 font-mono mb-4">Same format as Add Project: address, store_name, PA. Optional: status, venue_type, dma, venue_code.</p>
            <input
              id="append-file-input"
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(event) => handleFile(event.target.files?.[0])}
              className="hidden"
            />
            <Button onClick={() => document.getElementById("append-file-input").click()} disabled={parsing || saving} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white">
              {parsing ? <><Loader2 className="animate-spin mr-2" size={16} />Validating…</> : "Choose File"}
            </Button>
            {parsing && (
              <div className="max-w-md mx-auto mt-5">
                <div className="flex justify-between text-xs font-mono text-slate-600 mb-2">
                  <span>Parsing and validating addresses</span><strong>{progress}%</strong>
                </div>
                <Progress value={progress} className="h-2.5 bg-slate-200 [&>div]:bg-[#0F5B7C]" />
              </div>
            )}
            {file && !parsing && <p className="text-xs text-emerald-600 mt-3 font-mono">✓ {file.name}</p>}
          </div>

          {rows.length > 0 && (
            <>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-emerald-50 border-emerald-300 text-emerald-700 font-mono">
                  <CheckCircle2 size={12} className="mr-1" />{validRows.length} valid
                </Badge>
                <Badge className="bg-amber-50 border-amber-300 text-amber-700 font-mono">
                  <AlertTriangle size={12} className="mr-1" />{reviewRows.length} need review
                </Badge>
                <Badge className="bg-rose-50 border-rose-300 text-rose-700 font-mono">
                  <AlertCircle size={12} className="mr-1" />{invalidRows.length} invalid
                </Badge>
                {paNames.map(pa => (
                  <Badge key={pa} className="bg-sky-50 border-sky-300 text-sky-700 font-mono whitespace-normal break-words">
                    PA · {pa}
                  </Badge>
                ))}
              </div>

              {reviewRows.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  {reviewRows.length} rows need address review. This append flow only imports valid Google-verified rows; fix uncertain rows by using Add Project review tools or clean the CSV and upload again.
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} className="border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900">Cancel</Button>
            <Button onClick={appendRows} disabled={saving || !validRows.length} className="bg-[#0F5B7C] hover:bg-[#0c4a64] text-white font-semibold">
              {saving ? <><Loader2 className="animate-spin mr-2" size={14} />Appending…</> : `Append ${validRows.length} Valid Stops`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
