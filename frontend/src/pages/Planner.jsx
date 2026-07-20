import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

export default function Planner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [projectName, setProjectName] = useState("");
  const [pa, setPa] = useState("");
  const [projectType, setProjectType] = useState("");
  const src = `/route-planner.html?api=${encodeURIComponent(BACKEND_URL)}&project=${encodeURIComponent(id)}`;

  useEffect(() => {
    const onMsg = (e) => {
      if (e?.data?.type === "go-home") navigate("/");
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [navigate]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await axios.get(`${API}/projects/${id}`);
        if (!alive) return;
        setProjectName(data.name || "");
        setPa(data.pa || "");
        setProjectType(data.project_type || "");
      } catch {
        if (alive) setProjectName("");
      }
    })();
    return () => { alive = false; };
  }, [id]);

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <div
        style={{
          position: "fixed",
          top: 16,
          left: 16,
          zIndex: 9999,
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "rgba(255,255,255,0.96)",
          backdropFilter: "blur(8px)",
          border: "1px solid #cbd5e1",
          borderRadius: 10,
          padding: "6px 12px 6px 8px",
          boxShadow: "0 6px 20px rgba(15,91,124,.15)",
        }}
      >
        <button
          onClick={() => navigate("/")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 10px",
            background: "rgba(15,91,124,.08)",
            color: "#0F5B7C",
            border: "1px solid rgba(15,91,124,.35)",
            borderRadius: 6,
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: ".8px",
            cursor: "pointer",
            textTransform: "uppercase",
          }}
          title="Back to Projects"
        >
          ← Projects
        </button>
        {projectName && (
          <div style={{ borderLeft: "1px solid #cbd5e1", paddingLeft: 12, lineHeight: 1.1 }}>
            <div
              style={{
                fontFamily: "'Bebas Neue', sans-serif",
                fontSize: 22,
                letterSpacing: 3,
                color: "#0f172a",
                textTransform: "uppercase",
              }}
            >
              {projectName}
            </div>
            {projectType && (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, color: "#64748b", marginTop: 2, textTransform: "uppercase", letterSpacing: 1 }}>
                TYPE · {projectType === "new_installation" ? "New Installation" : projectType === "offline" ? "Offline" : "New Installation + Offline"}
              </div>
            )}
          </div>
        )}
      </div>
      <iframe
        title="Route Planner"
        src={src}
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </div>
  );
}
