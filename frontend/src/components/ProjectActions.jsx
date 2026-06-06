import React, { useState, useEffect } from "react";
import axios from "axios";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Loader2, AlertTriangle, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

export function RenameProjectDialog({ open, onOpenChange, project, onUpdated }) {
  const [name, setName] = useState("");
  const [pa, setPa] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) { setName(project.name || ""); setPa(project.pa || ""); }
  }, [project]);

  const submit = async () => {
    if (!name.trim()) { toast.error("Project name cannot be empty"); return; }
    setSaving(true);
    try {
      await axios.patch(`${API}/projects/${project.id}`, { name: name.trim(), pa: pa.trim() });
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
          <DialogDescription className="text-slate-500">Update project name and PA.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">Project Name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-white border-slate-300 text-slate-900 mt-2" />
          </div>
          <div>
            <Label className="text-slate-700 font-mono text-xs uppercase tracking-wider">PA (Principal Agents)</Label>
            <Input value={pa} onChange={(e) => setPa(e.target.value)} className="bg-white border-slate-300 text-slate-900 mt-2" />
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
