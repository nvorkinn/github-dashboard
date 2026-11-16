import { useEffect, useRef } from "preact/hooks";
import type { ReviewInfo } from "../github/review.ts";
import type { PullRequest } from "../model.ts";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import "./PullInfo.css";

/** The PR's description, checks and reviews, in a popup over the review: read once, then out of the code's way. */
export function PullInfo({
  pull,
  info,
  status,
  onClose,
}: {
  pull: PullRequest;
  info: ReviewInfo | undefined;
  /** Said in place of the information while it is not loaded. */
  status: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click is only the backdrop's; Escape is its keyboard way out.
    <dialog
      ref={dialog}
      class="pull-info"
      aria-labelledby="pull-info-title"
      onCancel={(event) => {
        // Escape closes this popup only, not the review beneath it.
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog itself.
        if (event.target === dialog.current) onClose();
      }}
    >
      <header class="pull-info-header">
        <div>
          <p>
            {pull.repo} #{pull.number}
          </p>
          <h3 id="pull-info-title">{pull.title}</h3>
        </div>
        <button class="pull-info-close" type="button" onClick={onClose} aria-label="Close PR information">
          ×
        </button>
      </header>
      <div class="pull-info-body">
        {info ? (
          <>
            <section aria-label="Description">
              {info.description.trim() ? (
                <Markdown class="pull-info-description" text={info.description} base={pull.url} />
              ) : (
                <p class="pull-info-empty">No description.</p>
              )}
            </section>
            <section aria-labelledby="pull-info-checks">
              <h4 id="pull-info-checks">Checks ({pull.checks.length})</h4>
              {pull.checks.length ? (
                <ul class="pull-info-list">
                  {pull.checks.map((check, i) => (
                    <li key={`${check.name}-${i}`}>
                      <Icon name={check.state === "passed" ? "check" : "attention"} size={14} />
                      <span>{check.name}</span>
                      <span class={`pull-info-state pull-info-state-${check.state}`}>{check.state}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="pull-info-empty">No checks.</p>
              )}
            </section>
            <section aria-labelledby="pull-info-reviews">
              <h4 id="pull-info-reviews">Reviews ({info.reviews.length})</h4>
              {info.reviews.length ? (
                <ul class="pull-info-list pull-info-reviews">
                  {info.reviews.map((review, i) => (
                    <li key={i}>
                      <div>
                        <strong>{review.user?.login ?? "Deleted user"}</strong>
                        <span class="pull-info-state">{review.state.toLowerCase().replaceAll("_", " ")}</span>
                      </div>
                      {review.body?.trim() && <Markdown text={review.body} base={pull.url} />}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="pull-info-empty">No reviews.</p>
              )}
            </section>
          </>
        ) : (
          <p class="pull-info-empty">{status}</p>
        )}
      </div>
    </dialog>
  );
}
