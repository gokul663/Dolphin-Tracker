import { useState } from "react";
import { ScreensEditor, toInputs, toRows } from "@/features/stores/ScreensEditor";
import type { Project, Stop } from "@/lib/api/types";

/** The screens editor with its draft held here, as the store window holds it; `latest()` reads what Save would send. */
export function draftScreens(project: Project, stop: Stop) {
  let current = toRows(stop);
  function Harness() {
    const [rows, setRows] = useState(current);
    return (
      <ScreensEditor
        project={project}
        stop={stop}
        rows={rows}
        onChange={(next) => {
          current = next;
          setRows(next);
        }}
      />
    );
  }
  return { element: <Harness />, latest: () => toInputs(current) };
}
