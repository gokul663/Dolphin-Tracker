import { useState } from "react";
import { ArrowLeftRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isDdCode,
  looksSwapped,
  oddCodeScreens,
  screensPreview,
  swapScreen,
  swappedScreens,
  type ReviewRow,
} from "@/features/imports/model";
import { splitCodes } from "@/lib/codes";
import { cn } from "@/lib/utils";

type Screens = ReviewRow["screens"];

/** A row's screens in the review table: the one-line summary, what looks wrong with them (a DD code that is not
 *  DD-ABCDEF, a stick number and DD code in each other's column), and an editor for the stick number and DD code of
 *  each screen. */
export function ScreensCell({ row, onChange }: { row: ReviewRow; onChange: (screens: Screens) => void }) {
  const [editing, setEditing] = useState(false);
  const number = row.index + 1;
  const odd = oddCodeScreens(row);
  const swapped = swappedScreens(row);
  const set = (index: number, change: Partial<Screens[number]>) =>
    onChange(row.screens.map((screen, at) => (at === index ? { ...screen, ...change } : screen)));
  return (
    <>
      <div aria-label={`Screens, row ${number}`}>{screensPreview(row)}</div>
      {!row.excluded && swapped.length > 0 && (
        <div className="mt-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-1 text-[11px] text-amber-900" role="note">
          Stick number and DD code look swapped
          <Button
            size="xs"
            variant="outline"
            className="ml-1.5"
            aria-label={`Swap stick number and DD code, row ${number}`}
            onClick={() => onChange(row.screens.map((screen) => (looksSwapped(screen) ? swapScreen(screen) : screen)))}
          >
            <ArrowLeftRight /> Swap
          </Button>
        </div>
      )}
      {!row.excluded && odd.length > 0 && (
        <p className="mt-1 text-[11px] text-amber-800" aria-label={`DD code format, row ${number}`}>
          Not in the DD-ABCDEF format: <span className="font-mono">{odd.map((screen) => screen.venue_id).join(", ")}</span>
        </p>
      )}
      {!row.excluded && (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1 h-6 px-1.5 text-[11px] text-slate-600"
          aria-label={`Edit screens, row ${number}`}
          aria-expanded={editing}
          onClick={() => setEditing((open) => !open)}
        >
          <Pencil /> {editing ? "Done" : "Edit"}
        </Button>
      )}
      {editing && !row.excluded && (
        <ul className="mt-1 space-y-1" aria-label={`Screen rows, row ${number}`}>
          {row.screens.map((screen, index) => {
            const packed = splitCodes(screen.venue_id).length > 1;
            const bad = Boolean(screen.venue_id.trim()) && (packed || !isDdCode(screen.venue_id));
            return (
              <li key={index} className="flex items-center gap-1">
                <Input
                  aria-label={`Stick number ${index + 1}, row ${number}`}
                  value={screen.stick_number}
                  placeholder="Stick #"
                  onChange={(event) => set(index, { stick_number: event.target.value })}
                  className="h-7 w-28 px-1.5 font-mono text-[11px]"
                />
                <Input
                  aria-label={`DD code ${index + 1}, row ${number}`}
                  value={screen.venue_id}
                  placeholder="DD-ABCDEF"
                  aria-invalid={bad}
                  title={bad ? (packed ? "Several codes in one entry" : "Not in the DD-ABCDEF format") : undefined}
                  onChange={(event) => set(index, { venue_id: event.target.value })}
                  className={cn("h-7 w-28 px-1.5 font-mono text-[11px]", bad && "border-amber-400 bg-amber-50")}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Swap stick number and DD code of screen ${index + 1}, row ${number}`}
                  title="Swap the stick number and the DD code"
                  onClick={() => set(index, swapScreen(screen))}
                >
                  <ArrowLeftRight />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Remove screen ${index + 1}, row ${number}`}
                  disabled={row.screens.length === 1}
                  onClick={() => onChange(row.screens.filter((_, at) => at !== index))}
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
          <li>
            <Button
              size="xs"
              variant="outline"
              aria-label={`Add a screen, row ${number}`}
              onClick={() => onChange([...row.screens, { stick_number: "", venue_id: "", status: row.venue_status }])}
            >
              <Plus /> Add screen
            </Button>
          </li>
        </ul>
      )}
    </>
  );
}
