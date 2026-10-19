import { Link } from "react-router-dom";
import type { Post } from "../api";
import { formatWhen } from "./ui";

export function SavedNotice({ post, onAnother }: { post: Post; onAnother: () => void }) {
  const message =
    post.status === "scheduled"
      ? `Scheduled for ${formatWhen(post.scheduledAt!)}.`
      : post.status === "publishing"
        ? "Publishing to LinkedIn now. Videos can take a few minutes."
        : post.status === "published"
          ? "Published to LinkedIn."
          : "Saved as a draft.";
  return (
    <div className="card flex flex-wrap items-center justify-between gap-4 border-emerald-200 bg-emerald-50 p-5">
      <div>
        <p className="font-medium text-emerald-900">✓ {message}</p>
        <p className="text-sm text-emerald-800">You can edit or reschedule it from the Schedule page.</p>
      </div>
      <div className="flex gap-2">
        <Link to="/schedule" className="btn-secondary">
          Open schedule
        </Link>
        <button className="btn-primary" onClick={onAnother}>
          Create another
        </button>
      </div>
    </div>
  );
}
