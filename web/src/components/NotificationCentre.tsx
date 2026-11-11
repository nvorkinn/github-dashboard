import { useEffect, useRef, useState } from "preact/hooks";
import type { Notice } from "../model.ts";
import { NOTICE_LABELS } from "../notifications.ts";
import { ExternalLink } from "./ExternalLink.tsx";
import { Icon } from "./Icon.tsx";

const CENTRE_ID = "notification-centre";
const HEADING_ID = "notification-centre-heading";

/**
 * A controlled header disclosure that keeps a session's GitHub notices in the page. Notices become read while the
 * centre is open; ones arriving after it closes raise the unread count on its trigger.
 */
export function NotificationCentre({
  notices,
  open,
  onOpen,
  onClose,
  onClear,
}: {
  notices: Notice[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onClear: () => void;
}) {
  const [read, setRead] = useState<ReadonlySet<string>>(() => new Set());
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const centre = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const noticeKeys = notices.map((notice) => notice.key).join("\0");
  const unread = notices.filter((notice) => !read.has(notice.key)).length;

  useEffect(() => {
    if (!open) {
      return;
    }
    setRead((previous) => {
      const next = new Set(previous);
      for (const notice of notices) {
        next.add(notice.key);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [open, noticeKeys, notices]);

  useEffect(() => {
    if (open) {
      close.current?.focus();
    } else if (wasOpen.current) {
      trigger.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <div class="notification-control">
      <button
        ref={trigger}
        type="button"
        class="notification-trigger"
        aria-expanded={open}
        aria-controls={CENTRE_ID}
        aria-label={`Notifications, ${unread} unread`}
        onClick={open ? onClose : onOpen}
      >
        <Icon name="notification" />
        <span class="visually-hidden">Notifications</span>
        {unread > 0 && <span class="notification-unread">{unread}</span>}
      </button>

      {open && (
        <section
          ref={centre}
          id={CENTRE_ID}
          class="notification-centre"
          role="dialog"
          aria-modal="true"
          aria-labelledby={HEADING_ID}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "Tab") {
              const focusable = [
                ...(centre.current?.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ?? []),
              ];
              const first = focusable[0];
              const last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first && last) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last && first) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <div class="notification-centre-head">
            <h2 id={HEADING_ID}>
              Notifications <span class="count">{notices.length}</span>
            </h2>
            <button ref={close} type="button" class="secondary" onClick={onClose}>
              Close
            </button>
          </div>

          {notices.length === 0 ? (
            <p class="empty">No notifications yet.</p>
          ) : (
            <>
              <ul class="notification-list">
                {notices.map((notice) => (
                  <li key={notice.key} class={`notification-item notification-${notice.type}`}>
                    <span class="notification-type">{NOTICE_LABELS[notice.type].title}</span>
                    <span class="notification-repo">{notice.repo}</span>
                    {notice.url ? (
                      <ExternalLink class="notification-headline" href={notice.url}>
                        {notice.headline}
                      </ExternalLink>
                    ) : (
                      <span class="notification-headline">{notice.headline}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div class="notification-centre-foot">
                <button type="button" class="secondary" onClick={onClear}>
                  Clear notifications
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
