import { useProjectContext } from "@/features/projects/ProjectPage";
import { DetailsSection } from "@/features/settings/DetailsSection";
import { DeviceSettings } from "@/features/device/DeviceSettings";
import { HardwareCostsSection } from "@/features/settings/HardwareCostsSection";
import { SchemaEditor } from "@/features/settings/SchemaEditor";

/** Project settings: metadata, hardware prices and the store field schema. Installers and routing live in route plans. */
export function SettingsTab() {
  const project = useProjectContext();
  return (
    <div className="max-w-4xl space-y-4">
      <DetailsSection project={project} />
      <HardwareCostsSection project={project} />
      <DeviceSettings project={project} />
      <SchemaEditor project={project} />
    </div>
  );
}
