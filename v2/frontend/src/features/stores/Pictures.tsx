import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, ImageOff, Images, Plus, X } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { previewSrc } from "@/features/stores/details";

/** Pictures are links (STORE-MODEL §2 `image_url`, §4.1 a screen's `pictures`): a Google Drive or Dropbox link
 *  is shown through its thumbnail address, anything else as is. */

/** Previews of the picture links, shown a moment after typing stops. A link that is not an image (or not
 *  reachable) falls back to a plain link. */
export function ImagePreviews({ label, urls }: { label: string; urls: string[] }) {
  const key = urls.join(" ");
  const [shown, setShown] = useState(urls);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(urls), 400);
    return () => window.clearTimeout(timer);
  }, [key]); // the list is rebuilt on every render; its text is what changes
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${label} links`}>
        {shown.map((url, index) => (
          <li key={url}>
            <ImagePreview url={url} onOpen={() => setOpen(index)} />
          </li>
        ))}
      </ul>
      {open !== null && shown[open] && <Lightbox urls={shown} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

function ImagePreview({ url, onOpen }: { url: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border bg-slate-50 hover:border-brand">
      {failed ? (
        <a href={url} target="_blank" rel="noreferrer" className="flex h-40 flex-col items-center justify-center gap-1 p-3 text-center text-xs text-slate-500">
          <ImageOff size={18} /> No preview for this link. Open it
        </a>
      ) : (
        <button type="button" className="block w-full cursor-zoom-in" aria-label="Show picture full size" onClick={onOpen}>
          <img
            src={previewSrc(url)}
            alt="Store picture"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="h-48 w-full object-cover"
          />
        </button>
      )}
      <a href={url} target="_blank" rel="noreferrer" className="block truncate border-t px-2 py-1 text-xs text-brand hover:underline">
        {url}
      </a>
    </div>
  );
}

/** A picture filling the window it opens in (not a new tab): Esc or × closes it, arrows step through several. The store
 *  window's transform makes `fixed` cover the window itself rather than the whole screen. */
export function Lightbox({ urls, index, onIndex, onClose, noun = "Store picture" }: { urls: string[]; index: number; onIndex: (index: number) => void; onClose: () => void; /** What the picture is, for its label. */ noun?: string }) {
  const many = urls.length > 1;
  const step = (by: number) => onIndex((index + by + urls.length) % urls.length);
  useEffect(() => {
    // Capture on window, ahead of the dialog's own Esc handler, so Esc closes the picture and not the store.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (many && event.key === "ArrowRight") step(1);
      else if (many && event.key === "ArrowLeft") step(-1);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const url = urls[index]!;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={noun}
      className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 sm:rounded-lg"
      onClick={onClose}
    >
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-white/80" onClick={(event) => event.stopPropagation()}>
        {many && (
          <span className="font-mono text-xs">
            {index + 1} / {urls.length}
          </span>
        )}
        <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs hover:text-white">
          <ExternalLink size={13} /> Open original
        </a>
        <Button type="button" size="icon" variant="ghost" className="text-white hover:bg-white/10 hover:text-white" aria-label="Close picture" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-12 pb-6">
        <img
          src={previewSrc(url)}
          alt={`${noun}, full size`}
          referrerPolicy="no-referrer"
          className="max-h-full max-w-full object-contain"
          onClick={(event) => event.stopPropagation()}
        />
        {many && (
          <>
            <Button type="button" size="icon" variant="ghost" className="absolute left-2 text-white hover:bg-white/10 hover:text-white" aria-label="Previous picture" onClick={(event) => { event.stopPropagation(); step(-1); }}>
              <ChevronLeft />
            </Button>
            <Button type="button" size="icon" variant="ghost" className="absolute right-2 text-white hover:bg-white/10 hover:text-white" aria-label="Next picture" onClick={(event) => { event.stopPropagation(); step(1); }}>
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Mirrors domain/models.MAX_SCREEN_PICTURES. */
export const MAX_SCREEN_PICTURES = 20;

/** Why a typed link cannot be added to a screen's pictures ("" when it can). */
export function pictureLinkProblem(link: string, pictures: readonly string[]): string {
  const value = link.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return "Paste a link that starts with http:// or https://";
  if (pictures.includes(value)) return "This picture is already on the screen";
  if (pictures.length >= MAX_SCREEN_PICTURES) return `A screen holds up to ${MAX_SCREEN_PICTURES} pictures`;
  return "";
}

function Thumb({ url, label, onOpen }: { url: string; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <a href={url} target="_blank" rel="noreferrer" aria-label={`${label} (no preview, opens the link)`} className="flex size-full flex-col items-center justify-center gap-1 p-1 text-center text-[10px] leading-tight text-slate-500 hover:text-brand">
      <ImageOff size={16} /> Open link
    </a>
  ) : (
    <button type="button" className="block size-full cursor-zoom-in" aria-label={label} onClick={onOpen}>
      <img src={previewSrc(url)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-cover" />
    </button>
  );
}

/** One screen's pictures as thumbnails: click one to see it large. With `onChange` a link can be pasted in (as the
 *  store's own Pictures: the photo lives in Drive or Dropbox, the screen keeps its link) and one removed after a
 *  confirm. The list is part of the screen's draft: it is saved with the screen. */
export function ScreenPictures({ pictures, screen, onChange }: { pictures: string[]; /** The screen's number, for labels. */ screen: number; onChange?: (pictures: string[]) => void }) {
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const add = () => {
    const why = pictureLinkProblem(link, pictures);
    if (why) return setProblem(why);
    onChange?.([...pictures, link.trim()]);
    setLink("");
    setProblem("");
  };
  return (
    <div className="space-y-2.5">
      {pictures.length === 0 ? (
        <p className="text-xs text-slate-500">No pictures of this screen yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={`Pictures of screen ${screen}`}>
          {pictures.map((url, index) => (
            <li key={url} className="group relative size-20 overflow-hidden rounded-md border bg-slate-50 shadow-xs transition-colors hover:border-brand">
              <Thumb url={url} label={`Show picture ${index + 1} of screen ${screen}`} onOpen={() => setOpen(index)} />
              {onChange && (
                <button
                  type="button"
                  aria-label={`Remove picture ${index + 1} of screen ${screen}`}
                  onClick={() => setRemoving(index)}
                  className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-white/90 text-slate-600 shadow-sm ring-1 ring-slate-900/10 hover:bg-white hover:text-rose-700 focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <X size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {onChange && (
        <div className="space-y-1">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input
              inputMode="url"
              aria-label={`Picture link for screen ${screen}`}
              aria-invalid={problem ? true : undefined}
              placeholder="Paste a picture link (Google Drive, Dropbox…)"
              value={link}
              onChange={(event) => {
                setLink(event.target.value);
                setProblem("");
              }}
              className="h-8 min-w-0 flex-1 basis-56"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!link.trim()}>
              <Plus /> Add picture
            </Button>
          </form>
          {problem ? <p className="text-xs text-rose-700">{problem}</p> : <p className="text-[11px] text-slate-500">Upload the photo to Drive first, then paste its share link.</p>}
        </div>
      )}
      {open !== null && pictures[open] && <Lightbox urls={pictures} index={open} onIndex={setOpen} onClose={() => setOpen(null)} noun={`Picture of screen ${screen}`} />}
      <ConfirmDialog
        open={removing !== null}
        title="Remove this picture?"
        confirmLabel="Remove picture"
        onConfirm={() => {
          if (removing !== null) onChange?.(pictures.filter((_, index) => index !== removing));
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      >
        It comes off screen {screen} when the screen is saved. The photo itself stays where it is stored.
      </ConfirmDialog>
    </div>
  );
}

/** A screen's pictures in the store window's screen list: how many, and the thumbnails a click away. */
export function ScreenPictureCount({ pictures, screen }: { pictures: string[]; screen: number }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!pictures.length) return <span className="text-slate-300">—</span>;
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={`Pictures of screen ${screen}: ${pictures.length}`} className="inline-flex items-center gap-1 rounded px-1 text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-4 hover:text-brand">
            <Images size={13} className="text-slate-400" /> {pictures.length}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-auto max-w-80 p-2">
          <ul className="flex flex-wrap gap-1.5" aria-label={`Pictures of screen ${screen}`}>
            {pictures.map((url, index) => (
              <li key={url} className="size-16 overflow-hidden rounded border bg-slate-50 hover:border-brand">
                <Thumb url={url} label={`Show picture ${index + 1} of screen ${screen}`} onOpen={() => setOpen(index)} />
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
      {open !== null && pictures[open] && <Lightbox urls={pictures} index={open} onIndex={setOpen} onClose={() => setOpen(null)} noun={`Picture of screen ${screen}`} />}
    </>
  );
}
