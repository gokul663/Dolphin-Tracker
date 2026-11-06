import { useId } from "react";
import { Input } from "@/components/ui/input";
import { useNames } from "@/features/lists/api";
import type { NameListKind } from "@/lib/api/types";

interface Props extends Omit<React.ComponentProps<typeof Input>, "list" | "onChange" | "value"> {
  kind: NameListKind;
  value: string;
  onChange: (value: string) => void;
}

/** A name picked from the installer or manager list, or typed; a new name joins the list when it is saved. */
export function NameField({ kind, value, onChange, ...props }: Props) {
  const listId = useId();
  const names = useNames(kind);
  return (
    <>
      <Input {...props} list={listId} value={value} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {(names.data ?? []).map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
    </>
  );
}
