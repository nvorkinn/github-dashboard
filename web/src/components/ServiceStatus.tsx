import { useEffect, useRef, useState } from "preact/hooks";
import { componentTone, type ServiceTone, type StatusIncident, summaryTone } from "../../../shared/status.ts";
import { type ServiceStatusState, serviceStatus } from "../service_status.ts";
import { ExternalLink } from "./ExternalLink.tsx";

const LABELS: Record<ServiceTone, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Major outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
};
const SYMBOLS: Record<ServiceTone, string> = {
  operational: "✓",
  degraded: "!",
  outage: "!",
  maintenance: "◷",
  unknown: "?",
};
const words = (value: string) => value.replaceAll("_", " ");

export function useServiceStatus() {
  const [state, setState] = useState(serviceStatus.state);
  useEffect(() => {
    const stop = serviceStatus.subscribe(() => setState(serviceStatus.state()));
    setState(serviceStatus.state());
    return stop;
  }, []);
  return state;
}

function presentation(state: ServiceStatusState) {
  const tone = state.data ? summaryTone(state.data) : "unknown";
  const label = !state.data ? (state.loading ? "Checking…" : "Unavailable") : LABELS[tone];
  const affected =
    state.data?.components.filter((component) => componentTone(component.status) !== "operational").length ?? 0;
  return { tone, label, suffix: affected ? ` (${affected})` : "" };
}

/** A nonmodal header disclosure: outside clicks, Escape and leaving with Tab dismiss it. */
export function ServiceStatus({
  state,
  open,
  onOpen,
  onClose,
}: {
  state: ServiceStatusState;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { tone, label, suffix } = presentation(state);
  const control = useRef<HTMLFieldSetElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, onClose]);
  return (
    <fieldset
      ref={control}
      aria-label="GitHub service status"
      class="service-control"
      onFocusOut={(event) => {
        if (open && event.relatedTarget instanceof Node && !control.current?.contains(event.relatedTarget)) onClose();
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          onClose();
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        class={`service-pill service-${state.stale && state.data ? "unknown" : tone}`}
        aria-expanded={open}
        aria-controls="github-service-details"
        aria-haspopup="dialog"
        onClick={open ? onClose : onOpen}
      >
        <span class="service-symbol" aria-hidden="true">
          {SYMBOLS[tone]}
        </span>
        <span>
          <span class="service-prefix">GitHub: </span>
          {label}
          {suffix}
          {state.stale && state.data ? " · Stale" : ""}
        </span>
        <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open && (
        <section
          id="github-service-details"
          class="service-popover"
          role="dialog"
          aria-labelledby="github-service-heading"
        >
          <div class="service-heading">
            <h2 id="github-service-heading">GitHub Status</h2>
            <button
              ref={close}
              type="button"
              class="secondary"
              onClick={() => {
                onClose();
                trigger.current?.focus();
              }}
            >
              Close
            </button>
          </div>
          <div class={`service-banner service-${state.stale ? "unknown" : tone}`} role="status">
            <strong>
              <span aria-hidden="true">{SYMBOLS[tone]} </span>
              {label}
            </strong>
            {state.data && <p>{state.data.description}</p>}
            {!state.data && (
              <p>{state.loading ? "Checking GitHub service status…" : "GitHub status is currently unavailable."}</p>
            )}
          </div>
          {state.error && (
            <p class="problem" role="status">
              {state.error} {state.data ? "Showing the last successful check." : "We'll try again automatically."}
            </p>
          )}
          {state.stale && state.data && <p class="quiet">Status may have changed since the last successful check.</p>}
          {state.fetchedAt !== undefined && (
            <p class="quiet service-timestamp">
              Last successful check: <Timestamp at={new Date(state.fetchedAt).toISOString()} />
            </p>
          )}
          {state.data && (
            <>
              <h3>Service status</h3>
              <ul class="service-components">
                {state.data.components.map((component) => {
                  const componentState = componentTone(component.status);
                  return (
                    <li class="service-component" key={component.id}>
                      <span>{component.name}</span>
                      <span class={`service-label service-${componentState}`}>
                        <span aria-hidden="true">{SYMBOLS[componentState]} </span>
                        {words(component.status)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <h3>
                Active incidents <span class="count">{state.data.incidents.length}</span>
              </h3>
              {state.data.incidents.length === 0 ? (
                <p class="quiet">No active incidents{state.stale ? " at the last check" : ""}.</p>
              ) : (
                state.data.incidents.map((item) => <Incident key={item.id} item={item} />)
              )}
              {state.data.maintenance.length > 0 && (
                <>
                  <h3>Scheduled maintenance</h3>
                  {state.data.maintenance.map((item) => (
                    <Incident key={item.id} item={item} />
                  ))}
                </>
              )}
            </>
          )}
          <div class="service-footer">
            <ExternalLink href="https://www.githubstatus.com/">View on GitHub Status ↗</ExternalLink>
            <button
              type="button"
              class="secondary"
              disabled={state.loading}
              onClick={() => void serviceStatus.refresh()}
            >
              {state.loading ? "Refreshing…" : "Refresh status"}
            </button>
          </div>
        </section>
      )}
    </fieldset>
  );
}

function Timestamp({ at }: { at: string }) {
  return (
    <time dateTime={at}>{new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
  );
}
function Incident({ item }: { item: StatusIncident }) {
  return (
    <article class="service-incident">
      <ExternalLink class="service-incident-title" href={item.url}>
        {item.name}
      </ExternalLink>
      <p class="quiet">
        {words(item.status)}
        {item.scheduledFor && (
          <>
            {" "}
            · <Timestamp at={item.scheduledFor} />
          </>
        )}
        {item.scheduledUntil && (
          <>
            {" "}
            – <Timestamp at={item.scheduledUntil} />
          </>
        )}
      </p>
      {item.updates.map((update, index) =>
        index === 0 ? (
          <div key={update.id}>
            <p class="service-update">{update.body}</p>
            <p class="quiet service-timestamp">
              {words(update.status)} · <Timestamp at={update.at} />
            </p>
          </div>
        ) : null,
      )}
      {item.updates.length > 1 && (
        <details>
          <summary>Earlier updates ({item.updates.length - 1})</summary>
          {item.updates.slice(1).map((update) => (
            <div key={update.id}>
              <p class="service-update">{update.body}</p>
              <p class="quiet service-timestamp">
                {words(update.status)} · <Timestamp at={update.at} />
              </p>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}
