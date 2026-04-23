"use client";

import { FormEvent, useMemo, useState } from "react";
import { toast } from "sonner";

type PreparePostResult = {
  cid: string;
  tag: string;
  text: string;
  toxicityScore: number;
};

type CreatePostModalProps = {
  onPostPrepared?: (result: PreparePostResult) => void;
};

const TAG_OPTIONS = ["General", "Governance", "Research", "Security", "Announcements"];

export function CreatePostModal({ onPostPrepared }: CreatePostModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [content, setContent] = useState("");
  const [tag, setTag] = useState(TAG_OPTIONS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const remainingChars = useMemo(() => 600 - content.length, [content.length]);

  const closeModal = () => {
    if (isSubmitting) return;
    setIsOpen(false);
  };

  const submitPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = content.trim();
    if (!trimmed) {
      toast.error("Write something before submitting.");
      return;
    }

    if (trimmed.length > 600) {
      toast.error("Post exceeds 600 character limit.");
      return;
    }

    setIsSubmitting(true);

    try {
      const perspectiveResponse = await fetch("/api/perspective", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed }),
      });

      const perspectiveData = (await perspectiveResponse.json()) as {
        error?: string;
        toxicityScore?: number;
        isToxic?: boolean;
      };

      if (!perspectiveResponse.ok) {
        throw new Error(perspectiveData.error ?? "Perspective moderation failed.");
      }

      if (perspectiveData.isToxic) {
        const score = (perspectiveData.toxicityScore ?? 0).toFixed(2);
        toast.error(`Post rejected by toxicity filter (score: ${score}).`);
        return;
      }

      const pinataResponse = await fetch("/api/pinata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: trimmed, tag }),
      });

      const pinataData = (await pinataResponse.json()) as {
        error?: string;
        cid?: string;
      };

      if (!pinataResponse.ok || !pinataData.cid) {
        throw new Error(pinataData.error ?? "Pinata upload failed.");
      }

      onPostPrepared?.({
        cid: pinataData.cid,
        tag,
        text: trimmed,
        toxicityScore: perspectiveData.toxicityScore ?? 0,
      });

      toast.success("Post prepared and uploaded to IPFS. Ready for on-chain publish in Phase 4.");
      setContent("");
      setTag(TAG_OPTIONS[0]);
      setIsOpen(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while preparing post.";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center justify-center rounded-xl border border-emerald-400/35 bg-emerald-400/15 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-400/25"
      >
        Create Post
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center px-4">
          <button
            type="button"
            aria-label="Close modal"
            onClick={closeModal}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />

          <div className="relative z-10 w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/95 p-5 shadow-[0_24px_90px_rgba(0,0,0,0.6)] sm:p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-zinc-100">Prepare a post</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Content is screened off-chain, then pinned to IPFS before any on-chain action.
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                Close
              </button>
            </div>

            <form className="space-y-4" onSubmit={submitPost}>
              <label className="block space-y-2">
                <span className="text-sm font-medium text-zinc-200">Post Content</span>
                <textarea
                  rows={7}
                  value={content}
                  maxLength={600}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Share a thought worth defending..."
                  className="w-full rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                  disabled={isSubmitting}
                />
                <span className={`text-xs ${remainingChars < 80 ? "text-amber-300" : "text-zinc-500"}`}>
                  {remainingChars} characters remaining
                </span>
              </label>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-zinc-200">Tag</span>
                <select
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  disabled={isSubmitting}
                  className="w-full rounded-xl border border-zinc-700/90 bg-zinc-950/90 px-3 py-2.5 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/60"
                >
                  {TAG_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:bg-emerald-300/70"
              >
                {isSubmitting ? (
                  <>
                    <svg
                      aria-hidden="true"
                      className="h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-30" />
                      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" />
                    </svg>
                    Preparing Post...
                  </>
                ) : (
                  "Screen & Upload to IPFS"
                )}
              </button>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
