import { useProjectContext } from "@/features/projects/ProjectPage";
import { DetailsSection } from "@/features/settings/DetailsSection";
import { InstallersSection } from "@/features/settings/InstallersSection";
import { SchemaEditor } from "@/features/settings/SchemaEditor";

export function SettingsTab() {
  const project = useProjectContext();
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-4">
        <DetailsSection project={project} />
        <SchemaEditor project={project} />
      </div>
      <InstallersSection project={project} />
    </div>
  );
}
