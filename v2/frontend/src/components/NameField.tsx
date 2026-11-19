import { SuggestInput } from "@/components/SuggestInput";
import type { Input } from "@/components/ui/input";
import { useNames } from "@/features/lists/api";
import type { NameListKind } from "@/lib/api/types";

interface Props extends Omit<React.ComponentProps<typeof Input>, "list" | "onChange" | "value"> {
  kind: NameListKind;
  value: string;
  onChange: (value: string) => void;
}

/** A name picked from the installer or manager list, or typed; a new name joins the list when it is saved. */
export function NameField({ kind, value, onChange, ...props }: Props) {
  const names = useNames(kind);
  return <SuggestInput {...props} value={value} onValueChange={onChange} options={names.data ?? []} />;
}
