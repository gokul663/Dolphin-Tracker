import { AlertTriangle } from "lucide-react";
import { useInstallers } from "@/features/lists/api";

/** A name's identity whatever case or spacing it was typed in (backend `name_key`). */
export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");

/** Whether a name is one of the installers on the Installers page; `null` while the list is still loading (nothing
 *  is flagged before it is known). */
export function useIsInstaller(): (name: string) => boolean | null {
  const installers = useInstallers();
  const keys = installers.data ? new Set(installers.data.map((item) => nameKey(item.value))) : null;
  return (name) => (keys ? keys.has(nameKey(name)) : null);
}

/** Shown next to a name that is on a store but not on the Installers page: the record is kept as it is, and this
 *  says it cannot be tied to an installer yet. */
export function NotAnInstaller({ name }: { name: string }) {
  const label = `${name} is not in the Installers list`;
  return (
    <span title={`${label}: add them there, or correct the name`} className="inline-flex shrink-0 text-amber-600">
      <AlertTriangle size={13} aria-label={label} />
    </span>
  );
}

/** An installer's name as a record has it, with the mark when it matches no installer. */
export function InstallerName({ name }: { name: string }) {
  const known = useIsInstaller()(name);
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <span className="truncate">{name}</span>
      {known === false && <NotAnInstaller name={name} />}
    </span>
  );
}
