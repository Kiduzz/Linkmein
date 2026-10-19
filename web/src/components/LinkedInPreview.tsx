import { useState } from "react";
import { mediaUrl, previewUrl, type Media } from "../api";
import { useApp } from "../context";
import { Avatar } from "../App";
import { LINKEDIN_FOLD } from "../../../shared/types";

/** Approximates how the post will look in the LinkedIn feed, including the "…see more" fold. */
export function LinkedInPreview({ text, media }: { text: string; media: Media[] }) {
  const { me } = useApp();
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && text.length > LINKEDIN_FOLD;
  const visible = folded ? cutAtFold(text) : text;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 p-4 pb-2">
        <Avatar name={me.user.name} picture={me.user.picture} size={44} />
        <div>
          <div className="text-sm font-semibold">{me.user.name}</div>
          <div className="text-xs text-slate-500">Now · 🌐</div>
        </div>
      </div>
      <div className="whitespace-pre-wrap px-4 pb-3 text-sm leading-relaxed">
        {text ? (
          <>
            {highlight(visible)}
            {folded && (
              <button className="text-slate-500 hover:underline" onClick={() => setExpanded(true)}>
                …see more
              </button>
            )}
          </>
        ) : (
          <span className="text-slate-400">Your post will appear here.</span>
        )}
      </div>
      {media.length > 0 && <MediaGrid media={media} />}
      {text && (
        <div className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
          {text.length > LINKEDIN_FOLD ? `The first ${LINKEDIN_FOLD} characters show before "see more". Make them count.` : "The whole post shows without \"see more\"."}
        </div>
      )}
    </div>
  );
}

function cutAtFold(text: string): string {
  // LinkedIn also folds after a few lines; approximate with the first 3 lines or 210 chars.
  const firstLines = text.split("\n").slice(0, 3).join("\n");
  const cut = firstLines.length < text.length && firstLines.length < LINKEDIN_FOLD ? firstLines : text.slice(0, LINKEDIN_FOLD);
  return cut.replace(/\s+\S*$/, "") + " ";
}

function highlight(text: string) {
  return text.split(/(#[\p{L}\p{N}]*\p{L}[\p{L}\p{N}]*)/u).map((part, i) =>
    part.startsWith("#") && i % 2 === 1 ? (
      <span key={i} className="font-medium text-brand-700">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function MediaGrid({ media }: { media: Media[] }) {
  const video = media.find((m) => m.kind === "video");
  if (video) return <video src={mediaUrl(video.id)} controls className="max-h-[480px] w-full bg-black" poster={video.hasPreview ? previewUrl(video.id) : undefined} />;
  const shown = media.slice(0, 4);
  return (
    <div className={`grid gap-0.5 ${shown.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
      {shown.map((m, i) => (
        <div key={m.id} className={`relative ${shown.length === 3 && i === 0 ? "col-span-2" : ""}`}>
          <img src={previewUrl(m.id)} alt={m.altText ?? ""} className={`w-full object-cover ${shown.length === 1 ? "max-h-[520px]" : "aspect-square"}`} />
          {i === 3 && media.length > 4 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-2xl font-semibold text-white">+{media.length - 4}</div>
          )}
        </div>
      ))}
    </div>
  );
}
