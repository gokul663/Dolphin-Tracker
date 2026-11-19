import { useId, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface Props extends Omit<React.ComponentProps<typeof Input>, "list" | "onChange" | "value"> {
  value: string;
  onValueChange: (value: string) => void;
  /** What can be picked; anything else may still be typed. */
  options: readonly string[];
  /** False when the options already answer what was typed (a server's suggestions): all of them show. */
  filter?: boolean;
  /** A suggestion was chosen (click or Enter), as opposed to typed. */
  onPick?: (option: string) => void;
}

/** A text box with its suggestions in a drop-down of the app's own (the browser's `datalist` list is drawn by the
 *  system, dark on a dark-mode machine). Typing narrows the list; a suggestion is picked with a click, or with the
 *  arrow keys and Enter. */
export function SuggestInput({ value, onValueChange, options, filter = true, onPick, onKeyDown, onFocus, onBlur, className, ...props }: Props) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const needle = value.trim().toLowerCase();
  const matches = filter ? options.filter((option) => option.toLowerCase().includes(needle)) : [...options];
  // Nothing to offer once the box holds exactly the one thing left to pick.
  const shown = matches.length === 1 && matches[0]!.toLowerCase() === needle ? [] : matches;
  const open = focused && !dismissed && shown.length > 0;
  const pick = (option: string) => {
    onValueChange(option);
    onPick?.(option);
    setDismissed(true);
    setActive(-1);
  };
  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <Input
          {...props}
          ref={input}
          className={className}
          value={value}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          onChange={(event) => {
            onValueChange(event.target.value);
            setDismissed(false);
            setActive(-1);
          }}
          onFocus={(event) => {
            setFocused(true);
            setDismissed(false);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            setActive(-1);
            onBlur?.(event);
          }}
          onClick={() => setDismissed(false)}
          onKeyDown={(event) => {
            if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              setActive((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
              return;
            }
            if (open && event.key === "Enter" && active >= 0 && shown[active] !== undefined) {
              event.preventDefault();
              pick(shown[active]!);
              return;
            }
            if (open && event.key === "Escape") {
              event.stopPropagation(); // close the list, not the window around it
              setDismissed(true);
              return;
            }
            onKeyDown?.(event);
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="max-h-64 w-(--radix-popover-trigger-width) min-w-40 overflow-y-auto rounded-lg border-slate-200 bg-white p-1 text-slate-900 shadow-lg"
        onOpenAutoFocus={(event) => event.preventDefault()} // typing goes on
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ul id={listId} role="listbox">
          {shown.map((option, index) => (
            <li
              key={option}
              role="option"
              aria-selected={index === active}
              className={cn("cursor-pointer truncate rounded-md px-2.5 py-1.5 text-sm", index === active ? "bg-brand/10 text-brand" : "hover:bg-slate-100")}
              onMouseDown={(event) => event.preventDefault()} // keep the focus in the box
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(option)}
            >
              {option}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
