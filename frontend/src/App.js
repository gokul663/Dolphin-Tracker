import React from "react";
import "./App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import Planner from "./pages/Planner";
import { Toaster } from "./components/ui/sonner";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/project/:id" element={<Planner />} />
      </Routes>
      <Toaster theme="dark" position="top-right" richColors />
    </BrowserRouter>
  );
}

export default App;
