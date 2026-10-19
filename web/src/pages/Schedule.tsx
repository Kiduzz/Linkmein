import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, previewUrl, type Post } from "../api";
import { useMediaLibrary } from "../hooks";
import { PostEditor } from "../components/PostEditor";
import { ErrorText, formatWhen, Modal, PageHeader, StatusChip } from "../components/ui";

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function SchedulePage() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { media } = useMediaLibrary();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const list = await api.posts();
    setPosts(list);
    if (timer.current) clearTimeout(timer.current);
    // Keep the page live while something is publishing or about to be.
    const soon = list.some((p) => p.status === "publishing" || (p.status === "scheduled" && (p.scheduledAt ?? 0) - Date.now() < 120_000));
    timer.current = setTimeout(load, soon ? 4000 : 30_000);
  }, []);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!posts) return <p className="text-slate-500">Loading…</p>;

  const scheduled = posts.filter((p) => p.status === "scheduled" || p.status === "publishing").sort((a, b) => (a.scheduledAt ?? 0) - (b.scheduledAt ?? 0));
  const drafts = posts.filter((p) => p.status === "draft");
  const failed = posts.filter((p) => p.status === "failed");
  const published = posts.filter((p) => p.status === "published").sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));

  const groups = new Map<string, Post[]>();
  for (const p of scheduled) {
    const key = p.scheduledAt ? dayLabel(p.scheduledAt) : "Now";
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }

  const card = (p: Post) => (
    <PostCard
      key={p.id}
      post={p}
      onEdit={() => setEditing(p)}
      onPublish={() => window.confirm("Publish this post to LinkedIn now?") && act(() => api.publishPost(p.id))}
      onDelete={() => window.confirm("Delete this post?") && act(() => api.deletePost(p.id))}
    />
  );

  return (
    <div className="space-y-8">
      <PageHeader title="Schedule" subtitle="Your queue, drafts and everything you've published.">
        <Link to="/" className="btn-primary">
          + New post
        </Link>
      </PageHeader>
      <ErrorText error={error} />

      {failed.length > 0 && (
        <Section title="Needs attention">
          <div className="space-y-3">{failed.map(card)}</div>
        </Section>
      )}

      <Section title="Coming up">
        {scheduled.length === 0 ? (
          <Empty>Nothing scheduled. Create a post and pick a time.</Empty>
        ) : (
          <div className="space-y-6">
            {[...groups].map(([day, list]) => (
              <div key={day}>
                <h3 className="mb-2 text-sm font-medium text-slate-500">{day}</h3>
                <div className="space-y-3">{list.map(card)}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Drafts">{drafts.length ? <div className="space-y-3">{drafts.map(card)}</div> : <Empty>No drafts.</Empty>}</Section>

      <Section title="Published">{published.length ? <div className="space-y-3">{published.map(card)}</div> : <Empty>Nothing published yet.</Empty>}</Section>

      {editing && (
        <Modal title="Edit post" onClose={() => setEditing(null)} wide>
          <PostEditor
            initial={{ text: editing.text, mediaIds: editing.mediaIds, visibility: editing.visibility, scheduledAt: editing.scheduledAt }}
            library={media}
            postId={editing.id}
            onSaved={() => {
              setEditing(null);
              void load();
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</p>;
}

function PostCard({ post, onEdit, onPublish, onDelete }: { post: Post; onEdit: () => void; onPublish: () => void; onDelete: () => void }) {
  const editable = ["draft", "scheduled", "failed"].includes(post.status);
  return (
    <div className="card flex gap-4 p-4">
      {post.mediaIds.length > 0 && (
        <img src={previewUrl(post.mediaIds[0])} alt="" className="h-20 w-20 shrink-0 rounded-lg border object-cover" onError={(e) => (e.currentTarget.style.display = "none")} />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <StatusChip status={post.status} />
          {post.status === "scheduled" && post.scheduledAt && <span>{formatWhen(post.scheduledAt)}</span>}
          {post.status === "published" && post.publishedAt && <span>{formatWhen(post.publishedAt)}</span>}
          {post.mediaIds.length > 0 && <span>· {post.mediaIds.length} attachment{post.mediaIds.length > 1 ? "s" : ""}</span>}
          {post.visibility === "CONNECTIONS" && <span>· connections only</span>}
          {post.source === "remix" && <span>· remix</span>}
        </div>
        <p className="line-clamp-3 whitespace-pre-wrap text-sm">{post.text}</p>
        {post.lastError && <p className="mt-2 text-xs text-red-600">{post.lastError}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        {post.url && (
          <a className="btn-secondary px-3 py-1 text-xs" href={post.url} target="_blank" rel="noreferrer">
            View on LinkedIn
          </a>
        )}
        {editable && (
          <>
            <button className="btn-secondary px-3 py-1 text-xs" onClick={onEdit}>
              Edit
            </button>
            <button className="btn-ghost px-3 py-1 text-xs" onClick={onPublish}>
              {post.status === "failed" ? "Retry now" : "Post now"}
            </button>
          </>
        )}
        {post.status !== "publishing" && (
          <button className="btn-danger px-3 py-1 text-xs" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
