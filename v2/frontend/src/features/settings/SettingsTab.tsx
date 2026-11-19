import { useProjectContext } from "@/features/projects/ProjectPage";
import { DetailsSection } from "@/features/settings/DetailsSection";
import { DeviceSettings } from "@/features/device/DeviceSettings";
import { HardwareCostsSection } from "@/features/settings/HardwareCostsSection";
import { ScreenSheetSection } from "@/features/settings/ScreenSheetSection";
import { SchemaEditor } from "@/features/settings/SchemaEditor";
import { UploadsSection } from "@/features/settings/UploadsSection";

/** Project settings: metadata, hardware prices, the uploaded sheets and the store field schema. Installers and routing live in route plans. */
export function SettingsTab() {
  const project = useProjectContext();
  return (
    // Two columns on a wide screen (each stacks its own cards, so a tall card does not leave a gap beside it); one
    // column below that.
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <DetailsSection project={project} />
        <DeviceSettings project={project} />
        <UploadsSection project={project} />
        <ScreenSheetSection project={project} />
      </div>
      <div className="min-w-0 space-y-4">
        <HardwareCostsSection project={project} />
        <SchemaEditor project={project} />
      </div>
    </div>
  );
}
